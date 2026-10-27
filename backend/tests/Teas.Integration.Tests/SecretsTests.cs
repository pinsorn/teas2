using System.Net;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using Teas.App.Platform;
using Teas.Domain.Platform;
using Teas.Integration.Tests.Harness;

namespace Teas.Integration.Tests;

// SP3 S1 (no secret at rest in clear) and S2 (each secret on the wire once; none in a GET, an audit row or a log line).
public sealed class SecretsTests(AuthFixture fx) : IClassFixture<AuthFixture>
{
    AuthHost H => fx.Host;
    static NpgsqlParameter P(string n, object? v) => new(n, v ?? DBNull.Value);

    /// <summary>Every table of schema teas, row by row as text (bytea as hex, jsonb as text), read under system scope.</summary>
    async Task<string> DumpAsync()
    {
        var sb = new StringBuilder();
        await H.Db.AsAppAsync(new ScopeState(null, null, true), async (c, t) =>
        {
            var tables = new List<string>();
            await using (var cmd = new NpgsqlCommand("SELECT tablename FROM pg_tables WHERE schemaname = 'teas'", c, t))
            await using (var r = await cmd.ExecuteReaderAsync())
                while (await r.ReadAsync()) tables.Add(r.GetString(0));
            foreach (var table in tables)
            {
                await using var cmd = new NpgsqlCommand($"SELECT x::text FROM teas.\"{table}\" x", c, t);
                await using var r = await cmd.ExecuteReaderAsync();
                while (await r.ReadAsync()) sb.Append(table).Append(' ').AppendLine(r.GetString(0));
            }
            return 0;
        });
        return sb.ToString();
    }

    [Fact]
    public async Task NoSecretIsStoredLoggedOrReturnedMoreThanOnce()
    {
        var company = await H.CreateCompanyAsync();
        var user = await H.CreateUserAsync(name: "Secret Keeper");
        await H.AddMemberAsync(company, user, "admin");
        var secrets = new Dictionary<string, string> { ["password"] = user.Password };

        // sign in, change the password, enrol two-step, sign in with the code, then with a recovery code
        var login = await H.Post("/auth/login", new { email = user.Email, password = user.Password });
        var token1 = login.Token!;
        secrets["session token 1"] = token1;
        const string next = "Changed#Pass2026";
        Assert.Equal(HttpStatusCode.OK, (await H.Post("/auth/password", new { current = user.Password, next, confirm = next }, token1)).Status);
        secrets["new password"] = next;

        var start = await H.Post("/auth/totp/enrol", token: token1);
        var b32 = start.Str("secret")!;
        secrets["totp secret"] = b32;
        var raw = Totp.FromBase32(b32);
        var verify = await H.Post("/auth/totp/enrol/verify", new { code = Totp.Code(raw, Totp.StepOf(H.Now)) }, token1);
        var codes = verify.Json.GetProperty("recoveryCodes").EnumerateArray().Select(e => e.GetString()!).ToList();
        for (var i = 0; i < codes.Count; i++) secrets[$"recovery code {i}"] = codes[i];

        var step = await H.Post("/auth/login", new { email = user.Email, password = next });
        var challenge = step.Str("challenge")!;
        secrets["challenge"] = challenge;
        H.Clock.Advance(TimeSpan.FromSeconds(30));
        var done = await H.Post("/auth/totp", new { challenge, code = Totp.Code(raw, Totp.StepOf(H.Now)) });
        var token2 = done.Token!;
        secrets["session token 2"] = token2;

        // a link made by the operator CLI and one made like P8 makes them
        var cli = new StringWriter();
        Assert.Equal(0, await AuthCli.RunAsync(["reset-password", "--email", user.Email], H.Db.MigratorCs, "https://teas.example.test", cli, new StringWriter()));
        var cliToken = cli.ToString().Trim().Split('/')[^1];
        secrets["cli link token"] = cliToken;
        var member = await H.AddMemberAsync(company, null, "operator", pending: true, email: $"inv-{Guid.NewGuid():N}@example.test");
        var inviteToken = await H.IssueLinkAsync("invite", user.Id.ToString(), companyId: company, memberId: member);
        secrets["invite token"] = inviteToken;
        var inviteInfo = await H.Get($"/auth/links/{inviteToken}");
        var inviteDone = await H.Post($"/auth/links/{inviteToken}", new { password = "Invited#Pass2026", confirm = "Invited#Pass2026" });
        secrets["invited password"] = "Invited#Pass2026";
        Assert.Equal(HttpStatusCode.OK, inviteDone.Status);

        // S1: nothing in clear in any table, in any plausible encoding; and the formats that must be hashed are
        var dump = await DumpAsync();
        foreach (var (what, secret) in secrets)
        {
            Assert.False(dump.Contains(secret, StringComparison.Ordinal), $"{what} is stored in clear");
            Assert.False(dump.Contains(Convert.ToHexString(Encoding.UTF8.GetBytes(secret)), StringComparison.OrdinalIgnoreCase), $"{what} is stored as raw bytes");
        }
        Assert.False(dump.Contains(Convert.ToHexString(raw), StringComparison.OrdinalIgnoreCase), "the totp secret is stored unencrypted");
        Assert.DoesNotContain(dump.Split('\n').Where(l => l.StartsWith("auth_events ")), l => l.Contains(user.Email, StringComparison.OrdinalIgnoreCase));   // only a hash of the email
        Assert.Equal(1, await H.ScalarAsync<long>("SELECT count(*) FROM teas.users WHERE id = @u AND password_hash LIKE 'AQAAAA%'", P("u", user.Id)));
        Assert.Equal(8, await H.ScalarAsync<long>("SELECT count(*) FROM teas.recovery_codes WHERE user_id = @u AND code_hash LIKE 'AQAAAA%'", P("u", user.Id)));
        Assert.Equal(0, await H.ScalarAsync<long>("SELECT count(*) FROM teas.sessions WHERE length(token_hash) <> 32"));
        Assert.Equal(0, await H.ScalarAsync<long>("SELECT count(*) FROM teas.user_links WHERE length(token_hash) <> 32"));
        Assert.Equal(0, await H.ScalarAsync<long>("SELECT count(*) FROM teas.login_challenges WHERE length(token_hash) <> 32"));
        Assert.DoesNotContain(dump.Split('\n').Where(l => l.StartsWith("audit_log ") || l.StartsWith("auth_events ")), l => l.Contains("AQAAAA"));   // no hash in an audit row either

        // S2: once on the wire
        var onceOnly = new[] { ("recovery codes", codes.ToArray(), verify.Raw), ("totp secret", new[] { b32 }, start.Raw) };
        foreach (var (what, values, owner) in onceOnly)
            foreach (var v in values) Assert.Contains(v, owner);
        var later = new List<Res>
        {
            await H.Get("/auth/profile", token2), await H.Get("/auth/sessions", token2), await H.Get("/auth/session", token2),
            await H.Post("/auth/session/extend", token: token2), await H.Get($"/auth/links/{cliToken}"), inviteInfo, inviteDone, done,
            await H.Post("/auth/totp/enrol", token: token2),   // a re-enrolment returns a NEW secret, never the old one
        };
        foreach (var r in later)
        {
            foreach (var (what, secret) in secrets)
                Assert.False(r.Raw.Contains(secret, StringComparison.Ordinal), $"{what} is in a later response: {r.Raw}");
            foreach (var t in new[] { token1, token2 }) Assert.DoesNotContain(t, r.Raw);   // a cookie is a header, never a body
        }

        // logs: nothing sensitive at any level, whatever the category (request logging included: link tokens travel in a path)
        var log = string.Join('\n', H.Logs.Lines);
        foreach (var (what, secret) in secrets) Assert.False(log.Contains(secret, StringComparison.Ordinal), $"{what} is in the log");
        Assert.DoesNotContain("AQAAAA", log);
    }

