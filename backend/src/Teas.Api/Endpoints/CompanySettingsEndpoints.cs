using System.Text.Json;
using Microsoft.Extensions.Options;
using Teas.Api.OpenApi;
using Teas.Api.Routing;
using Teas.App.Platform.Companies;
using Teas.Domain;

namespace Teas.Api.Endpoints;

// ---- request bodies with an Optional<T> member (absent = keep, null = remove) are API types; the rest are the App records ----
public sealed record CompanyImagesBody
{
    public required int Version { get; init; }
    public Optional<string?> LogoDataUrl { get; init; }
    public Optional<string?> StampDataUrl { get; init; }
}

/// <summary>Documents route 18's request, Company&lt;Section&gt;Body = one of these six by the {section} in the path; never instantiated.</summary>
[OneOf(typeof(CompanyIdentityBody), typeof(CompanyContactBody), typeof(CompanyPayrollBody), typeof(CompanyFiscalBody), typeof(CompanyImagesBody), typeof(CompanyNotesBody))]
public sealed class CompanySectionBody;

/// <summary>Routes 17-19.</summary>
public static class CompanySettingsEndpoints
{
    static readonly string[] Sections = ["identity", "contact", "payroll", "fiscal", "images", "notes"];

    static TeasException Bad() => new("record.invalid");

    /// <summary>
    /// Parses the section's body by hand: the section in the path decides which shape it is. A wrong content type, a body that is not JSON of that shape and a
    /// missing member all render 422 record.invalid (the contract has no 400 / 415). Also reports `vatRegistered` when the client sent it: the VAT status is
    /// read-only here, and a client that sends a different one is told so instead of having it silently ignored.
    /// </summary>
    static async Task<(object Body, bool? Vat)> ReadAsync(HttpContext h, string section)
    {
        if (!h.Request.HasJsonContentType()) throw Bad();
        var options = h.RequestServices.GetRequiredService<IOptions<Microsoft.AspNetCore.Http.Json.JsonOptions>>().Value.SerializerOptions;
        try
        {
            using var doc = await JsonDocument.ParseAsync(h.Request.Body, cancellationToken: h.RequestAborted);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) throw Bad();
            bool? vat = null;
            if (root.TryGetProperty("vatRegistered", out var v) && v.ValueKind != JsonValueKind.Null)
                vat = v.ValueKind is JsonValueKind.True or JsonValueKind.False ? v.GetBoolean() : throw Bad();
            object body = section switch
            {
                "identity" => root.Deserialize<CompanyIdentityBody>(options)!,
                "contact" => root.Deserialize<CompanyContactBody>(options)!,
                "payroll" => root.Deserialize<CompanyPayrollBody>(options)!,
                "fiscal" => root.Deserialize<CompanyFiscalBody>(options)!,
                "notes" => root.Deserialize<CompanyNotesBody>(options)!,
                _ => Images(root.Deserialize<CompanyImagesBody>(options)!),
            };
            return (body, vat);
        }
        catch (JsonException) { throw Bad(); }
    }

    static CompanyImagesChange Images(CompanyImagesBody i) =>
        new(i.Version, new ImageChange(i.LogoDataUrl.IsSet, i.LogoDataUrl.Value), new ImageChange(i.StampDataUrl.IsSet, i.StampDataUrl.Value));

    public static void MapCompanySettingsRoutes(this IEndpointRouteBuilder g)
    {
        g.MapRoute(new RouteSpec("GET", "/settings/companies/{id}", "session", "settings.manage"),
            (string id, HttpContext h) => Ep.Svc<CompanyService>(h).GetAsync(id, Ep.Ct(h)));

        g.MapRoute(new RouteSpec("PUT", "/settings/companies/{id}/{section}", "session", "settings.manage", Concurrency: "version-body", Audit: "company.update.<section>"),
            async (string id, string section, HttpContext h) =>
            {
                if (!Sections.Contains(section)) throw new TeasException("company.section_unknown");
                var (body, vat) = await ReadAsync(h, section);
                return Results.Ok(await Ep.Svc<CompanyService>(h).UpdateAsync(id, section, body, vat, Ep.Ct(h)));
            }).Accepts<CompanySectionBody>("application/json").Produces<CompanySettingsView>();

        g.MapRoute(new RouteSpec("GET", "/settings/default-notes", "session", Agent: true),
            (HttpContext h) => Ep.Svc<CompanyService>(h).DefaultNotesAsync(Ep.Ct(h)));
    }
}
