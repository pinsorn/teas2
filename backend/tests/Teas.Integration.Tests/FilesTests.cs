using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Time.Testing;
using Teas.App;
using Teas.App.Platform;
using Teas.App.Platform.Files;
using Teas.Domain;
using Teas.Integration.Tests.Harness;

namespace Teas.Integration.Tests;

// SP3 4.7 Files (P6): the type is decided by the magic bytes alone, SVG never, <= 1 MB, and a file belongs to its company (RLS).
public sealed class FilesTests : IAsyncLifetime
{
    DbClone _db = null!;
    ServiceProvider _sp = null!;
    string _dir = null!;

    public async Task InitializeAsync()
    {
        _db = await TestDb.CloneAsync();
        _dir = Path.Combine(Path.GetTempPath(), "teas-files-" + Guid.NewGuid().ToString("N"));   // never the configured root
        var s = new ServiceCollection();
        s.AddSingleton<TimeProvider>(new FakeTimeProvider());
        s.AddSingleton(new FileStoreOptions(_dir));
        s.AddTeasData(_db.AppCs);
        _sp = s.BuildServiceProvider();
    }

    public async Task DisposeAsync()
    {
        await _sp.DisposeAsync();
        await _db.DisposeAsync();
        if (Directory.Exists(_dir)) Directory.Delete(_dir, true);
    }

