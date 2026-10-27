using Teas.App.Platform.Jobs;

namespace Teas.Api.Startup;

/// <summary>Polls the job runner every 30 s (SP3 4.7). A tick that throws is logged and retried on the next one.</summary>
public sealed class JobRunnerService(JobRunner runner, ILogger<JobRunnerService> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(30));
        do
        {
            try { await runner.TickAsync(ct); }
            catch (Exception e) when (!ct.IsCancellationRequested) { log.LogError(e, "job runner tick failed"); }   // only shutdown ends the loop
        }
        while (await timer.WaitForNextTickAsync(ct));   // shutdown cancels the wait
    }
}
