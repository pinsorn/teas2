using Microsoft.EntityFrameworkCore;
using Teas.App;

// Verbs: migrate (P2) | bootstrap-admin | reset-mfa | reset-password (P7). Connects as teas_migrator.
var verb = args.FirstOrDefault();
if (verb == "migrate")
{
    var cs = Environment.GetEnvironmentVariable("TEAS_MIGRATOR_CS");
    if (string.IsNullOrWhiteSpace(cs)) { Console.Error.WriteLine("teas-migrator: set TEAS_MIGRATOR_CS"); return 2; }
    await MigratorRunner.MigrateAsync(cs);
    Console.WriteLine("teas-migrator: schema is at " + TeasDbContext.ExpectedSchema);
    return 0;
}
Console.Error.WriteLine("teas-migrator: unknown or not yet available verb '" + verb + "' (migrate)");
return 2;

/// <summary>Also called by the integration-test harness to build the template database.</summary>
public static class MigratorRunner
{
    public static async Task MigrateAsync(string migratorConnectionString)
    {
        var options = new DbContextOptionsBuilder<TeasDbContext>();
        TeasDbContext.Configure(options, migratorConnectionString);
        await using var db = new TeasDbContext(options.Options);
        await db.Database.MigrateAsync();
    }
}
