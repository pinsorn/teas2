using System.Security.Cryptography;
using Teas.App.Platform.Concurrency;
using Teas.Domain;

namespace Teas.App.Platform.Files;

public sealed record FileRef(Guid Id, string Mime, long SizeBytes, string Sha256, string Name);

/// <summary>The volume root (TEAS_FILES_DIR). Bytes live at <c>Root/&lt;company&gt;/&lt;sha256&gt;</c>.</summary>
public sealed record FileStoreOptions(string Root);

/// <summary>The opened file: dispose it to close the stream.</summary>
public sealed class OpenedFile(FileRef file, Stream content) : IAsyncDisposable
{
    public FileRef File { get; } = file;
    public Stream Content { get; } = content;
    public ValueTask DisposeAsync() => Content.DisposeAsync();
}

/// <summary>SP3 4.7 Files. Both calls run inside the caller's <see cref="TenantScope"/> (RLS decides who sees a row).</summary>
public interface IFileStore
{
    /// <summary>Stores an image. The type is decided by the content alone (the name and any claimed content type are ignored);
    /// anything that is not PNG / JPEG / WebP (SVG included) or is over 1 MB -> 422 record.invalid.</summary>
    Task<FileRef> PutAsync(Guid companyId, Stream content, string name, CancellationToken ct = default);

    /// <summary>404 record.not_found when the file is not visible to the current scope (another company's file included).</summary>
    Task<OpenedFile> OpenAsync(Guid companyId, Guid id, CancellationToken ct = default);
}

public sealed class FileStore(TeasDbContext db, TenantScope scope, FileStoreOptions options) : IFileStore
{
    public const int MaxBytes = 1_048_576;   // mock MAX_IMAGE_BYTES

    public async Task<FileRef> PutAsync(Guid companyId, Stream content, string name, CancellationToken ct = default)
    {
        if (scope.Current.CompanyId != companyId) throw new InvalidOperationException("Put must run inside TenantScope.Enter(companyId, ...)");
        var buf = new byte[MaxBytes + 1];
        var n = 0;
        while (n < buf.Length && await content.ReadAsync(buf.AsMemory(n), ct) is var read and > 0) n += read;
        if (n > MaxBytes) throw new TeasException("record.invalid", "the file is larger than 1 MB");
        var mime = Sniff(buf.AsSpan(0, n)) ?? throw new TeasException("record.invalid", "the file is not a PNG, JPEG or WebP image");

        var sha = Convert.ToHexStringLower(SHA256.HashData(buf.AsSpan(0, n)));
        var dir = Path.Combine(options.Root, companyId.ToString("D"));
        var path = Path.Combine(dir, sha);
        Directory.CreateDirectory(dir);
        if (!File.Exists(path))   // content-addressed: the same bytes are one blob
        {
            var tmp = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
            await File.WriteAllBytesAsync(tmp, buf.AsMemory(0, n), ct);
            try { File.Move(tmp, path, overwrite: true); } catch { File.Delete(tmp); throw; }
        }

        var file = new FileRef(Guid.NewGuid(), mime, n, sha, Path.GetFileName(name) is { Length: > 0 } f ? f[..Math.Min(f.Length, 255)] : "file");
        var own = db.Database.CurrentTransaction is null;
        await using var tx = own ? await db.Database.BeginTransactionAsync(ct) : null;
        await using (var cmd = TxSql.Cmd(db, """
            INSERT INTO teas.files (company_id, id, sha256, mime, size_bytes, name, created_by) VALUES (@c, @i, @h, @m, @s, @n, @u)
            """, TxSql.P("c", companyId), TxSql.P("i", file.Id), TxSql.P("h", sha), TxSql.P("m", mime), TxSql.P("s", (long)n), TxSql.P("n", file.Name),
            new Npgsql.NpgsqlParameter("u", NpgsqlTypes.NpgsqlDbType.Uuid) { Value = (object?)scope.Current.UserId ?? DBNull.Value }))
            await cmd.ExecuteNonQueryAsync(ct);
        if (tx is not null) await tx.CommitAsync(ct);
        return file;
    }

    public async Task<OpenedFile> OpenAsync(Guid companyId, Guid id, CancellationToken ct = default)
    {
        var own = db.Database.CurrentTransaction is null;
        await using var tx = own ? await db.Database.BeginTransactionAsync(ct) : null;
        FileRef? file = null;
        await using (var cmd = TxSql.Cmd(db, "SELECT sha256, mime, size_bytes, name FROM teas.files WHERE company_id = @c AND id = @i", TxSql.P("c", companyId), TxSql.P("i", id)))
        await using (var r = await cmd.ExecuteReaderAsync(ct))
            if (await r.ReadAsync(ct)) file = new FileRef(id, r.GetString(1), r.GetInt64(2), r.GetString(0), r.GetString(3));
        if (tx is not null) await tx.CommitAsync(ct);
        if (file is null) throw new TeasException("record.not_found");
        var path = Path.Combine(options.Root, companyId.ToString("D"), file.Sha256);
        return new OpenedFile(file, new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 4096, FileOptions.Asynchronous | FileOptions.SequentialScan));
    }

    /// <summary>PNG, JPEG, WebP by signature. SVG is text and never matches.</summary>
    static string? Sniff(ReadOnlySpan<byte> b) =>
        b.StartsWith(new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A }) ? "image/png"
        : b.StartsWith(new byte[] { 0xFF, 0xD8, 0xFF }) ? "image/jpeg"
        : b.Length >= 12 && b[..4].SequenceEqual("RIFF"u8) && b.Slice(8, 4).SequenceEqual("WEBP"u8) ? "image/webp"
        : null;
}
