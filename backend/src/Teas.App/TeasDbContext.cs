using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Teas.App.Platform;

namespace Teas.App;

/// <summary>The model is added per task; P2 only needs the connection, the transaction interceptor and the migrations history.</summary>
public sealed class TeasDbContext(DbContextOptions<TeasDbContext> options) : DbContext(options)
{
    /// <summary>The migration id this build expects (a test asserts it equals the migrator's last migration).</summary>
    public const string ExpectedSchema = "0006_company_profile";

    protected override void OnModelCreating(ModelBuilder b) => b.HasDefaultSchema("teas");

    public static void Configure(DbContextOptionsBuilder o, string connectionString) =>
        o.UseNpgsql(connectionString, n => n.MigrationsAssembly("Teas.Migrator").MigrationsHistoryTable("__EFMigrationsHistory", "teas"));
}

public static class TeasDataExtensions
{
    public static IServiceCollection AddTeasData(this IServiceCollection services, string connectionString)
    {
        services.AddScoped<TenantScope>();
        services.AddScoped<TenantInterceptor>();
        services.AddScoped<Platform.Audit.AuditContext>();
        services.AddScoped<Platform.Audit.IAudit, Platform.Audit.AuditWriter>();
        services.AddScoped<Platform.Idempotency.IdempotencyRunner>();
        services.AddSingleton<Platform.Rights.RightsCache>();
        services.AddScoped<Platform.Rights.ActorScopes>();
        services.AddScoped<Platform.Rights.EffectiveRights>();
        services.AddScoped<Platform.Files.IFileStore, Platform.Files.FileStore>();   // needs a FileStoreOptions (TEAS_FILES_DIR) from the host
        services.AddScoped<Platform.Jobs.IdempotencyCleanupJob>();
        services.AddSingleton(new Platform.Auth.PasswordService());   // made at startup: its dummy hash must not be computed inside the first unknown-email login
        services.AddScoped<Platform.Auth.SessionService>();
        services.AddScoped<Platform.Auth.AuthAudit>();
        services.AddScoped<Platform.Auth.AuthService>();
        services.AddScoped<Platform.Auth.LinkService>();   // needs an ISecretProtector (AuthService) from the host
        services.AddScoped<Platform.Roles.RoleService>();
        services.AddScoped<Platform.Members.MemberService>();   // needs a PublicLinkBase (TEAS_PUBLIC_URL) from the host
        services.AddScoped<Platform.Companies.CompanyService>();
        services.AddScoped<Platform.Companies.CompanyFactory>();
        services.AddSingleton(sp => new Platform.Jobs.JobRunner(sp.GetRequiredService<IServiceScopeFactory>(), sp.GetRequiredService<TimeProvider>(), connectionString));
        services.AddDbContext<TeasDbContext>((sp, o) =>
        {
            TeasDbContext.Configure(o, connectionString);
            o.AddInterceptors(sp.GetRequiredService<TenantInterceptor>());
        });
        return services;
    }
}
