using System.Security.Cryptography;
using System.Text;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using NpgsqlTypes;
using Teas.App.Platform.Audit;
using Teas.App.Platform.Concurrency;
using Teas.Domain;

namespace Teas.App.Platform.Idempotency;

/// <summary>What a command answers and what a replay returns: a status and a JSON body.</summary>
public sealed record StoredResponse(int Status, string Body);

public static class Idempotency
{
    /// <summary>The Idempotency-Key header: a UUID; missing or malformed -> 400 idempotency.key_required.</summary>
    public static Guid ParseKey(string? header) =>
        Guid.TryParse(header?.Trim(), out var key) && key != Guid.Empty ? key : throw new TeasException("idempotency.key_required");

    /// <summary>SHA-256 (hex) of the route and the raw body: the same key must come with the same request.</summary>
    public static string Hash(string route, ReadOnlySpan<byte> body)
    {
        using var h = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        h.AppendData(Encoding.UTF8.GetBytes(route));
        h.AppendData([0]);
        h.AppendData(body);
        return Convert.ToHexString(h.GetHashAndReset());
    }
}

/// <summary>
/// SP3 4.7 Idempotency. Call after <c>TenantScope.Enter</c>: it owns the command transaction. The first statement is the claim
/// (<c>INSERT ... ON CONFLICT DO NOTHING</c>); a concurrent duplicate blocks on the unique index until the first commits, then reads
/// 0 rows inserted and replays. On success the row gets the response in the same transaction; on any exception the whole transaction,
/// claim and audit rows included, rolls back, so a failed attempt consumes no key.
/// </summary>
public sealed class IdempotencyRunner(TeasDbContext db, TenantScope scope, AuditContext audit)
{
    public async Task<StoredResponse> RunAsync(Guid key, string route, string requestHash, Func<CancellationToken, Task<StoredResponse>> command, CancellationToken ct = default)
    {
        if (scope.Current.CompanyId is not { } company || scope.Current.UserId is not { } actor)
            throw new InvalidOperationException("idempotency needs TenantScope.Enter(company, user)");
        audit.IdempotencyKey = key;
        await using var tx = await db.Database.BeginTransactionAsync(ct);

        await using (var claim = TxSql.Cmd(db, """
            INSERT INTO teas.idempotency_records (company_id, actor_id, key, route, request_hash, status_code)
            VALUES (@c, @a, @k, @route, @hash, 0) ON CONFLICT DO NOTHING
            """, TxSql.P("c", company), TxSql.P("a", actor), TxSql.P("k", key), TxSql.P("route", route), TxSql.P("hash", requestHash)))
        {
            if (await claim.ExecuteNonQueryAsync(ct) == 0) return await ReplayAsync(company, actor, key, requestHash, ct);
        }

        var result = await command(ct);
        await using var done = TxSql.Cmd(db, """
            UPDATE teas.idempotency_records SET status_code = @s, response = @r::jsonb
            WHERE company_id = @c AND actor_id = @a AND key = @k RETURNING response::text
            """, TxSql.P("s", result.Status), new NpgsqlParameter("r", NpgsqlDbType.Text) { Value = result.Body },
            TxSql.P("c", company), TxSql.P("a", actor), TxSql.P("k", key));
        var stored = (string)(await done.ExecuteScalarAsync(ct))!;   // first answer and replay both come from the stored jsonb: byte-identical
        await tx.CommitAsync(ct);
        return new StoredResponse(result.Status, stored);
    }

    async Task<StoredResponse> ReplayAsync(Guid company, Guid actor, Guid key, string requestHash, CancellationToken ct)
    {
        await using var read = TxSql.Cmd(db, """
            SELECT request_hash, status_code, response::text FROM teas.idempotency_records WHERE company_id = @c AND actor_id = @a AND key = @k
            """, TxSql.P("c", company), TxSql.P("a", actor), TxSql.P("k", key));
        await using var r = await read.ExecuteReaderAsync(ct);
        if (!await r.ReadAsync(ct)) throw new InvalidOperationException("idempotency claim conflicted but the row is not visible");
        if (r.GetString(0) != requestHash) throw new TeasException("idempotency.key_reused");
        if (r.GetInt32(1) == 0 || r.IsDBNull(2)) throw new InvalidOperationException("idempotency row committed without a response");
        return new StoredResponse(r.GetInt32(1), r.GetString(2));
    }
}
