using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Teas.App;

namespace Teas.Migrator.Migrations;

/// <summary>The permission catalog and system role templates (global, filled by the migrator's catalog sync) and per-company custom roles (SP3 4.5).</summary>
[DbContext(typeof(TeasDbContext))]
[Migration("0003_catalog")]
public sealed class Catalog : Migration
{
    protected override void Up(MigrationBuilder mb)
    {
        mb.Sql("""
            CREATE TABLE teas.permissions (
              code text PRIMARY KEY,
              area text NOT NULL,
              agent_forbidden boolean NOT NULL,
              sort integer NOT NULL);   -- the catalog order, for display
            CREATE TABLE teas.role_templates (
              role_id text NOT NULL,
              permission_code text NOT NULL REFERENCES teas.permissions(code),
              PRIMARY KEY (role_id, permission_code));

            CREATE TABLE teas.custom_roles (
              company_id uuid NOT NULL REFERENCES teas.companies(id),
              id uuid NOT NULL DEFAULT gen_random_uuid(),
              name text NOT NULL,
              description text NULL,
              permissions text[] NOT NULL DEFAULT '{}',
              version integer NOT NULL DEFAULT 1,
              PRIMARY KEY (company_id, id),
              UNIQUE (company_id, name));
            """);
        mb.Sql(RlsSql.TenantTable("custom_roles"));
        mb.Sql(RlsSql.GrantApp("custom_roles"));
        // the catalog is read-only for the app: only the migrator's sync writes it
        mb.Sql(RlsSql.GrantApp("permissions", "SELECT"));
        mb.Sql(RlsSql.GrantApp("role_templates", "SELECT"));
    }

    protected override void Down(MigrationBuilder mb) =>
        throw new NotSupportedException("0003_catalog is forward-only (SP3 4.2).");
}
