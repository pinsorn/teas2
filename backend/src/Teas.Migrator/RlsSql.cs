namespace Teas.Migrator;

/// <summary>
/// SQL generators for row-level security (SP3 4.2). Every tenant table gets its policy from <see cref="TenantTable"/>;
/// the two hand-written exceptions are <see cref="Companies"/> and <see cref="CompanyMembers"/>.
/// </summary>
public static class RlsSql
{
    static string EnableAndForce(string t) => $"""
        ALTER TABLE teas.{t} ENABLE ROW LEVEL SECURITY;
        ALTER TABLE teas.{t} FORCE ROW LEVEL SECURITY;
        """;

    /// <summary>System scope may read / delete, never write a row (WITH CHECK has no is_system()).</summary>
    public static string TenantTable(string table, string key = "company_id") => $"""
        {EnableAndForce(table)}
        CREATE POLICY tenant ON teas.{table}
          USING ({key} = teas.current_company() OR teas.is_system())
          WITH CHECK ({key} = teas.current_company());
        """;

    // The two exception tables widen ONLY the SELECT policy. UPDATE / DELETE keep the narrow predicate: with one FOR ALL
    // policy the widened USING would also let company A's session update or delete the rows it merely may see (M2).

    /// <summary>Exception: the company switcher also lists companies the user is an active, accepted member of (SELECT only).</summary>
    public static string Companies() => $"""
        {EnableAndForce("companies")}
        CREATE POLICY tenant_select ON teas.companies FOR SELECT
          USING (id = teas.current_company() OR teas.is_system() OR EXISTS (SELECT 1 FROM teas.company_members m
                 WHERE m.company_id = companies.id AND m.user_id = teas.current_user_id() AND m.active AND NOT m.invite_pending));
        CREATE POLICY tenant_insert ON teas.companies FOR INSERT WITH CHECK (id = teas.current_company());
        CREATE POLICY tenant_update ON teas.companies FOR UPDATE
          USING (id = teas.current_company() OR teas.is_system()) WITH CHECK (id = teas.current_company());
        CREATE POLICY tenant_delete ON teas.companies FOR DELETE USING (id = teas.current_company() OR teas.is_system());
        """;

    /// <summary>Exception: the switcher lists a user's memberships across companies (SELECT only).</summary>
    public static string CompanyMembers() => $"""
        {EnableAndForce("company_members")}
        CREATE POLICY tenant_select ON teas.company_members FOR SELECT
          USING (company_id = teas.current_company() OR user_id = teas.current_user_id() OR teas.is_system());
        CREATE POLICY tenant_insert ON teas.company_members FOR INSERT WITH CHECK (company_id = teas.current_company());
        CREATE POLICY tenant_update ON teas.company_members FOR UPDATE
          USING (company_id = teas.current_company() OR teas.is_system()) WITH CHECK (company_id = teas.current_company());
        CREATE POLICY tenant_delete ON teas.company_members FOR DELETE
          USING (company_id = teas.current_company() OR teas.is_system());
        """;

    public static string GrantApp(string table, string privileges = "SELECT, INSERT, UPDATE, DELETE") =>
        $"GRANT {privileges} ON teas.{table} TO teas_app;";

    /// <summary>UPDATE / DELETE / TRUNCATE raise for everyone, the owner included (S14).</summary>
    public static string AppendOnly(string table) => $"""
        CREATE TRIGGER {table}_no_modify BEFORE UPDATE OR DELETE ON teas.{table}
          FOR EACH ROW EXECUTE FUNCTION teas.forbid_modify();
        CREATE TRIGGER {table}_no_truncate BEFORE TRUNCATE ON teas.{table}
          FOR EACH STATEMENT EXECUTE FUNCTION teas.forbid_modify();
        """;
}
