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

    /// <summary>Exception: the company switcher also lists companies the user is an active, accepted member of.</summary>
    public static string Companies() => $"""
        {EnableAndForce("companies")}
        CREATE POLICY tenant ON teas.companies
          USING (id = teas.current_company() OR teas.is_system() OR EXISTS (SELECT 1 FROM teas.company_members m
                 WHERE m.company_id = companies.id AND m.user_id = teas.current_user_id() AND m.active AND NOT m.invite_pending))
          WITH CHECK (id = teas.current_company());
        """;

    /// <summary>Exception: the switcher lists a user's memberships across companies.</summary>
    public static string CompanyMembers() => $"""
        {EnableAndForce("company_members")}
        CREATE POLICY tenant ON teas.company_members
          USING (company_id = teas.current_company() OR user_id = teas.current_user_id() OR teas.is_system())
          WITH CHECK (company_id = teas.current_company());
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
