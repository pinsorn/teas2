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

    // CANARY: build every real src project (real Directory.Build.* / .rsp / editorconfig chain) with one injected
    // file that reads DateTime.Now. If ANY route silences RS0030 for that project, the build succeeds and this fails.
    public static IEnumerable<object[]> SrcProjects() =>
        Directory.EnumerateFiles(Path.Combine(Backend, "src"), "Teas.*.csproj", SearchOption.AllDirectories)
            .Select(p => new object[] { p });

    [Theory]
    [MemberData(nameof(SrcProjects))]
    public void CanaryClockCallFailsTheRealProjectBuild(string proj)
    {
        var name = Path.GetFileNameWithoutExtension(proj);
        // Under the project's own obj/ (not compiled by the default glob) so the .editorconfig / .globalconfig chain applies to it.
        var dir = Path.Combine(Path.GetDirectoryName(proj)!, "obj");
        Directory.CreateDirectory(dir);
        var canary = Path.Combine(dir, "TeasCanary.cs");
        try
        {
            File.WriteAllText(canary, $"namespace {name}; static class TeasCanary {{ public static object X = System.DateTime.Now; }}");
            var (exit, output) = Run("dotnet",
                $"build \"{proj}\" -nodeReuse:false -p:UseSharedCompilation=false -p:TeasCanaryProject={name} -p:\"TeasCanaryFile={canary}\"", Backend);
            Assert.NotEqual(0, exit);
            Assert.Contains(output.Split((char)10), l => l.Contains("TeasCanary.cs") && l.Contains("error RS0030"));
        }
        finally { File.Delete(canary); }
    }

    // File-scoped things the canary cannot see. Any SuppressMessage at all is refused (no usage today; stricter than
    // matching RS0030, so string tricks cannot hide it).
    [Fact]
    public void NoFileLocalSilencing()
    {
        var sep = Path.DirectorySeparatorChar;
        var programCs = Path.Combine(Backend, "src", "Teas.Api", "Program.cs");
        var self = Path.Combine(Backend, "tests", "Teas.Architecture.Tests", "ArchitectureTests.cs");
        const RegexOptions o = RegexOptions.IgnoreCase | RegexOptions.Multiline;
        var bad = new List<string>();
        foreach (var f in Directory.EnumerateFiles(Backend, "*.cs", SearchOption.AllDirectories))
        {
            if (f.Contains($"{sep}obj{sep}") || f.Contains($"{sep}bin{sep}") || f == self) continue;
            var text = File.ReadAllText(f);
            if (Regex.IsMatch(text, @"^[ \t]*#[ \t]*pragma[ \t]+warning[ \t]+disable[ \t]*(//.*)?\r?$", o)) bad.Add(f + ": bare #pragma warning disable");
            if (f != programCs && Regex.IsMatch(text, @"#[ \t]*pragma[ \t]+warning[ \t]+disable[^\n]*RS0030", o)) bad.Add(f + ": RS0030 pragma");
            if (Regex.IsMatch(text, @"SuppressMessage", o)) bad.Add(f + ": SuppressMessage");
        }
        Assert.Empty(bad);
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
