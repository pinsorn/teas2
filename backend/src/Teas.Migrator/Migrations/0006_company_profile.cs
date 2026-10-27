using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Teas.App;

namespace Teas.Migrator.Migrations;

/// <summary>
/// The company profile (SP3 5.1 Company / P8): the legal Thai name stays in <c>name</c> (links and the switcher read it); every other column is nullable or has a
/// default, so a row that only knows (id, name) stays valid. Images are file ids (the wire carries data URLs). No new table, so RLS is unchanged.
/// </summary>
[DbContext(typeof(TeasDbContext))]
[Migration("0006_company_profile")]
public sealed class CompanyProfile : Migration
{
    protected override void Up(MigrationBuilder mb) => mb.Sql("""
        ALTER TABLE teas.companies
          ADD COLUMN legal_name_en text NULL,
          ADD COLUMN tax_id text NOT NULL DEFAULT '',
          ADD COLUMN branch_code text NOT NULL DEFAULT '00000',
          ADD COLUMN registration_no text NULL,
          ADD COLUMN address text NOT NULL DEFAULT '',
          ADD COLUMN paid_up_capital numeric(18,2) NULL,
          ADD COLUMN trade_name text NULL,
          ADD COLUMN phone text NULL,
          ADD COLUMN email text NULL,
          ADD COLUMN website text NULL,
          ADD COLUMN sso_employer_account_no text NULL,
          ADD COLUMN vat_registered boolean NOT NULL DEFAULT false,
          ADD COLUMN fiscal_year_start_month integer NOT NULL DEFAULT 1 CHECK (fiscal_year_start_month BETWEEN 1 AND 12),
          ADD COLUMN logo_file_id uuid NULL,
          ADD COLUMN stamp_file_id uuid NULL,
          ADD COLUMN default_notes jsonb NOT NULL DEFAULT '{}';
        ALTER TABLE teas.companies
          ADD FOREIGN KEY (id, logo_file_id) REFERENCES teas.files (company_id, id),
          ADD FOREIGN KEY (id, stamp_file_id) REFERENCES teas.files (company_id, id);
        ALTER TABLE teas.company_members
          ADD FOREIGN KEY (company_id, signature_file_id) REFERENCES teas.files (company_id, id);
        """);

    protected override void Down(MigrationBuilder mb) =>
        throw new NotSupportedException("0006_company_profile is forward-only (SP3 4.2).");
}
