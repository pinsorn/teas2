using System.Net;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using Teas.Api.Machine;
using Teas.Api.Routing;
using Teas.App.Platform;
using Teas.Integration.Tests.Harness;

namespace Teas.Integration.Tests;

/// <summary>Two deliberately wrong machine routes (the real builder refuses them), to prove the runtime backstop and the per-tool authorization run on a real key.</summary>
sealed class WrongMachineRoutes : IStartupFilter
{
    public sealed record Body(string Name);
    public sealed class EchoBody { public required string Name { get; init; } }

    public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next) => app =>
    {
        next(app);
        app.UseRouting();
        app.UseTeasRouteGuards();
        app.UseEndpoints(e =>
        {
            e.MapMethods("/api/v1/_t/notagent", ["POST"], (Body b) => Results.Ok(new { b.Name }))
                .WithMetadata(new RouteSpec("POST", "/api/v1/_t/notagent", "key", Agent: false, Audit: "test.notagent"), new MachineChannel("rest"));
            e.MapMethods("/api/v1/_t/echo", ["POST"], (EchoBody b) => Results.Ok(new { b.Name }))
                .WithMetadata(new RouteSpec("POST", "/api/v1/_t/echo", "key", Agent: true), new MachineChannel("rest"), new McpToolAttribute("echo", "echoes name"));
            e.MapMethods("/api/v1/_t/p/{id}", ["GET"], (string id) => Results.Ok(new { id }))
                .WithMetadata(new RouteSpec("GET", "/api/v1/_t/p/{id}", "key", Agent: true), new MachineChannel("rest"), new McpToolAttribute("param_tool", "has a path parameter"));   // metadata, not a handler attribute: MapMachine cannot see it
            e.MapMethods("/api/v1/_t/needs-bank", ["GET"], () => Results.Ok(new { ok = true }))
                .WithMetadata(new RouteSpec("GET", "/api/v1/_t/needs-bank", "key", "bank.manage", Agent: true), new MachineChannel("rest"), new McpToolAttribute("needs_bank", "needs bank.manage"));
        });
    };
}

// SP3 S10 (P9): the agent choke point. /api/v1 and /mcp map ONLY agent routes; the runtime check refuses before the body; x-teas-actor changes nothing;
// the MCP tool list is the agent + McpTool routes; whoami writes no audit row and moves last_used_at.
public sealed class AgentSurfaceTests(AuthFixture fx) : IClassFixture<AuthFixture>
{
    AuthHost H => fx.Host;
    static NpgsqlParameter P(string n, object? v) => P8.P(n, v);

    IEnumerable<RouteEndpoint> Endpoints(IServiceProvider? sp = null) => (sp ?? H.Factory.Services).GetRequiredService<EndpointDataSource>().Endpoints.OfType<RouteEndpoint>();
    static string Text(Res r) => r.Json.GetProperty("result").GetProperty("content")[0].GetProperty("text").GetString()!;

    [Fact]
    public void S10EveryRouteOnTheMachineSurfaceIsAnAgentRouteDeclaredByKey_AndNothingElseIsThere()
    {
        var machine = Endpoints().Where(e => e.RoutePattern.RawText!.StartsWith("/api/v1", StringComparison.Ordinal) || e.RoutePattern.RawText.StartsWith("/mcp", StringComparison.Ordinal)).ToList();
        Assert.Equal(["/api/v1/whoami", "/mcp"], machine.Select(e => e.RoutePattern.RawText!).Order());
        foreach (var e in machine)
        {
            var spec = e.Metadata.GetMetadata<RouteSpec>();
            Assert.True(spec is { Agent: true, Auth: "key" }, e.RoutePattern.RawText);
            Assert.NotNull(e.Metadata.GetMetadata<MachineChannel>());
        }
        // and the other way: a route that carries the machine marker lives on the machine paths
        foreach (var e in Endpoints().Where(x => x.Metadata.GetMetadata<MachineChannel>() is not null))
            Assert.Matches("^/(api/v1|mcp)", e.RoutePattern.RawText!);
        // every agent:false route of the internal group is exactly that: not on the machine paths (and the BFF-only group has no machine marker)
        foreach (var e in Endpoints().Where(x => x.RoutePattern.RawText!.StartsWith("/internal/v1", StringComparison.Ordinal) && x.Metadata.GetMetadata<RouteSpec>() is { Agent: false }))
            Assert.Null(e.Metadata.GetMetadata<MachineChannel>());
    }

