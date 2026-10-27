using Teas.App.Platform.Concurrency;

namespace Teas.App.Platform.Jobs;

/// <summary>SP3 4.3 "Idempotency cleanup job": deletes claims older than 7 days across all companies under <c>EnterSystem("idem-cleanup")</c>
/// (the policy's USING allows system scope; DELETE has no WITH CHECK).</summary>
public sealed class IdempotencyCleanupJob(TeasDbContext db, TenantScope scope, TimeProvider clock)
{
    public static readonly TimeSpan Retention = TimeSpan.FromDays(7);

    /// <returns>The number of rows deleted.</returns>
    public async Task<int> RunAsync(CancellationToken ct = default)
    {
        using var _ = scope.EnterSystem("idem-cleanup");
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        await using var cmd = TxSql.Cmd(db, "DELETE FROM teas.idempotency_records WHERE created_at < @cutoff", TxSql.P("cutoff", clock.GetUtcNow() - Retention));
        var deleted = await cmd.ExecuteNonQueryAsync(ct);
        await tx.CommitAsync(ct);
        return deleted;
    }
}
