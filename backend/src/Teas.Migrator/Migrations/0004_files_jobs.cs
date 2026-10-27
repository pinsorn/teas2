using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Teas.App;

namespace Teas.Migrator.Migrations;

/// <summary>File metadata (bytes live on the volume, SP3 4.7) and the job queue; both tenant tables with RLS.</summary>
[DbContext(typeof(TeasDbContext))]
[Migration("0004_files_jobs")]
public sealed class FilesJobs : Migration
{
    protected override void Up(MigrationBuilder mb)
    {
        mb.Sql("""
            CREATE TABLE teas.files (
              company_id uuid NOT NULL REFERENCES teas.companies(id),
              id uuid NOT NULL DEFAULT gen_random_uuid(),
              sha256 text NOT NULL,
              mime text NOT NULL,
              size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
              name text NOT NULL,
              created_at timestamptz NOT NULL DEFAULT now(),
              created_by uuid NULL,
              PRIMARY KEY (company_id, id));

            CREATE TABLE teas.jobs (
              company_id uuid NOT NULL REFERENCES teas.companies(id),
              id uuid NOT NULL DEFAULT gen_random_uuid(),
              kind text NOT NULL,
              payload jsonb NOT NULL DEFAULT '{}',
              run_at timestamptz NOT NULL DEFAULT now(),
              status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
              attempts integer NOT NULL DEFAULT 0,
              last_error text NULL,
              result jsonb NULL,
              started_at timestamptz NULL,
              finished_at timestamptz NULL,
              created_at timestamptz NOT NULL DEFAULT now(),
              PRIMARY KEY (company_id, id));
            CREATE INDEX jobs_due ON teas.jobs (run_at) WHERE status = 'queued';
            CREATE INDEX jobs_running ON teas.jobs (started_at) WHERE status = 'running';
            """);
        mb.Sql(RlsSql.TenantTable("files"));
        mb.Sql(RlsSql.TenantTable("jobs"));
        mb.Sql(RlsSql.GrantApp("files", "SELECT, INSERT"));   // blobs are content-addressed and immutable; no UPDATE / DELETE needed yet
        mb.Sql(RlsSql.GrantApp("jobs"));
    }

    protected override void Down(MigrationBuilder mb) =>
        throw new NotSupportedException("0004_files_jobs is forward-only (SP3 4.2).");
}