    [Fact]
    public async Task S10NoInternalRouteAnswersOnTheMachinePathsEvenWithAValidKey()
    {
        var (_, _, token, _) = await P8.AdminAsync(H);
        var rest = await K.CreateAsync(H, token, "rest");
        var mcp = await K.CreateAsync(H, token, "mcp");
        var guid = Guid.NewGuid().ToString();
        var internals = Endpoints().Select(e => (spec: e.Metadata.GetMetadata<RouteSpec>(), raw: e.RoutePattern.RawText!))
            .Where(r => r.spec is not null && r.raw.StartsWith("/internal/v1/", StringComparison.Ordinal)).ToList();
        Assert.True(internals.Count > 25, "routes found: " + internals.Count);
        var failures = new List<string>();
        foreach (var (spec, raw) in internals)
        {
            var tail = Regex.Replace(raw["/internal/v1".Length..], @"\{[^}]+\}", guid);
            foreach (var (prefix, key) in new[] { ("/api/v1", rest.Secret), ("/mcp", mcp.Secret) })
            {
                var r = await K.MachineAsync(H, new HttpMethod(spec!.Method), prefix + tail, key, spec.Method == "GET" ? null : new { });
                if (r.Status != HttpStatusCode.NotFound) failures.Add($"{spec.Method} {prefix}{tail}: {(int)r.Status}");
            }
        }
        Assert.Empty(failures);
        // a key sent to the BFF-only group is a stranger there: no session, no entry
        var viaBff = await H.Client.SendAsync(new HttpRequestMessage(HttpMethod.Get, "/internal/v1/me") { Headers = { { "Authorization", "Bearer " + rest.Secret } } });
        Assert.Equal(HttpStatusCode.Unauthorized, viaBff.StatusCode);
        // and the other credential does not work on the machine paths
        Assert.Equal(HttpStatusCode.Unauthorized, (await K.MachineAsync(H, HttpMethod.Get, "/api/v1/whoami", token)).Status);   // a session token as Bearer is not a key
    }

    [Fact]
    public async Task S10TheRuntimeBackstopRefusesAnAgentOnANonAgentRouteBeforeTheBody_WithOneRejectedRow()
    {
        using var f = H.Factory.WithWebHostBuilder(b => b.ConfigureServices(s => s.AddSingleton<IStartupFilter>(new WrongMachineRoutes())));
        var client = f.CreateClient();
        var (company, admin, token, _) = await P8.AdminAsync(H);
        var made = await K.CreateAsync(H, token, "rest");
        async Task<Res> Post(string body, params (string, string)[] headers)
        {
            using var req = new HttpRequestMessage(HttpMethod.Post, "/api/v1/_t/notagent") { Content = new StringContent(body, System.Text.Encoding.UTF8, "application/json") };
            req.Headers.TryAddWithoutValidation("Authorization", "Bearer " + made.Secret);
            foreach (var (k, v) in headers) req.Headers.TryAddWithoutValidation(k, v);
            using var m = await client.SendAsync(req);
            return new Res(m, await m.Content.ReadAsStringAsync());
        }
        // a body that cannot be bound is still a plain 403, never a 422; headers that name a person change nothing
        foreach (var r in new[] { await Post("{not json"), await Post("", ("x-teas-actor", admin.Id.ToString())), await Post("{\"name\":\"x\"}", ("x-teas-actor", admin.Id.ToString()), ("x-actor", admin.Id.ToString())) })
            Assert.True((r.Status, r.Code) == (HttpStatusCode.Forbidden, "agent.forbidden_action"), r.Raw);
        Assert.Equal(3, await H.ScalarAsync<long>("SELECT count(*) FROM teas.audit_log WHERE company_id = @c AND result = 'rejected' AND actor_kind = 'agent' AND actor_id = @a AND client = 'api' AND command = 'test.notagent'", P("c", company), P("a", made.Id)));
        Assert.Equal(0, await H.ScalarAsync<long>("SELECT count(*) FROM teas.audit_log WHERE company_id = @c AND result = 'ok' AND command = 'test.notagent'", P("c", company)));
    }

