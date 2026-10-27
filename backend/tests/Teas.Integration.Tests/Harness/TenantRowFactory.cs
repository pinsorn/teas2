using Npgsql;

namespace Teas.Integration.Tests.Harness;

/// <summary>
/// One inserter per tenant table: a valid row (foreign keys included) for the given company. The generated S9 test fails for
/// a tenant table without an entry here, so every task that adds a tenant table adds its method (SP3 P2).
/// The company row for <c>companyId</c> must already exist for every table except <c>companies</c>.
/// </summary>
public static class TenantRowFactory
{
    public static readonly IReadOnlyDictionary<string, Func<NpgsqlConnection, NpgsqlTransaction, Guid, Task>> Inserts =
        new Dictionary<string, Func<NpgsqlConnection, NpgsqlTransaction, Guid, Task>>
        {
            ["companies"] = (c, t, company) => Exec(c, t, company,
                "INSERT INTO teas.companies (id, name) VALUES (@c, 'Company ' || @c::text)"),
            ["company_members"] = (c, t, company) => Exec(c, t, company,
                "INSERT INTO teas.company_members (company_id, email, name, role_id) VALUES (@c, 'm-' || @c::text || '@example.test', 'Member', 'admin')"),
            ["audit_log"] = (c, t, company) => Exec(c, t, company,
                "INSERT INTO teas.audit_log (company_id, actor_kind, actor_id, actor_name, command, target, result, client) VALUES (@c, 'user', 'u', 'U', 'test.cmd', 't', 'ok', 'web')"),
            ["idempotency_records"] = (c, t, company) => Exec(c, t, company,
                "INSERT INTO teas.idempotency_records (company_id, actor_id, key, route, request_hash, status_code) VALUES (@c, gen_random_uuid(), gen_random_uuid(), 'POST /t', 'h', 201)"),
            ["custom_roles"] = (c, t, company) => Exec(c, t, company,
                "INSERT INTO teas.custom_roles (company_id, name, permissions) VALUES (@c, 'Role ' || @c::text, ARRAY['party.read'])"),
        };

    /// <summary>The column the table's policy keys on.</summary>
    public static string KeyColumn(string table) => table == "companies" ? "id" : "company_id";

    static async Task Exec(NpgsqlConnection c, NpgsqlTransaction t, Guid company, string sql)
    {
        await using var cmd = new NpgsqlCommand(sql, c, t);
        cmd.Parameters.AddWithValue("c", company);
        await cmd.ExecuteNonQueryAsync();
    }
}
