using System.Text.Json.Serialization;
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;
using Teas.Api.Problems;
using Teas.Domain;

namespace Teas.Api.OpenApi;

/// <summary>
/// SP3 4.8. One document "v1" = the internal group, with the /internal/v1 prefix stripped so its paths equal the frozen ROUTES.
/// Wire rules: Money is the 2-dp pattern string; enums use their contract strings ([JsonStringEnumMemberName] on the members, read by
/// JsonStringEnumConverter); an optional member is C# nullable + omitted when null, so it is not required and its schema has no "null".
/// </summary>
public static class OpenApiSetup
{
    public const string Prefix = "/internal/v1";
    public const string MoneyPattern = @"^-?(0|[1-9][0-9]{0,15})\.[0-9]{2}$";

    public static IServiceCollection AddTeasOpenApi(this IServiceCollection services)
    {
        services.ConfigureHttpJsonOptions(o =>
        {
            o.SerializerOptions.DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull;
            o.SerializerOptions.Converters.Add(new JsonStringEnumConverter());
        });
        return services.AddOpenApi("v1", o =>
        {
            o.ShouldInclude = d => d.RelativePath?.StartsWith(Prefix.TrimStart('/') + "/", StringComparison.Ordinal) == true;
            o.AddSchemaTransformer((schema, ctx, _) =>
            {
                if ((Nullable.GetUnderlyingType(ctx.JsonTypeInfo.Type) ?? ctx.JsonTypeInfo.Type) == typeof(Money))
                {
                    schema.Type = JsonSchemaType.String;
                    schema.Pattern = MoneyPattern;
                    schema.Properties?.Clear();
                }
                // numbers are numbers on the wire (the web defaults also read them from strings, which the exporter advertises)
                if (schema.Type is { } nt && nt.HasFlag(JsonSchemaType.String) && (nt.HasFlag(JsonSchemaType.Integer) || nt.HasFlag(JsonSchemaType.Number)))
                {
                    schema.Type = nt & ~JsonSchemaType.String;
                    schema.Pattern = null;
                }
                return Task.CompletedTask;
            });
            o.AddDocumentTransformer(async (doc, ctx, ct) =>
            {
                var paths = new OpenApiPaths();
                foreach (var (path, item) in doc.Paths)
                    paths[path.StartsWith(Prefix, StringComparison.Ordinal) ? path[Prefix.Length..] : path] = item;
                doc.Paths = paths;
                doc.Components ??= new OpenApiComponents();
                doc.Components.Schemas ??= new Dictionary<string, IOpenApiSchema>();
                doc.Components.Schemas["Money"] = await ctx.GetOrCreateSchemaAsync(typeof(Money), null, ct);
                doc.Components.Schemas["ApiProblem"] = await ctx.GetOrCreateSchemaAsync(typeof(ApiProblem), null, ct);
                foreach (var s in doc.Components.Schemas.Values.OfType<OpenApiSchema>()) StripNullFromOptionalMembers(s);
            });
        });
    }

    // An optional (= not required) member is absent on the wire, never null: "type":[null,X] -> X and oneOf [null, X] -> X.
    static void StripNullFromOptionalMembers(OpenApiSchema schema)
    {
        if (schema.Properties is not { Count: > 0 }) return;
        foreach (var (name, prop) in schema.Properties.ToList())
        {
            if (schema.Required?.Contains(name) == true) continue;
            if (prop is OpenApiSchema p && p.Type is { } t && t.HasFlag(JsonSchemaType.Null))
                p.Type = t & ~JsonSchemaType.Null;
            else if (prop.OneOf is { Count: 2 } one && one.FirstOrDefault(x => x.Type == JsonSchemaType.Null) is { } nul)
                schema.Properties[name] = one.First(x => x != nul);
        }
    }
}
