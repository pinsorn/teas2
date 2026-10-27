using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Teas.App;

namespace Teas.Migrator.Migrations;

/// <summary>Schema, helper functions, the base tables, RLS, append-only triggers and the teas_app grants (SP3 4.2).</summary>
[DbContext(typeof(TeasDbContext))]
[Migration("0001_platform_base")]
public sealed class PlatformBase : Migration
{
    protected override void Up(MigrationBuilder mb)
    {
        mb.Sql("""
            CREATE EXTENSION IF NOT EXISTS citext;
            CREATE SCHEMA IF NOT EXISTS teas AUTHORIZATION teas_migrator;
            GRANT USAGE ON SCHEMA teas TO teas_app;

            CREATE FUNCTION teas.current_company() RETURNS uuid LANGUAGE sql STABLE AS
              $$ SELECT NULLIF(current_setting('app.company_id', true), '')::uuid $$;
            CREATE FUNCTION teas.current_user_id() RETURNS uuid LANGUAGE sql STABLE AS
              $$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;
            CREATE FUNCTION teas.is_system() RETURNS boolean LANGUAGE sql STABLE AS
              $$ SELECT current_setting('app.system', true) = 'on' $$;
            CREATE FUNCTION teas.forbid_modify() RETURNS trigger LANGUAGE plpgsql AS
              $$ BEGIN RAISE EXCEPTION '% is append-only (% refused)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'restrict_violation'; END $$;

            -- F7: the API startup schema check reads the history; the migrator owns it.
            GRANT SELECT ON teas."__EFMigrationsHistory" TO teas_app;

            -- global tables (rls-allowlist.txt)
            CREATE TABLE teas.users (
              id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
              email citext NOT NULL UNIQUE,
              display_name text NOT NULL,
              password_hash text NULL,
              password_changed_at timestamptz NULL,
              totp_secret_enc bytea NULL,
              totp_pending_enc bytea NULL,
              totp_last_step bigint NULL,
              last_company_id uuid NULL,
              locale text NOT NULL DEFAULT 'th',
              created_at timestamptz NOT NULL DEFAULT now(),
              version integer NOT NULL DEFAULT 1);
            CREATE TABLE teas.sessions (
              id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
              user_id uuid NOT NULL REFERENCES teas.users(id),
              token_hash bytea NOT NULL UNIQUE,
              active_company_id uuid NULL,
              device text NULL,
              ip inet NULL,
              created_at timestamptz NOT NULL DEFAULT now(),
              last_seen_at timestamptz NOT NULL DEFAULT now(),
              idle_expires_at timestamptz NOT NULL,
              absolute_expires_at timestamptz NOT NULL,
              revoked_at timestamptz NULL,
              revoke_reason text NULL);

            -- tenant tables
            CREATE TABLE teas.companies (
              id uuid PRIMARY KEY,
              name text NOT NULL,
              created_at timestamptz NOT NULL DEFAULT now(),
              version integer NOT NULL DEFAULT 1);
            CREATE TABLE teas.company_members (
              company_id uuid NOT NULL REFERENCES teas.companies(id),
              id uuid NOT NULL DEFAULT gen_random_uuid(),
              user_id uuid NULL REFERENCES teas.users(id),
              email citext NOT NULL,
              name text NOT NULL,
              role_id text NOT NULL,
              position text NULL,
              signature_file_id uuid NULL,
              active boolean NOT NULL DEFAULT true,
              invite_pending boolean NOT NULL DEFAULT false,
              last_login_at timestamptz NULL,
              version integer NOT NULL DEFAULT 1,
              PRIMARY KEY (company_id, id),
              UNIQUE (company_id, email),
              UNIQUE (company_id, user_id));
            CREATE TABLE teas.audit_log (
              company_id uuid NOT NULL REFERENCES teas.companies(id),
              id bigint GENERATED ALWAYS AS IDENTITY,
              at timestamptz NOT NULL DEFAULT now(),
              actor_kind text NOT NULL,
              actor_id text NOT NULL,
              actor_name text NOT NULL,
              owner_id text NULL,
              owner_name text NULL,
              command text NOT NULL,
              target text NOT NULL,
              before jsonb NULL,
              after jsonb NULL,
              result text NOT NULL CHECK (result IN ('ok', 'rejected')),
              ip inet NULL,
              trace_id text NULL,
              client text NOT NULL CHECK (client IN ('web', 'mcp', 'api')),
              idempotency_key text NULL,
              PRIMARY KEY (company_id, id));
            """);
        mb.Sql(RlsSql.Companies());
        mb.Sql(RlsSql.CompanyMembers());
        mb.Sql(RlsSql.TenantTable("audit_log"));
        mb.Sql(RlsSql.AppendOnly("audit_log"));
        foreach (var t in new[] { "users", "sessions", "companies", "company_members" }) mb.Sql(RlsSql.GrantApp(t));
        mb.Sql(RlsSql.GrantApp("audit_log", "SELECT, INSERT"));
        mb.Sql("GRANT USAGE ON SEQUENCE teas.audit_log_id_seq TO teas_app;");
    }

    protected override void Down(MigrationBuilder mb) =>
        throw new NotSupportedException("0001_platform_base is forward-only (SP3 4.2).");
}
