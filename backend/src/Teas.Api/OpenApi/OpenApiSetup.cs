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
                // an Optional<T> member's own node comes out empty ({}) when seen from the property, so describe it from the parent too
                if (ctx.JsonTypeInfo.Kind == JsonTypeInfoKind.Object && schema.Properties is { } props)
                    foreach (var p in ctx.JsonTypeInfo.Properties)
                        if (IsOptional(p.PropertyType, out var a) && props.TryGetValue(p.Name, out var ps) && ps is OpenApiSchema target)
                            await DescribeOptional(target, a, ctx, ct);
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
        if (inner is OpenApiSchema s)
        {
            schema.Type = (s.Type ?? 0) | JsonSchemaType.Null;
            schema.Format = s.Format;
            schema.Pattern = s.Pattern;
        }
        else schema.OneOf = [new OpenApiSchema { Type = JsonSchemaType.Null }, inner];
    }

    /// <summary>A required member is always written; an Optional is written when set; any other nullable member is omitted when null
    /// (and declared non-nullable in the schema, because the schema must say what is serialized).</summary>
    static void OmitWhenNull(JsonTypeInfo info)
    {
        if (info.Kind != JsonTypeInfoKind.Object) return;
        for (var i = 0; i < info.Properties.Count; i++)
        {
            var p = info.Properties[i];
            if (typeof(IOptional).IsAssignableFrom(p.PropertyType)) { p.ShouldSerialize = (_, v) => v is IOptional { IsSet: true }; continue; }
            if (p.IsRequired || p.AssociatedParameter is { HasDefaultValue: false }) continue;
            if (p.PropertyType.IsValueType && Nullable.GetUnderlyingType(p.PropertyType) is null) continue;
            p.ShouldSerialize = (_, v) => v is not null;
            p.IsGetNullable = false;
            p.IsSetNullable = false;
            // The exporter always wraps Nullable<T> as oneOf [null, T]. A boxed Nullable<T> is a T or null, so describe the member as a plain T.
            if (Nullable.GetUnderlyingType(p.PropertyType) is { } under && p.AssociatedParameter is null && p.AttributeProvider is System.Reflection.PropertyInfo pi)
            {
                var np = info.CreateJsonPropertyInfo(under, p.Name);
                np.Get = o => pi.GetValue(o) ?? Activator.CreateInstance(under); // the typed getter cannot return null for a T; ShouldSerialize hides the placeholder
                np.Set = pi.CanWrite ? pi.SetValue : null;
                np.ShouldSerialize = (o, _) => pi.GetValue(o) is not null;
                np.Order = p.Order; np.IsRequired = false;
                info.Properties[i] = np;
            }
        }
    }
}
