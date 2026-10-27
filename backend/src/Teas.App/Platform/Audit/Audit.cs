using System.Diagnostics;
using System.Net;
using System.Text.Json;
using NpgsqlTypes;
using Npgsql;
using Teas.App.Platform.Concurrency;

namespace Teas.App.Platform.Audit;

public sealed record AuditActor(string Kind, string Id, string Name, string? OwnerId = null, string? OwnerName = null);

/// <summary>Per-request facts the audit row needs besides the command itself; the request pipeline fills it.</summary>
public sealed class AuditContext
{
    public AuditActor? Actor { get; set; }
    public string Client { get; set; } = "web";   // web | mcp | api
    public IPAddress? Ip { get; set; }
    public Guid? IdempotencyKey { get; set; }
}

/// <summary>SP3 4.7 Audit (S14). before / after never carry secrets, hashes, images or links: the caller passes already-redacted values.</summary>
public interface IAudit
{
    /// <summary>An 'ok' row in the command's own transaction (a rolled-back command leaves none).</summary>
    Task RecordAsync(string command, string target, object? before, object? after, CancellationToken ct = default);

    /// <summary>A refused 403 (auth.forbidden, agent.*): a 'rejected' row in its own short transaction, no before / after. Call it outside any command transaction.</summary>
    Task RecordRejectedAsync(string command, string target, CancellationToken ct = default);
}

public sealed class AuditWriter(TeasDbContext db, TenantScope scope, AuditContext ctx) : IAudit
{
    public Task RecordAsync(string command, string target, object? before, object? after, CancellationToken ct = default) =>
        InsertAsync("ok", command, target, before, after, ct);

    public async Task RecordRejectedAsync(string command, string target, CancellationToken ct = default)
    {
        if (db.Database.CurrentTransaction is not null)
            throw new InvalidOperationException("a rejected row is written outside the command's transaction, or it would roll back with it");
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        await InsertAsync("rejected", command, target, null, null, ct);
        await tx.CommitAsync(ct);
    }

    async Task InsertAsync(string result, string command, string target, object? before, object? after, CancellationToken ct)
    {
        var company = scope.Current.CompanyId ?? throw new InvalidOperationException("audit needs a company scope (TenantScope.Enter)");
        var actor = ctx.Actor ?? throw new InvalidOperationException("audit needs AuditContext.Actor");
        await using var cmd = TxSql.Cmd(db, """
            INSERT INTO teas.audit_log (company_id, actor_kind, actor_id, actor_name, owner_id, owner_name, command, target, before, after, result, ip, trace_id, client, idempotency_key)
            VALUES (@company, @kind, @aid, @aname, @oid, @oname, @command, @target, @before::jsonb, @after::jsonb, @result, @ip, @trace, @client, @idem)
            """,
            TxSql.P("company", company), Text("kind", actor.Kind), Text("aid", actor.Id), Text("aname", actor.Name),
            Text("oid", actor.OwnerId), Text("oname", actor.OwnerName), Text("command", command), Text("target", target),
            Text("before", before is null ? null : JsonSerializer.Serialize(before, JsonSerializerOptions.Web)),
            Text("after", after is null ? null : JsonSerializer.Serialize(after, JsonSerializerOptions.Web)),
            Text("result", result), new NpgsqlParameter("ip", NpgsqlDbType.Inet) { Value = (object?)ctx.Ip ?? DBNull.Value },
            Text("trace", Activity.Current?.TraceId.ToString()), Text("client", ctx.Client), Text("idem", ctx.IdempotencyKey?.ToString()));
        await cmd.ExecuteNonQueryAsync(ct);
    }

    static NpgsqlParameter Text(string name, string? value) => new(name, NpgsqlDbType.Text) { Value = (object?)value ?? DBNull.Value };
}
