using System.Data.Common;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using Npgsql;
using Teas.Domain;

namespace Teas.App.Platform.Concurrency;

/// <summary>Raw commands on the command's own transaction (the one whose first statement set the RLS GUCs).</summary>
internal static class TxSql
{
    public static NpgsqlCommand Cmd(DbContext db, string sql, params NpgsqlParameter[] ps)
    {
        var tx = (NpgsqlTransaction)(db.Database.CurrentTransaction?.GetDbTransaction()
            ?? throw new InvalidOperationException("this must run inside the command's transaction (db.Database.BeginTransactionAsync), or no RLS context is set"));
        var cmd = new NpgsqlCommand(sql, tx.Connection, tx);
        cmd.Parameters.AddRange(ps);
        return cmd;
    }

    public static NpgsqlParameter P<T>(string name, T value) => new NpgsqlParameter<T>(name, value);
}

/// <summary>
/// SP3 4.7 Concurrency (B-2): <c>UPDATE ... SET ..., version = version + 1 WHERE id = @id AND version = @expected</c>.
/// Zero rows: the row is invisible / absent (RLS makes another company's row absent) -> 404 record.not_found, else 409 record.version_conflict.
/// The predicate is evaluated again after waiting on a concurrent writer's row lock (READ COMMITTED), so the loser of a race gets 0 rows.
/// </summary>
public static partial class VersionedUpdate
{
    [GeneratedRegex("^[a-z_]+$")] private static partial Regex TableName();

    /// <param name="table">Constant table name in schema teas (never user input).</param>
    /// <param name="setSql">Constant SET list, e.g. <c>name = @name</c>; its values come in <paramref name="parameters"/>.</param>
    /// <returns>The new version.</returns>
    public static async Task<int> UpdateAsync(DbContext db, string table, string setSql, Guid id, int expectedVersion, params NpgsqlParameter[] parameters)
    {
        if (!TableName().IsMatch(table)) throw new ArgumentException("table must be a constant identifier", nameof(table));
        await using (var cmd = TxSql.Cmd(db, $"UPDATE teas.{table} SET {setSql}, version = version + 1 WHERE id = @_id AND version = @_v RETURNING version",
            [.. parameters, TxSql.P("_id", id), TxSql.P("_v", expectedVersion)]))
        {
            if (await cmd.ExecuteScalarAsync() is int version) return version;
        }
        // FOR UPDATE: Postgres then applies the UPDATE policy's USING too, so a row the user may see (companies / company_members SELECT
        // policies are wider) but may not update answers 404, not 409.
        await using var probe = TxSql.Cmd(db, $"SELECT 1 FROM teas.{table} WHERE id = @_id FOR UPDATE", TxSql.P("_id", id));
        throw new TeasException(await probe.ExecuteScalarAsync() is null ? "record.not_found" : "record.version_conflict");
    }
}
