using System.Text.Json.Serialization;
using System.Text.Json.Serialization.Metadata;
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;
using Teas.Api.Problems;
using Teas.Domain;

namespace Teas.Api.OpenApi;

/// <summary>
/// SP3 4.8. One document "v1" = the internal group, with the /internal/v1 prefix stripped so its paths equal the frozen ROUTES.
/// Wire rules (the schema describes exactly what is serialized; the document is not rewritten afterwards):
/// Money is the 2-dp pattern string; enums use their contract strings ([JsonStringEnumMemberName] read by JsonStringEnumConverter);
/// a `required` member is always written (null as null) and stays required in the schema; any other reference / nullable member is
/// omitted when null and its schema says so (not required, no "null"); an optional member whose null means something
/// (absent = unchanged, null = remove) is <see cref="Optional{T}"/>, schema type [null, T], not required.
/// </summary>
public static class OpenApiSetup
{
    public const string Prefix = "/internal/v1";
    public const string MoneyPattern = @"^-?(0|[1-9][0-9]{0,15})\.[0-9]{2}$";

    public static IServiceCollection AddTeasOpenApi(this IServiceCollection services)
    {
        services.ConfigureHttpJsonOptions(o =>
        {
            o.SerializerOptions.Converters.Add(new JsonStringEnumConverter());
            o.SerializerOptions.TypeInfoResolver = (o.SerializerOptions.TypeInfoResolver ?? new DefaultJsonTypeInfoResolver()).WithAddedModifier(OmitWhenNull);
        });
        var omitted = new System.Collections.Concurrent.ConcurrentDictionary<string, System.Collections.Concurrent.ConcurrentBag<string>>(); // component name -> members the serializer omits when null
        return services.AddOpenApi("v1", o =>
        {
            o.ShouldInclude = d => d.RelativePath?.StartsWith(Prefix.TrimStart('/') + "/", StringComparison.Ordinal) == true;
            o.AddSchemaTransformer(async (schema, ctx, ct) =>
            {
                var type = Nullable.GetUnderlyingType(ctx.JsonTypeInfo.Type) ?? ctx.JsonTypeInfo.Type;
                if (type == typeof(Money))
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
                if (IsOptional(type, out var arg)) await DescribeOptional(schema, arg, ctx, ct);
                // Parent-level pass tied to the serializer: what it omits when null is `?: T` (oneOf [null, X] -> X, no null type);
                // an Optional<T> member is described from here too (its own node comes out empty when seen from the property).
                if (ctx.JsonTypeInfo.Kind == JsonTypeInfoKind.Object && schema.Properties is { } props)
                    foreach (var p in ctx.JsonTypeInfo.Properties)
                    {
                        if (!props.TryGetValue(p.Name, out var ps)) continue;
                        if (IsOptional(p.PropertyType, out var a)) { if (ps is OpenApiSchema target) await DescribeOptional(target, a, ctx, ct); }
                        else if (OmitsNull(p)) { props[p.Name] = WithoutNull(ps); omitted.GetOrAdd(ctx.JsonTypeInfo.Type.Name, _ => new()).Add(p.Name); }
                    }
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
                // an enum component is the enum itself: the exporter lists null in it when the first use was Enum?, but nullability lives on the member
                foreach (var comp in doc.Components.Schemas.Values.OfType<OpenApiSchema>())
                    if (comp.Enum is { Count: > 0 } en && en.Any(x => x is null || x.GetValueKind() == System.Text.Json.JsonValueKind.Null))
                    {
                        comp.Enum = en.Where(x => x is not null && x.GetValueKind() != System.Text.Json.JsonValueKind.Null).ToList();
                        comp.Type = comp.Type is { } ctype ? ctype & ~JsonSchemaType.Null : null;
                    }
                // the oneOf [null, X] wrapper for ref-typed members is added after the schema transformers ran, so the unwrap is repeated here
                foreach (var (name, comp) in doc.Components.Schemas)
                    if (comp is OpenApiSchema { Properties: { } cp } && omitted.TryGetValue(name, out var names))
                        foreach (var n in names) if (cp.TryGetValue(n, out var v)) cp[n] = WithoutNull(v);
            });
        });
    }


    static bool IsOptional(Type t, out Type arg)
    {
        arg = t;
        if (!t.IsGenericType || t.GetGenericTypeDefinition() != typeof(Optional<>)) return false;
        arg = t.GetGenericArguments()[0];
        return true;
    }

    static async Task DescribeOptional(OpenApiSchema schema, Type arg, OpenApiSchemaTransformerContext ctx, CancellationToken ct)
    {
        var inner = await ctx.GetOrCreateSchemaAsync(arg, null, ct);
        schema.Properties?.Clear();
        // a plain primitive folds the null into its type; an enum, object or $ref stays whole: oneOf [null, inner]
        if (inner is OpenApiSchema { Type: { } t } s && s.Enum is not { Count: > 0 } && s.Properties is not { Count: > 0 } && s.OneOf is null && s.AnyOf is null && s.AllOf is null)
        {
            schema.OneOf = null;
            schema.Type = t | JsonSchemaType.Null;
            schema.Format = s.Format;
            schema.Pattern = s.Pattern;
        }
        else
        {
            schema.Type = null;
            schema.OneOf = [new OpenApiSchema { Type = JsonSchemaType.Null }, inner];
        }
    }

    static IOpenApiSchema WithoutNull(IOpenApiSchema s)
    {
        if (s.OneOf is { Count: 2 } one && one.FirstOrDefault(x => x.Type == JsonSchemaType.Null) is { } nul) return one.First(x => x != nul);
        if (s is OpenApiSchema { Type: { } t } plain)
        {
            if (t.HasFlag(JsonSchemaType.String) && (t.HasFlag(JsonSchemaType.Integer) || t.HasFlag(JsonSchemaType.Number))) { t &= ~JsonSchemaType.String; plain.Pattern = null; }
            plain.Type = t & ~JsonSchemaType.Null;
        }
        return s;
    }

    /// <summary>One rule for the serializer and the schema: a member that is not required, not Optional and can be null is omitted when null.</summary>
    static bool OmitsNull(JsonPropertyInfo p) =>
        !typeof(IOptional).IsAssignableFrom(p.PropertyType)
        && !(p.IsRequired || p.AssociatedParameter is { HasDefaultValue: false })
        && !(p.PropertyType.IsValueType && Nullable.GetUnderlyingType(p.PropertyType) is null);

    /// <summary>A required member is always written; an Optional is written when set (and may not be `required`); any other nullable member
    /// is omitted when null, and the schema (see the transformer) says `?: T` for it.</summary>
    static void OmitWhenNull(JsonTypeInfo info)
    {
        if (info.Kind != JsonTypeInfoKind.Object) return;
        foreach (var p in info.Properties)
        {
            if (typeof(IOptional).IsAssignableFrom(p.PropertyType))
            {
                if (p.IsRequired) throw new InvalidOperationException($"{info.Type.Name}.{p.Name}: Optional<T> cannot be a required member.");
                p.ShouldSerialize = (_, v) => v is IOptional { IsSet: true };
            }
            else if (OmitsNull(p))
            {
                p.ShouldSerialize = (_, v) => v is not null;
                p.IsGetNullable = false;
                p.IsSetNullable = false;
            }
        }
    }
}
