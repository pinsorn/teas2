using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Teas.App;

namespace Teas.Migrator.Migrations;

/// <summary>
/// API keys (SP3 4.2 / 4.6 / P9): tenant table, RLS by company. Only sha256 of the secret is stored (<c>secret_hash</c>, unique: the lookup at use time, before any company is
/// known, is by that hash under system scope in Platform/Keys); <c>prefix</c> is the display text. No DELETE grant: a key is revoked, never removed.
/// </summary>
[DbContext(typeof(TeasDbContext))]
[Migration("0007_api_keys")]
public sealed class ApiKeys : Migration
{
    protected override void Up(MigrationBuilder mb)
    {
        mb.Sql("""
            CREATE TABLE teas.api_keys (
              company_id uuid NOT NULL REFERENCES teas.companies(id),
              id uuid NOT NULL DEFAULT gen_random_uuid(),
              name text NOT NULL,
              kind text NOT NULL CHECK (kind IN ('rest', 'mcp')),
              prefix text NOT NULL,
              secret_hash bytea NOT NULL UNIQUE CHECK (length(secret_hash) = 32),
              owner_user_id uuid NOT NULL REFERENCES teas.users(id),
              scopes text[] NOT NULL,
              created_at timestamptz NOT NULL DEFAULT now(),
              expires_on date NULL,
              last_used_at timestamptz NULL,
              revoked_at timestamptz NULL,
              rotated_from uuid NULL,
              version integer NOT NULL DEFAULT 1,
              PRIMARY KEY (company_id, id),
              UNIQUE (id),
              FOREIGN KEY (company_id, rotated_from) REFERENCES teas.api_keys (company_id, id));
            CREATE INDEX api_keys_owner ON teas.api_keys (company_id, owner_user_id);
            """);
        mb.Sql(RlsSql.TenantTable("api_keys"));
        mb.Sql(RlsSql.GrantApp("api_keys", "SELECT, INSERT, UPDATE"));
    }

    protected override void Down(MigrationBuilder mb) =>
        throw new NotSupportedException("0007_api_keys is forward-only (SP3 4.2).");
}