    [Fact]
    public async Task XTeasActorAndTheOtherIdentityHeadersChangeNothing()
    {
        var (company, admin, token, _) = await P8.AdminAsync(H);
        var made = await K.CreateAsync(H, token, "rest", ["party.read"]);
        var who = await K.WhoAmI(H, made.Secret, ("x-teas-actor", admin.Id.ToString()), ("x-actor", admin.Id.ToString()), ("x-company", Guid.NewGuid().ToString()), ("x-agent-owner", admin.Id.ToString()), ("x-agent-scopes", "users.manage"));
        Assert.Equal(HttpStatusCode.OK, who.Status);
        var actor = who.Json.GetProperty("actor");
        Assert.Equal(("agent", made.Id), (actor.GetProperty("kind").GetString(), actor.GetProperty("id").GetString()));
        Assert.Equal(["party.read"], K.Rights(who));
        Assert.Equal(company.ToString(), who.Str("companyId"));
        // no key, only the header: nobody
        var bare = await K.WhoAmI(H, null, ("x-teas-actor", admin.Id.ToString()));
        Assert.Equal((HttpStatusCode.Unauthorized, "connect.key_invalid"), (bare.Status, bare.Code));
    }

    [Fact]
    public async Task WhoAmIAnswersTheFrozenShape_WritesNoAuditRow_AndMovesLastUsedAtThrottledToOncePerMinute()
    {
        var (company, _, token, _) = await P8.AdminAsync(H, "บริษัท ฮู จำกัด");
        var made = await K.CreateAsync(H, token, "rest", ["party.read", "report.read"], "Reporter");
        Task<string?> Last() => H.ScalarAsync<string>("SELECT last_used_at::text FROM teas.api_keys WHERE id = @i", P("i", Guid.Parse(made.Id)));
        Assert.Null(await Last());
        var auditBefore = await H.ScalarAsync<long>("SELECT count(*) FROM teas.audit_log WHERE company_id = @c", P("c", company));

        var r = await K.WhoAmI(H, made.Secret);
        Assert.Equal(HttpStatusCode.OK, r.Status);
        Assert.Equal(["actor", "companyId", "companyName", "rights"], r.Json.EnumerateObject().Select(p => p.Name).Order());
        Assert.Equal((company.ToString(), "บริษัท ฮู จำกัด", "agent", "Reporter"), (r.Str("companyId"), r.Str("companyName"), r.Json.GetProperty("actor").GetProperty("kind").GetString(), r.Json.GetProperty("actor").GetProperty("name").GetString()));
        Assert.StartsWith("Admin ", r.Json.GetProperty("actor").GetProperty("ownerName").GetString());
        Assert.Equal(["party.read", "report.read"], K.Rights(r));
        Assert.DoesNotContain(made.Secret, r.Raw);
        var first = await Last();
        Assert.Equal(H.Now, DateTimeOffset.Parse(first!));   // null -> now

        await K.WhoAmI(H, made.Secret);
        Assert.Equal(first, await Last());   // throttled: a second use inside the minute writes nothing
        H.Clock.Advance(TimeSpan.FromMinutes(2));
        await K.WhoAmI(H, made.Secret);
        Assert.Equal(H.Now, DateTimeOffset.Parse((await Last())!));
        Assert.Equal(1, await H.ScalarAsync<int>("SELECT version FROM teas.api_keys WHERE id = @i", P("i", Guid.Parse(made.Id))));   // use is not an edit: version untouched
        // a GET is not audited
        Assert.Equal(auditBefore, await H.ScalarAsync<long>("SELECT count(*) FROM teas.audit_log WHERE company_id = @c", P("c", company)));
    }

    [Fact]
    public async Task AKeyOfTheOtherKindIsRefusedOnEachChannel_403KindMismatch()
    {
        var (company, _, token, _) = await P8.AdminAsync(H);
        var rest = await K.CreateAsync(H, token, "rest");
        var mcp = await K.CreateAsync(H, token, "mcp");
        void Mismatch(Res r) => Assert.True((r.Status, r.Code) == (HttpStatusCode.Forbidden, "connect.key_kind_mismatch"), r.Raw);
        Mismatch(await K.RpcAsync(H, rest.Secret, "tools/list"));           // a REST key on /mcp
        Mismatch(await K.RpcAsync(H, rest.Secret, "ping"));
        Mismatch(await K.WhoAmI(H, mcp.Secret));                             // an MCP key on /api/v1
        Assert.Equal(HttpStatusCode.OK, (await K.WhoAmI(H, rest.Secret)).Status);
        Assert.Equal(HttpStatusCode.OK, (await K.RpcAsync(H, mcp.Secret, "ping")).Status);
        // the stored kind decides, not the secret's text: a row whose prefix says rest but whose kind is mcp
        await H.ExecAsync("UPDATE teas.api_keys SET kind = 'mcp' WHERE id = @i", new ScopeState(company, null, false), P("i", Guid.Parse(rest.Id)));
        Mismatch(await K.WhoAmI(H, rest.Secret));
    }

