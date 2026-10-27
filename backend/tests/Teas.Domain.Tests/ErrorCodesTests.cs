using System.Text.RegularExpressions;

namespace Teas.Domain.Tests;

public class ErrorCodesTests
{
    // Backend-only codes the frozen frontend table does not list (money.out_of_range is thrown by Money.Of, SP3 P3).
    static readonly Dictionary<string, int> BackendOnly = new() { ["money.out_of_range"] = 422 };

    static string FrozenTs()
    {
        var d = new DirectoryInfo(AppContext.BaseDirectory);
        while (d != null && !File.Exists(Path.Combine(d.FullName, "global.json"))) d = d.Parent;
        return File.ReadAllText(Path.Combine(d!.Parent!.FullName, "frontend", "src", "contract", "platform.ts"));
    }

    [Fact]
    public void EveryCodeHasThaiAndEnglishTitles()
    {
        Assert.NotEmpty(ErrorCodes.All);
        foreach (var (code, e) in ErrorCodes.All)
        {
            Assert.False(string.IsNullOrWhiteSpace(e.Th), code + " th");
            Assert.False(string.IsNullOrWhiteSpace(e.En), code + " en");
            Assert.Matches("[฀-๿]", e.Th); // the Thai title is actually Thai
        }
    }

    [Fact]
    public void RegistryEqualsTheFrozenFrontendTablePlusTheBackendOnlyCodes()
    {
        var ts = FrozenTs();
        var block = ts[ts.IndexOf("export const ERROR_CODES", StringComparison.Ordinal)..];
        block = block[..block.IndexOf("} as const", StringComparison.Ordinal)];
        var frozen = new Dictionary<string, int[]>();
        foreach (Match m in Regex.Matches(block, @"'([a-z0-9_.]+)':\s*(\[[^\]]*\]|\d+)"))
            frozen[m.Groups[1].Value] = Regex.Matches(m.Groups[2].Value, @"\d+").Select(x => int.Parse(x.Value)).ToArray();
        Assert.True(frozen.Count > 40, "parsed the frozen table: " + frozen.Count);

        var expected = frozen.ToDictionary(kv => kv.Key, kv => kv.Value);
        foreach (var (c, s) in BackendOnly) expected[c] = [s];
        Assert.Equal(expected.Keys.Order(), ErrorCodes.All.Keys.Order());
        foreach (var (code, statuses) in expected)
        {
            var e = ErrorCodes.All[code];
            Assert.Equal(statuses[0], e.Status);
            Assert.Equal(statuses.Length > 1 ? statuses[1] : (int?)null, e.AltStatus);
        }
    }

    [Fact]
    public void MoneyOutOfRangeIsARegisteredTeasExceptionMappedTo422()
    {
        var e = Assert.Throws<MoneyOutOfRangeException>(() => Money.Of(10000000000000000m));
        Assert.IsAssignableFrom<TeasException>(e);
        Assert.Equal(422, ErrorCodes.All[e.Code].Status);
    }

    [Fact]
    public void ATeasExceptionWithAnUnregisteredCodeIsRefused() =>
        Assert.Throws<ArgumentException>(() => new TeasException("nope.not_registered"));
}
