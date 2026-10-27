using System.Diagnostics;
using System.Text.RegularExpressions;

namespace Teas.Architecture.Tests;

public class ArchitectureTests
{
    static readonly string Backend = FindBackend();

    static string FindBackend()
    {
        var d = new DirectoryInfo(AppContext.BaseDirectory);
        while (d != null && !File.Exists(Path.Combine(d.FullName, "global.json"))) d = d.Parent;
        return d?.FullName ?? throw new InvalidOperationException("backend/global.json not found above " + AppContext.BaseDirectory);
    }

    [Fact]
    public void NoSourceFileOver600LinesWithoutASizeReason()
    {
        var sep = Path.DirectorySeparatorChar;
        var bad = Directory.EnumerateFiles(Backend, "*.cs", SearchOption.AllDirectories)
            .Where(p => !p.Contains($"{sep}obj{sep}") && !p.Contains($"{sep}bin{sep}"))
            .Select(p => (p, lines: File.ReadAllLines(p)))
            .Where(f => f.lines.Length > 600 && !f.lines[0].StartsWith("// size-reason:", StringComparison.Ordinal))
            .Select(f => f.p)
            .ToList();
        Assert.Empty(bad);
    }

    // CANARY: build every real Teas.* project (src AND tests; real Directory.Build.* / .rsp / editorconfig chain, Release
    // as in CI) with one injected file that reads DateTime.Now. If ANY route silences RS0030 for that project, the build
    // succeeds and this fails. The hook in Directory.Build.props only accepts a file under <project>/obj/teas-canary/.
    public static IEnumerable<object[]> Projects() =>
        new[] { "src", "tests" }
            .SelectMany(d => Directory.EnumerateFiles(Path.Combine(Backend, d), "Teas.*.csproj", SearchOption.AllDirectories))
            .Select(p => new object[] { p });

    [Theory]
    [MemberData(nameof(Projects))]
    public void CanaryClockCallFailsTheRealProjectBuild(string proj)
    {
        var name = Path.GetFileNameWithoutExtension(proj);
        var dir = Path.Combine(Path.GetDirectoryName(proj)!, "obj", "teas-canary");
        Directory.CreateDirectory(dir);
        var canary = Path.Combine(dir, "TeasCanary.cs");
        try
        {
            File.WriteAllText(canary, $"namespace {name}; static class TeasCanary {{ public static object X = System.DateTime.Now; }}");
            var (exit, output) = Run("dotnet",
                $"build \"{proj}\" -c Release -nodeReuse:false -p:UseSharedCompilation=false -p:TeasCanaryProject={name} -p:\"TeasCanaryFile={canary}\"", Backend);
            Assert.NotEqual(0, exit);
            Assert.Contains(output.Split((char)10), l => l.Contains("TeasCanary.cs") && l.Contains("error RS0030"));
        }
        finally { try { Directory.Delete(dir, true); } catch (IOException) { } }
    }

    // What the canary cannot see: file-scoped silencing, config text, and anything that mentions the canary hook.
    [Fact]
    public void NoSilencingOutsideTheCanaryHook()
    {
        var sep = Path.DirectorySeparatorChar;
        var programCs = Path.Combine(Backend, "src", "Teas.Api", "Program.cs");
        var rootProps = Path.Combine(Backend, "Directory.Build.props");
        var self = Path.Combine(Backend, "tests", "Teas.Architecture.Tests", "ArchitectureTests.cs");
        const RegexOptions o = RegexOptions.IgnoreCase | RegexOptions.Multiline;
        var bad = new List<string>();
        foreach (var f in Directory.EnumerateFiles(Backend, "*", SearchOption.AllDirectories))
        {
            if (f.Contains($"{sep}obj{sep}") || f.Contains($"{sep}bin{sep}") || f == self) continue;
            var ext = Path.GetExtension(f).ToLowerInvariant();
            var name = Path.GetFileName(f).ToLowerInvariant();
            var text = File.ReadAllText(f);
            var isConfig = name is ".editorconfig" or ".globalconfig" || ext is ".editorconfig" or ".globalconfig"
                           || text.Contains("is_global", StringComparison.OrdinalIgnoreCase);
            var isBuild = ext is ".csproj" or ".props" or ".targets";
            if (ext == ".cs")
            {
                if (Regex.IsMatch(text, @"^[ \t]*#[ \t]*pragma[ \t]+warning[ \t]+disable[ \t]*(//.*)?\r?$", o)) bad.Add(f + ": bare #pragma warning disable");
                if (f != programCs && Regex.IsMatch(text, @"#[ \t]*pragma[ \t]+warning[ \t]+disable[^\n]*RS0030", o)) bad.Add(f + ": RS0030 pragma");
            }
            if ((ext == ".cs" || isBuild) && text.Contains("SuppressMessage", StringComparison.OrdinalIgnoreCase)) bad.Add(f + ": SuppressMessage");
            if (isConfig && Regex.IsMatch(text, @"RS0030|dotnet_analyzer_diagnostic", o)) bad.Add(f + ": RS0030 / dotnet_analyzer_diagnostic in a config file");
            if (f != rootProps && text.Contains("TeasCanary", StringComparison.OrdinalIgnoreCase)) bad.Add(f + ": mentions TeasCanary");
        }
        Assert.Empty(bad);
    }