    [Fact]
    public async Task TheToolListIsExactlyTheAgentRoutesWithAnMcpTool()
    {
        var (_, _, token, _) = await P8.AdminAsync(H);
        var mcp = await K.CreateAsync(H, token, "mcp");
        var expected = Endpoints().Where(e => e.Metadata.GetMetadata<RouteSpec>() is { Agent: true } && e.Metadata.GetMetadata<McpToolAttribute>() is not null)
            .Select(e => e.Metadata.GetMetadata<McpToolAttribute>()!.Name).Order().ToList();
        Assert.Equal(["whoami"], expected);
        var list = await K.RpcAsync(H, mcp.Secret, "tools/list");
        Assert.Equal(HttpStatusCode.OK, list.Status);
        var tools = list.Json.GetProperty("result").GetProperty("tools").EnumerateArray().ToList();
        Assert.Equal(expected, tools.Select(t => t.GetProperty("name").GetString()!).Order());
        foreach (var t in tools)
        {
            Assert.False(string.IsNullOrWhiteSpace(t.GetProperty("description").GetString()));
            Assert.Equal("object", t.GetProperty("inputSchema").GetProperty("type").GetString());
        }
        // an agent route without the tool attribute is not a tool (the test-only agent routes of the RBAC matrix exist in this host's data source as /_t/agent/*)
        Assert.DoesNotContain(tools, t => t.GetProperty("name").GetString()!.Contains("agent", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task AnMcpWhoAmICallRunsTheRoutePipeline_NoAuditRow_LastUsedAtMoved_SameAnswerAsRest()
    {
        var (company, _, token, _) = await P8.AdminAsync(H);
        var mcp = await K.CreateAsync(H, token, "mcp", ["party.read", "item.read"], "Desk");
        var auditBefore = await H.ScalarAsync<long>("SELECT count(*) FROM teas.audit_log WHERE company_id = @c", P("c", company));
        Assert.Null(await H.ScalarAsync<string>("SELECT last_used_at::text FROM teas.api_keys WHERE id = @i", P("i", Guid.Parse(mcp.Id))));

        var call = await K.RpcAsync(H, mcp.Secret, "tools/call", new { name = "whoami", arguments = new { } });
        Assert.Equal(HttpStatusCode.OK, call.Status);
        var result = call.Json.GetProperty("result");
        Assert.False(result.GetProperty("isError").GetBoolean());
        var body = JsonDocument.Parse(Text(call)).RootElement;
        Assert.Equal(body.ToString(), result.GetProperty("structuredContent").ToString());
        Assert.Equal((company.ToString(), "agent", "Desk"), (body.GetProperty("companyId").GetString(), body.GetProperty("actor").GetProperty("kind").GetString(), body.GetProperty("actor").GetProperty("name").GetString()));
        Assert.Equal(["item.read", "party.read"], body.GetProperty("rights").EnumerateArray().Select(x => x.GetString()!).Order());
        Assert.Equal(H.Now, DateTimeOffset.Parse((await H.ScalarAsync<string>("SELECT last_used_at::text FROM teas.api_keys WHERE id = @i", P("i", Guid.Parse(mcp.Id))))!));
        Assert.Equal(auditBefore, await H.ScalarAsync<long>("SELECT count(*) FROM teas.audit_log WHERE company_id = @c", P("c", company)));
    }

    [Fact]
    public async Task AToolCallIsAuthorizedLikeARequest_ARefusalIsAToolErrorWithOneRejectedRowOfClientMcp()
    {
        using var f = H.Factory.WithWebHostBuilder(b => b.ConfigureServices(s => s.AddSingleton<IStartupFilter>(new WrongMachineRoutes())));
        var (company, _, token, _) = await P8.AdminAsync(H);
        var (_, op, _) = await P8.MemberAsync(H, company, "operator");
        var weak = await K.CreateAsync(H, op, "mcp", ["party.read"]);
        var strong = await K.CreateAsync(H, token, "mcp", ["party.read", "bank.manage"]);
        async Task<Res> Rpc(string secret, string method, object? p = null)
        {
            using var req = new HttpRequestMessage(HttpMethod.Post, "/mcp") { Content = JsonContent(new Dictionary<string, object?> { ["jsonrpc"] = "2.0", ["id"] = 1, ["method"] = method, ["params"] = p }) };
            req.Headers.TryAddWithoutValidation("Authorization", "Bearer " + secret);
            using var m = await f.CreateClient().SendAsync(req);
            return new Res(m, await m.Content.ReadAsStringAsync());
        }
        var list = await Rpc(weak.Secret, "tools/list");
        Assert.Equal(["echo", "needs_bank", "whoami"], list.Json.GetProperty("result").GetProperty("tools").EnumerateArray().Select(t => t.GetProperty("name").GetString()!).Order());

        var refused = await Rpc(weak.Secret, "tools/call", new { name = "needs_bank", arguments = new { } });
        Assert.Equal(HttpStatusCode.OK, refused.Status);
        Assert.True(refused.Json.GetProperty("result").GetProperty("isError").GetBoolean());
        Assert.Equal("auth.forbidden", JsonDocument.Parse(Text(refused)).RootElement.GetProperty("code").GetString());
        Assert.Equal(1, await H.ScalarAsync<long>("SELECT count(*) FROM teas.audit_log WHERE company_id = @c AND result = 'rejected' AND client = 'mcp' AND actor_kind = 'agent' AND actor_id = @a", P("c", company), P("a", weak.Id)));

        var ok = await Rpc(strong.Secret, "tools/call", new { name = "needs_bank", arguments = new { } });
        Assert.False(ok.Json.GetProperty("result").GetProperty("isError").GetBoolean());
        Assert.True(JsonDocument.Parse(Text(ok)).RootElement.GetProperty("ok").GetBoolean());
    }

    [Fact]
    public async Task P9aArgumentsThatDoNotBindAreAToolErrorRecordInvalid_AndANotificationIsNeverExecuted()
    {
        using var f = H.Factory.WithWebHostBuilder(b => b.ConfigureServices(s => s.AddSingleton<IStartupFilter>(new WrongMachineRoutes())));
        var (company, _, token, _) = await P8.AdminAsync(H);
        var (_, op, _) = await P8.MemberAsync(H, company, "operator");
        var weak = await K.CreateAsync(H, op, "mcp", ["party.read"]);
        async Task<Res> Rpc(object body)
        {
            using var req = new HttpRequestMessage(HttpMethod.Post, "/mcp") { Content = JsonContent(body) };
            req.Headers.TryAddWithoutValidation("Authorization", "Bearer " + weak.Secret);
            using var m = await f.CreateClient().SendAsync(req);
            return new Res(m, await m.Content.ReadAsStringAsync());
        }
        foreach (var args in new object[] { new { }, new { name = 5 } })
        {
            var bad = await Rpc(new { jsonrpc = "2.0", id = 7, method = "tools/call", @params = new { name = "echo", arguments = args } });
            Assert.Equal((HttpStatusCode.OK, 7, true), (bad.Status, bad.Json.GetProperty("id").GetInt32(), bad.Json.GetProperty("result").GetProperty("isError").GetBoolean()));
            Assert.Equal("record.invalid", JsonDocument.Parse(Text(bad)).RootElement.GetProperty("code").GetString());
        }
        var ok = await Rpc(new { jsonrpc = "2.0", id = 8, method = "tools/call", @params = new { name = "echo", arguments = new { name = "x" } } });
        Assert.False(ok.Json.GetProperty("result").GetProperty("isError").GetBoolean(), ok.Raw);
        // no id = a notification: not executed (needs_bank would leave a rejected row), 202, no body
        var note = await Rpc(new { jsonrpc = "2.0", method = "tools/call", @params = new { name = "needs_bank", arguments = new { } } });
        Assert.Equal((HttpStatusCode.Accepted, ""), (note.Status, note.Raw));
        Assert.Equal(0, await H.ScalarAsync<long>("SELECT count(*) FROM teas.audit_log WHERE company_id = @c AND result = 'rejected'", P("c", company)));
    }

    [Fact]
    public async Task P9bAParameterisedRouteWithAnMcpToolMetadataIsNotAToolAndCannotBeCalled()
    {
        using var f = H.Factory.WithWebHostBuilder(b => b.ConfigureServices(s => s.AddSingleton<IStartupFilter>(new WrongMachineRoutes())));
        var (_, _, token, _) = await P8.AdminAsync(H);
        var mcp = await K.CreateAsync(H, token, "mcp");
        async Task<Res> Rpc(string method, object? p = null)
        {
            using var req = new HttpRequestMessage(HttpMethod.Post, "/mcp") { Content = JsonContent(new Dictionary<string, object?> { ["jsonrpc"] = "2.0", ["id"] = 1, ["method"] = method, ["params"] = p }) };
            req.Headers.TryAddWithoutValidation("Authorization", "Bearer " + mcp.Secret);
            using var m = await f.CreateClient().SendAsync(req);
            return new Res(m, await m.Content.ReadAsStringAsync());
        }
        Assert.DoesNotContain("param_tool", (await Rpc("tools/list")).Raw);
        Assert.Equal(-32602, (await Rpc("tools/call", new { name = "param_tool", arguments = new { } })).Json.GetProperty("error").GetProperty("code").GetInt32());
    }

    [Fact]
    public void P9aAnMcpToolRouteWithPathParametersIsRefusedAtStartup()
    {
        var app = WebApplication.CreateBuilder().Build();
        var spec = new RouteSpec("GET", "/api/v1/x/{id}", "key", Agent: true);
        Assert.Throws<InvalidOperationException>(() => app.MapMachine("rest", spec, [McpTool("x", "y")] (string id) => id));
        app.MapMachine("rest", spec, (string id) => id);   // a plain agent route with a parameter is fine: it is not a tool
    }

    static HttpContent JsonContent(object o) => System.Net.Http.Json.JsonContent.Create(o);

    [Fact]
    public async Task TheMcpHostSpeaksMinimalJsonRpc()
    {
        var (_, _, token, _) = await P8.AdminAsync(H);
        var mcp = (await K.CreateAsync(H, token, "mcp")).Secret;
        var init = await K.RpcAsync(H, mcp, "initialize", new { protocolVersion = "2025-06-18", capabilities = new { }, clientInfo = new { name = "t", version = "1" } });
        var result = init.Json.GetProperty("result");
        Assert.Equal(("2.0", 1, "2025-06-18", "teas"), (init.Str("jsonrpc"), init.Json.GetProperty("id").GetInt32(), result.GetProperty("protocolVersion").GetString(), result.GetProperty("serverInfo").GetProperty("name").GetString()));
        Assert.True(result.GetProperty("capabilities").TryGetProperty("tools", out _));
        Assert.Equal("2025-06-18", (await K.RpcAsync(H, mcp, "initialize", new { protocolVersion = "1999-01-01" })).Json.GetProperty("result").GetProperty("protocolVersion").GetString());   // unknown: our newest
        var note = await K.RpcAsync(H, mcp, "notifications/initialized", notification: true);
        Assert.Equal((HttpStatusCode.Accepted, ""), (note.Status, note.Raw));
        Assert.Equal(JsonValueKind.Object, (await K.RpcAsync(H, mcp, "ping")).Json.GetProperty("result").ValueKind);
        // errors are JSON-RPC errors on a 200, except a body that is not JSON at all
        var unknown = await K.RpcAsync(H, mcp, "resources/list");
        Assert.Equal(-32601, unknown.Json.GetProperty("error").GetProperty("code").GetInt32());
        var noTool = await K.RpcAsync(H, mcp, "tools/call", new { name = "me", arguments = new { } });   // a non-agent route is not a tool
        Assert.Equal(-32602, noTool.Json.GetProperty("error").GetProperty("code").GetInt32());
        Assert.Equal(-32602, (await K.RpcAsync(H, mcp, "tools/call", new { arguments = new { } })).Json.GetProperty("error").GetProperty("code").GetInt32());
        using var raw = new HttpRequestMessage(HttpMethod.Post, "/mcp") { Content = new StringContent("{not json", System.Text.Encoding.UTF8, "application/json") };
        raw.Headers.TryAddWithoutValidation("Authorization", "Bearer " + mcp);
        using var m = await H.Client.SendAsync(raw);
        var parse = new Res(m, await m.Content.ReadAsStringAsync());
        Assert.Equal(-32700, parse.Json.GetProperty("error").GetProperty("code").GetInt32());
        // a batch is not supported (not needed by the 2025-06-18 transport)
        var batch = await K.MachineAsync(H, HttpMethod.Post, "/mcp", mcp, new object[] { new { jsonrpc = "2.0", id = 1, method = "ping" } });
        Assert.Equal(-32600, batch.Json.GetProperty("error").GetProperty("code").GetInt32());
        Assert.Equal(HttpStatusCode.MethodNotAllowed, (await K.MachineAsync(H, HttpMethod.Get, "/mcp", mcp)).Status);
    }
}
