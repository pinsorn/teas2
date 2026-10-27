using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Teas.App.Platform;

namespace Teas.App;

/// <summary>The model is added per task; P2 only needs the connection, the transaction interceptor and the migrations history.</summary>
public sealed class TeasDbContext(DbContextOptions<TeasDbContext> options) : DbContext(options)
{
    /// <summary>The migration id this build expects (a test asserts it equals the migrator's last migration).</summary>
    public const string ExpectedSchema = "0001_platform_base";

    public static void Configure(DbContextOptionsBuilder o, string connectionString) =>
        o.UseNpgsql(connectionString, n => n.MigrationsAssembly("Teas.Migrator").MigrationsHistoryTable("__EFMigrationsHistory", "teas"));
}

public static class TeasDataExtensions
{
    public static IServiceCollection AddTeasData(this IServiceCollection services, string connectionString)
    {
        services.AddScoped<TenantScope>();
        services.AddScoped<TenantInterceptor>();
        services.AddDbContext<TeasDbContext>((sp, o) =>
        {
            TeasDbContext.Configure(o, connectionString);
            o.AddInterceptors(sp.GetRequiredService<TenantInterceptor>());
        });
        return services;
    }
}