    static readonly byte[] Png = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0x0D, .. "IHDR"u8, 1, 2, 3, 4];
    static readonly byte[] Jpeg = [0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10, 0x4A, 0x46, 0x49, 0x46];
    static readonly byte[] Webp = [.. "RIFF"u8, 0x0C, 0, 0, 0, .. "WEBPVP8 "u8, 1, 2, 3, 4];
    static readonly byte[] Svg = "<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>"u8.ToArray();

    // each call = one request: its own DI scope, its own TenantScope
    async Task<T> InCompany<T>(Guid company, Func<IFileStore, Task<T>> work)
    {
        await using var sc = _sp.CreateAsyncScope();
        using var _ = sc.ServiceProvider.GetRequiredService<TenantScope>().Enter(company, Guid.NewGuid());
        return await work(sc.ServiceProvider.GetRequiredService<IFileStore>());
    }

    public static TheoryData<string, string, string> Accepted() => new()
    {
        { "png", "logo.png", "image/png" },
        { "jpeg", "photo.jpg", "image/jpeg" },
        { "webp", "pic.webp", "image/webp" },
        { "png", "wrong-extension.txt", "image/png" },   // the name never decides
    };

    static byte[] Bytes(string kind) => kind switch { "png" => Png, "jpeg" => Jpeg, _ => Webp };

    [Theory]
    [MemberData(nameof(Accepted))]
    public async Task PngJpegWebpAreAcceptedByMagicBytesAndRoundTrip(string kind, string name, string mime)
    {
        var company = await PlatformTestHost.NewCompanyAsync(_db);
        var bytes = Bytes(kind);
        var file = await InCompany(company, s => s.PutAsync(company, new MemoryStream(bytes), name));
        Assert.Equal(mime, file.Mime);
        Assert.Equal(bytes.Length, file.SizeBytes);
        Assert.Equal(1, await PlatformTestHost.CountAsync(_db, "files", $"id = '{file.Id}' AND mime = '{mime}' AND size_bytes = {bytes.Length}"));
        var back = await InCompany(company, async s =>
        {
            await using var o = await s.OpenAsync(company, file.Id);
            var ms = new MemoryStream();
            await o.Content.CopyToAsync(ms);
            return ms.ToArray();
        });
        Assert.Equal(bytes, back);
    }

    [Theory]
    [InlineData("logo.svg", "svg")]
    [InlineData("logo.png", "svg")]        // an SVG renamed .png
    [InlineData("logo.svg", "notpng")]     // not a PNG, renamed .svg
    [InlineData("logo.png", "notpng")]     // not a PNG, named .png
    [InlineData("empty.png", "empty")]
    [InlineData("riff.webp", "riffnotwebp")]
    [InlineData("a.jpg", "jpeg3")]         // a bare FF D8 FF is not a JPEG
    [InlineData("a.png", "pngsvg")]        // PNG signature, then an SVG
    [InlineData("a.webp", "riffbogus")]    // RIFF/WEBP/VP8 with a size field that does not match
    public async Task SvgAndAnythingWithoutMagicBytesIsRefusedWhateverTheName(string name, string kind)
    {
        var company = await PlatformTestHost.NewCompanyAsync(_db);
        var bytes = kind switch
        {
            "svg" => Svg,
            "notpng" => [0x89, 0x50, 0x4E, 0x58, 0x0D, 0x0A, 0x1A, 0x0A, 9],
            "riffnotwebp" => [.. "RIFF"u8, 0, 0, 0, 0, .. "WAVEfmt "u8],
            "jpeg3" => [0xFF, 0xD8, 0xFF],
            "pngsvg" => [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, .. "<svg>"u8],
            "riffbogus" => [.. "RIFF"u8, 0xFF, 0xFF, 0, 0, .. "WEBPVP8 "u8, 1, 2, 3, 4],
            _ => Array.Empty<byte>(),
        };
        var e = await Assert.ThrowsAsync<TeasException>(() => InCompany(company, s => s.PutAsync(company, new MemoryStream(bytes), name)));
        Assert.Equal("record.invalid", e.Code);
        Assert.Equal(0, await PlatformTestHost.CountAsync(_db, "files"));
        Assert.False(Directory.Exists(_dir) && Directory.EnumerateFiles(_dir, "*", SearchOption.AllDirectories).Any());   // nothing on disk either
    }

    [Fact]
    public async Task OverOneMegabyteIsRefusedExactlyOneMegabyteIsAccepted()
    {
        var company = await PlatformTestHost.NewCompanyAsync(_db);
        byte[] Sized(int n) { var b = new byte[n]; Png.CopyTo(b, 0); return b; }
        var ok = await InCompany(company, s => s.PutAsync(company, new MemoryStream(Sized(1_048_576)), "max.png"));
        Assert.Equal(1_048_576, ok.SizeBytes);
        var e = await Assert.ThrowsAsync<TeasException>(() => InCompany(company, s => s.PutAsync(company, new MemoryStream(Sized(1_048_577)), "big.png")));
        Assert.Equal("record.invalid", e.Code);
        Assert.Equal(1, await PlatformTestHost.CountAsync(_db, "files"));
    }

    [Fact]
    public async Task AFileOfCompanyAIsInvisibleUnderCompanyB()
    {
        var a = await PlatformTestHost.NewCompanyAsync(_db);
        var b = await PlatformTestHost.NewCompanyAsync(_db);
        var file = await InCompany(a, s => s.PutAsync(a, new MemoryStream(Png), "a.png"));
        // B asks for A's file by A's company id (RLS hides the row) and by its own company id (the row is not B's)
        foreach (var asked in new[] { a, b })
        {
            var e = await Assert.ThrowsAsync<TeasException>(() => InCompany(b, s => s.OpenAsync(asked, file.Id)));
            Assert.Equal("record.not_found", e.Code);
        }
        await using var own = await InCompany(a, s => s.OpenAsync(a, file.Id));
        Assert.Equal("image/png", own.File.Mime);
    }

    [Fact]
    public async Task PutForAnotherCompanyThanTheScopeIsAProgrammingError()
    {
        var a = await PlatformTestHost.NewCompanyAsync(_db);
        var b = await PlatformTestHost.NewCompanyAsync(_db);
        await Assert.ThrowsAsync<InvalidOperationException>(() => InCompany(a, s => s.PutAsync(b, new MemoryStream(Png), "x.png")));
        Assert.Equal(0, await PlatformTestHost.CountAsync(_db, "files"));
    }
}
