using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Teas.App;

namespace Teas.Migrator.Migrations;

/// <summary>Sign-in support (SP3 4.2 / 4.4): recovery codes, login challenges, the failure counter and the set-password links. All global (no company yet when they are used).</summary>
[DbContext(typeof(TeasDbContext))]
[Migration("0005_auth")]
public sealed class Auth : Migration
{
    protected override void Up(MigrationBuilder mb)
    {
        mb.Sql("""
            CREATE TABLE teas.recovery_codes (
              id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
              user_id uuid NOT NULL REFERENCES teas.users(id),
              code_hash text NOT NULL,
              used_at timestamptz NULL);
            CREATE INDEX recovery_codes_user ON teas.recovery_codes (user_id) WHERE used_at IS NULL;

            CREATE TABLE teas.login_challenges (
              token_hash bytea PRIMARY KEY,
              user_id uuid NOT NULL REFERENCES teas.users(id),
              expires_at timestamptz NOT NULL);

            -- one row per sha256(lower(trim(email))): an unknown email has one too, so the lock is no oracle
            CREATE TABLE teas.auth_failures (
              key_hash bytea PRIMARY KEY,
              failures integer NOT NULL,
              locked_until timestamptz NULL,
              updated_at timestamptz NOT NULL);

            -- created_by: the issuing user's id, or 'operator' for the server CLI; anything else is not a valid issuer (the link is then the one 404)
            CREATE TABLE teas.user_links (
              id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
              kind text NOT NULL CHECK (kind IN ('invite', 'reset')),
              token_hash bytea NOT NULL UNIQUE,
              user_id uuid NULL REFERENCES teas.users(id),
              company_id uuid NULL REFERENCES teas.companies(id),
              member_id uuid NULL,
              expires_at timestamptz NOT NULL,
              used_at timestamptz NULL,
              superseded_at timestamptz NULL,
              created_by text NOT NULL,
              created_at timestamptz NOT NULL DEFAULT now(),
              FOREIGN KEY (company_id, member_id) REFERENCES teas.company_members (company_id, id));
            CREATE INDEX user_links_member ON teas.user_links (company_id, member_id) WHERE used_at IS NULL AND superseded_at IS NULL;
            CREATE INDEX user_links_user ON teas.user_links (user_id) WHERE used_at IS NULL AND superseded_at IS NULL;

            CREATE INDEX sessions_user ON teas.sessions (user_id) WHERE revoked_at IS NULL;
            """);
        mb.Sql(RlsSql.GrantApp("recovery_codes"));
        mb.Sql(RlsSql.GrantApp("login_challenges", "SELECT, INSERT, DELETE"));
        mb.Sql(RlsSql.GrantApp("auth_failures"));
        mb.Sql(RlsSql.GrantApp("user_links", "SELECT, INSERT, UPDATE"));
    }

    protected override void Down(MigrationBuilder mb) =>
        throw new NotSupportedException("0005_auth is forward-only (SP3 4.2).");
}