    [Fact]
    public async Task AnApiKeySecretIsStoredAsItsHashOnlyAndOnTheWireOnceByCreateAndRotate()
    {
        var (company, _, token, _) = await P8.AdminAsync(H);
        var created = await K.CreateAsync(H, token, "rest", ["party.read"], "S1");
        var mcp = await K.CreateAsync(H, token, "mcp", ["party.read"], "S1-mcp");
        var rotated = await H.Post($"/connect/keys/{created.Id}/rotate", new { version = 1 }, token);
        var secrets = new[] { created.Secret, mcp.Secret, rotated.Str("secret")! };
        Assert.Equal(3, secrets.Distinct().Count());
        var rpc = await K.RpcAsync(H, mcp.Secret, "tools/call", new { name = "whoami", arguments = new { } });
        var later = new List<Res>
        {
            await H.Get("/connect/keys", token),
            await H.Post($"/connect/keys/{mcp.Id}/revoke", new { version = 1 }, token), await K.WhoAmI(H, rotated.Str("secret")), rpc,
            await K.WhoAmI(H, created.Secret),   // refused: the rotated-away key
        };
        var dump = await DumpAsync();
        foreach (var s in secrets)
        {
            Assert.False(dump.Contains(s, StringComparison.Ordinal), "a key secret is stored in clear");
            Assert.False(dump.Contains(Convert.ToHexString(Encoding.UTF8.GetBytes(s)), StringComparison.OrdinalIgnoreCase), "a key secret is stored as raw bytes");
            Assert.False(dump.Contains(s[10..], StringComparison.Ordinal), "the hex part of a key secret is stored");
            foreach (var r in later) Assert.False(r.Raw.Contains(s, StringComparison.Ordinal), $"a later response carries a key secret: {r.Raw}");
            Assert.DoesNotContain(H.Logs.Lines, l => l.Contains(s, StringComparison.Ordinal) || l.Contains(s[10..], StringComparison.Ordinal));
        }
        Assert.Contains(created.Secret, created.Res.Raw);   // on the wire once, by the route that made it
        Assert.Contains(secrets[2], rotated.Raw);
        Assert.Equal(0, await H.ScalarAsync<long>("SELECT count(*) FROM teas.api_keys WHERE company_id = @c AND length(secret_hash) <> 32", P("c", company)));
        Assert.DoesNotContain(dump.Split('\n').Where(l => l.StartsWith("audit_log ")), l => secrets.Any(s => l.Contains(s[10..], StringComparison.Ordinal)));
        // a bearer header is never a log line either (request logging stays at warning)
        Assert.DoesNotContain(H.Logs.Lines, l => l.Contains("Bearer teas_", StringComparison.Ordinal));
    }

    [Fact]
    public async Task TheLogLevelOfRequestLoggingKeepsLinkTokensOutOfTheLog()
    {
        var token = "tok-" + Guid.NewGuid().ToString("N") + Guid.NewGuid().ToString("N");
        await H.Get($"/auth/links/{token}");
        await H.Post($"/auth/links/{token}", new { password = "x", confirm = "x" });
        Assert.DoesNotContain(H.Logs.Lines, l => l.Contains(token));
    }
}