    // Carry from the P1 review: Program.cs may silence RS0030 exactly once, around exactly one statement that creates the system clock.
    [Fact]
    public void ProgramCsHasExactlyOneRs0030WindowAroundOneSystemClockStatement()
    {
        var text = File.ReadAllText(Path.Combine(Backend, "src", "Teas.Api", "Program.cs"));
        var disables = Regex.Matches(text, @"^[ \t]*#[ \t]*pragma[ \t]+warning[ \t]+disable[^\n]*$", RegexOptions.Multiline);
        var restores = Regex.Matches(text, @"^[ \t]*#[ \t]*pragma[ \t]+warning[ \t]+restore[^\n]*$", RegexOptions.Multiline);
        Assert.Single(disables);
        Assert.Single(restores);
        Assert.Matches(@"RS0030", disables[0].Value);
        Assert.True(disables[0].Index < restores[0].Index, "restore must follow disable");
        var window = text[(disables[0].Index + disables[0].Length)..restores[0].Index];
        Assert.Equal(1, window.Count(ch => ch == ';'));
        Assert.Contains("TimeProvider.System", window);
        Assert.DoesNotMatch(@"Date(Time|TimeOffset)\s*\.\s*(Utc)?(Now|Today)", window);
    }

    // F3: the RLS context is written only by TenantScope.cs (transaction-local set_config); nowhere else in the repo.
    [Fact]
    public void RlsContextIsSetOnlyInTenantScope()
    {
        var sep = Path.DirectorySeparatorChar;
        var allowed = Path.Combine(Backend, "src", "Teas.App", "Platform", "TenantScope.cs");
        var self = Path.Combine(Backend, "tests", "Teas.Architecture.Tests", "ArchitectureTests.cs");
        var repo = Directory.GetParent(Backend)!.FullName;
        var bad = new[] { "backend", "deploy", "tools" }
            .Select(d => Path.Combine(repo, d)).Where(Directory.Exists)
            .SelectMany(d => Directory.EnumerateFiles(d, "*", SearchOption.AllDirectories))
            .Where(f => !f.Contains($"{sep}obj{sep}") && !f.Contains($"{sep}bin{sep}") && !f.Contains($"{sep}node_modules{sep}") && f != allowed && f != self)
            .Where(f => Path.GetExtension(f).ToLowerInvariant() is ".cs" or ".sql" or ".ps1" or ".sh" or ".mjs" or ".json" or ".txt")
            .Where(f => Regex.IsMatch(File.ReadAllText(f), @"set_config|\bSET\s+(LOCAL\s+|SESSION\s+)?app\.", RegexOptions.IgnoreCase))
            .ToList();
        Assert.Empty(bad);
    }

    // SP3 4.3: system scope bypasses the company filter, so it is entered only in Platform/Auth, Platform/Jobs, Platform/Keys and the migrator.
    [Fact]
    public void SystemScopeMachineryIsUsedOnlyFromTheAllowedPlaces()
    {
        var src = Path.Combine(Backend, "src");
        var definition = Path.Combine(src, "Teas.App", "Platform", "TenantScope.cs");
        string[] allowed = ["/Platform/Auth/", "/Platform/Jobs/", "/Platform/Keys/", "/Teas.Migrator/", "/Teas.Api/Startup/StartupGuards.cs"];
        var bad = Directory.EnumerateFiles(src, "*.cs", SearchOption.AllDirectories)
            .Where(f => !f.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}") && f != definition)
            .Where(f => Regex.IsMatch(File.ReadAllText(f), @"\b(EnterSystem|ScopeState|ApplyAsync|ForEachCompanyAsync|SelfTestAsync|Attach)\s*\("))
            .Where(f => !allowed.Any(a => f.Replace('\\', '/').Contains(a)))
            .ToList();
        Assert.Empty(bad);
    }

