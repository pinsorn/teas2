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
    public void ABannedClockCallFailsTheBuild()
    {
        var clean = Build("var x = 1; _ = x;");
        Assert.True(clean.exit == 0, "control snippet must build: " + clean.output);

        var planted = Build("_ = System.DateTime.Now;");
        Assert.NotEqual(0, planted.exit);
        Assert.Contains("RS0030", planted.output);
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
            var psi = new ProcessStartInfo("dotnet", "build -nodeReuse:false -p:UseSharedCompilation=false")
            { WorkingDirectory = dir, RedirectStandardOutput = true, RedirectStandardError = true };
            using var p = Process.Start(psi)!;
            var output = p.StandardOutput.ReadToEnd() + p.StandardError.ReadToEnd();
            p.WaitForExit();
            return (p.ExitCode, output);
        }
        finally { try { Directory.Delete(dir, true); } catch (IOException) { } }
    }
}
