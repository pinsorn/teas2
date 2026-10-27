using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Teas.App;

namespace Teas.Migrator.Migrations;

/// <summary>Idempotency claims (tenant, RLS) and the global append-only auth_events (SP3 4.2 / 4.7; audit_log itself is in 0001).</summary>
[DbContext(typeof(TeasDbContext))]
[Migration("0002_idempotency_audit")]
public sealed class IdempotencyAudit : Migration
{
    protected override void Up(MigrationBuilder mb)
    {
        mb.Sql("""
            CREATE TABLE teas.idempotency_records (
              company_id uuid NOT NULL REFERENCES teas.companies(id),
              actor_id uuid NOT NULL,
              key uuid NOT NULL,
              route text NOT NULL,
              request_hash text NOT NULL,
              status_code integer NOT NULL,
              response jsonb NULL,
              created_at timestamptz NOT NULL DEFAULT now(),
              PRIMARY KEY (company_id, actor_id, key));
            CREATE INDEX idempotency_records_created_at ON teas.idempotency_records (created_at);

            CREATE TABLE teas.auth_events (
              id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
              at timestamptz NOT NULL DEFAULT now(),
              kind text NOT NULL,
              email_hash bytea NULL,
              user_id uuid NULL,
              ip inet NULL,
              user_agent text NULL);
            """);
        mb.Sql(RlsSql.TenantTable("idempotency_records"));
        mb.Sql(RlsSql.AppendOnly("auth_events"));
        mb.Sql(RlsSql.GrantApp("idempotency_records"));
        mb.Sql(RlsSql.GrantApp("auth_events", "SELECT, INSERT"));
        // identity inserts need no sequence privilege; 0001 granted one on audit_log's sequence, which would let teas_app call nextval()
        mb.Sql("REVOKE USAGE ON SEQUENCE teas.audit_log_id_seq FROM teas_app;");
    }

    protected override void Down(MigrationBuilder mb) =>
        throw new NotSupportedException("0002_idempotency_audit is forward-only (SP3 4.2).");
}