    // SP3 4.7: every error-code literal in source (thrown TeasException, ErrorCodes lookups, Code properties) is in the registry.
    // Forms: TeasException("x"), ErrorCodes.All["x"], Code => "x", a named `code: "x"` argument, and any `const string N = "a.b"` that looks like a code.
    static readonly Regex CodeLiteral = new(@"(?:\bTeasException\s*\(|ErrorCodes\.All\[|\bCode\s*=>|\bcode:)\s*""([^""]+)""");
    static readonly Regex ConstCodeLike = new(@"\bconst\s+string\s+\w+\s*=\s*""([a-z][a-z0-9_]*\.[a-z0-9_.]+)""");

    static List<string> UnregisteredCodes(string source, ISet<string> registry) =>
        CodeLiteral.Matches(source).Concat(ConstCodeLike.Matches(source)).Select(m => m.Groups[1].Value).Where(c => !registry.Contains(c)).ToList();

    static HashSet<string> Registry() =>
        Regex.Matches(File.ReadAllText(Path.Combine(Backend, "src", "Teas.Domain", "ErrorCodes.cs")), @"\[""([a-z0-9_.]+)""\]\s*=\s*new\(")
            .Select(m => m.Groups[1].Value).ToHashSet();

    [Fact]
    public void EveryErrorCodeLiteralInSourceIsInTheRegistry()
    {
        var registry = Registry();
        Assert.True(registry.Count > 40, "registry parsed: " + registry.Count);
        var sep = Path.DirectorySeparatorChar;
        var bad = Directory.EnumerateFiles(Path.Combine(Backend, "src"), "*.cs", SearchOption.AllDirectories)
            .Where(f => !f.Contains($"{sep}obj{sep}") && !f.Contains($"{sep}bin{sep}"))
            .SelectMany(f => UnregisteredCodes(File.ReadAllText(f), registry).Select(c => f + ": " + c))
            .ToList();
        Assert.Empty(bad);
    }

    [Fact]
    public void TheCodeLiteralScannerFlagsAnUnregisteredCode()
    {
        var registry = new HashSet<string> { "record.not_found" };
        Assert.Equal(["made.up_code"], UnregisteredCodes("throw new TeasException(\"made.up_code\"); throw new TeasException(\"record.not_found\");", registry));
        Assert.Equal(["x.y"], UnregisteredCodes("public string Code => \"x.y\";", registry));
        Assert.Equal(["a.b"], UnregisteredCodes("var c = ErrorCodes.All[\"a.b\"]; var d = ErrorCodes.All[\"record.not_found\"];", registry));
        Assert.Equal(["c.d"], UnregisteredCodes("Fail(code: \"c.d\", detail: \"x\");", registry));
        Assert.Equal(["e.f_g"], UnregisteredCodes("const string Missing = \"e.f_g\"; const string Path = \"/internal/v1\"; const string Ok = \"record.not_found\";", registry));
    }

    // SP3 4.6 / P5: every contract route is registered through RouteBuilder.MapRoute, which carries its RouteSpec (public / session / a permission),
    // and the route guards are wired into the pipeline. A raw Map* call is an undeclared route unless it is one of the probes outside the contract.
    // This scan is a LINT (it does not chase every Map overload). The guarantee is the runtime rule in RouteAuthorization: an endpoint without a
    // RouteSpec and without the Probe marker is refused, wherever it is mapped (integration test EnforcementFollowsTheMetadataNotThePath).
    static readonly Regex RawMap = new(@"\.Map(Get|Post|Put|Delete|Patch|Methods|Fallback)\s*\(\s*(""[^""]*"")?");
    static readonly string[] Probes = ["\"/health/live\"", "\"/health/ready\"", "\"/version\""];

    static List<string> UndeclaredRoutes(string source) =>
        RawMap.Matches(source).Select(m => m.Value).Where(v => !Probes.Any(v.Contains)).ToList();

    [Fact]
    public void EveryRouteIsDeclaredAndRouteAuthorizationIsWiredIn()
    {
        var sep = Path.DirectorySeparatorChar;
        var api = Path.Combine(Backend, "src", "Teas.Api");
        var builder = Path.Combine(api, "Routing", "RouteSpec.cs");
        var bad = Directory.EnumerateFiles(api, "*.cs", SearchOption.AllDirectories)
            .Where(f => !f.Contains($"{sep}obj{sep}") && !f.Contains($"{sep}bin{sep}") && f != builder)
            .SelectMany(f => UndeclaredRoutes(File.ReadAllText(f)).Select(v => f + ": " + v))
            .ToList();
        Assert.Empty(bad);
        Assert.Contains("MapRoute(", File.ReadAllText(Path.Combine(api, "Program.cs")));
        var program = File.ReadAllText(Path.Combine(api, "Program.cs"));
        Assert.Matches(@"(?m)^app\.UseTeasRouteGuards\(\);", program);   // unconditional: at column 0, not under an if
        Assert.True(Regex.Matches(program, @"WithMetadata\(Probe\.Marker\)").Count >= 3, "health live, ready and version carry the Probe marker");
    }

