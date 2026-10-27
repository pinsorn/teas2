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