    [Fact]
    public void TheRouteScannerFlagsARawMapCallButNotAProbe()
    {
        Assert.Equal([".MapGet(\"/internal/v1/x\""], UndeclaredRoutes("g.MapGet(\"/internal/v1/x\", () => 1); app.MapGet(\"/health/live\", () => 2);"));
        Assert.Equal([".MapPost(\"/api/v1/y\""], UndeclaredRoutes("app.MapPost(\"/api/v1/y\", H); app.MapGet(\"/version\", V); g.MapRoute(spec, H);"));
        Assert.Equal([".MapMethods("], UndeclaredRoutes("g.MapMethods(path, [m], h);"));
    }

    [Fact]
    public void ControlSnippetBuilds()
    {
        var clean = Build("var x = 1; _ = x;");
        Assert.True(clean.exit == 0, "control snippet must build: " + clean.output);
    }

    // One case per line of BannedSymbols.txt ("P:System.DateTime.Now;reason" -> System.DateTime.Now).
    public static IEnumerable<object[]> BannedSymbols() =>
        File.ReadAllLines(Path.Combine(Backend, "BannedSymbols.txt"))
            .Where(l => l.Length > 0)
            .Select(l => new object[] { l[2..l.IndexOf(';')] });

    [Fact]
    public void BannedSymbolsFileHasTheSixClockSymbols() => Assert.Equal(6, BannedSymbols().Count());

    [Theory]
    [MemberData(nameof(BannedSymbols))]
    public void ABannedClockCallFailsTheBuild(string symbol)
    {
        var planted = Build($"_ = {symbol};");
        Assert.NotEqual(0, planted.exit);
        Assert.Contains("RS0030", planted.output);
    }

    // The analyzer and the banned list must reach every Teas.* project (evaluated items, not a text grep).
    [Fact]
    public void EveryProjectEvaluatesTheAnalyzerAndTheBannedList()
    {
        var projects = Directory.EnumerateFiles(Backend, "Teas.*.csproj", SearchOption.AllDirectories).ToList();
        Assert.True(projects.Count >= 7, "expected the 7 Teas projects, found " + projects.Count);
        foreach (var proj in projects)
        {
            var (exit, output) = Run("dotnet", $"msbuild \"{proj}\" -getItem:PackageReference -getItem:AdditionalFiles", Backend);
            Assert.True(exit == 0, proj + ": " + output);
            Assert.Contains("\"Microsoft.CodeAnalysis.BannedApiAnalyzers\"", output);
            Assert.Contains("BannedSymbols.txt", output);
        }
    }

    // Builds a throwaway project that uses the real BannedSymbols.txt and the pinned analyzer version.
    static (int exit, string output) Build(string statement)
    {
        var version = Regex.Match(
            File.ReadAllText(Path.Combine(Backend, "Directory.Packages.props")),
            "BannedApiAnalyzers\" Version=\"([^\"]+)\"").Groups[1].Value;
        var dir = Directory.CreateTempSubdirectory("teas-banned-").FullName;
        try
        {
            File.Copy(Path.Combine(Backend, "BannedSymbols.txt"), Path.Combine(dir, "BannedSymbols.txt"));
            File.WriteAllText(Path.Combine(dir, "Scratch.csproj"), $"""
                <Project Sdk="Microsoft.NET.Sdk">
                  <PropertyGroup><TargetFramework>net10.0</TargetFramework><TreatWarningsAsErrors>true</TreatWarningsAsErrors></PropertyGroup>
                  <ItemGroup>
                    <PackageReference Include="Microsoft.CodeAnalysis.BannedApiAnalyzers" Version="{version}" PrivateAssets="all" />
                    <AdditionalFiles Include="BannedSymbols.txt" />
                  </ItemGroup>
                </Project>
                """);
            File.WriteAllText(Path.Combine(dir, "C.cs"), "class C { void M() { " + statement + " } }");
            return Run("dotnet", "build -nodeReuse:false -p:UseSharedCompilation=false", dir);
        }
        finally { try { Directory.Delete(dir, true); } catch (IOException) { } }
    }

    static (int exit, string output) Run(string file, string args, string dir)
    {
        var psi = new ProcessStartInfo(file, args) { WorkingDirectory = dir, RedirectStandardOutput = true, RedirectStandardError = true };
        using var p = Process.Start(psi)!;
        var err = p.StandardError.ReadToEndAsync();
        var output = p.StandardOutput.ReadToEnd() + err.Result;
        p.WaitForExit();
        return (p.ExitCode, output);
    }
}
