using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Teas.Domain;

/// <summary>A calendar date in Thailand (UTC+7). The only way to ask "what day is it". JSON: "yyyy-MM-dd".</summary>
[JsonConverter(typeof(BusinessDateJsonConverter))]
public readonly record struct BusinessDate(DateOnly Value)
{
    // Thailand has had a fixed +07:00 offset with no DST since 1920, so no tz database (identical on Windows and Linux).
    static readonly TimeSpan Offset = TimeSpan.FromHours(7);

    public static BusinessDate Today(TimeProvider clock) =>
        new(DateOnly.FromDateTime(clock.GetUtcNow().ToOffset(Offset).DateTime));

    public override string ToString() => Value.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
}

public sealed class BusinessDateJsonConverter : JsonConverter<BusinessDate>
{
    public override BusinessDate Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        if (reader.TokenType != JsonTokenType.String
            || !DateOnly.TryParseExact(reader.GetString(), "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var d))
            throw new JsonException("BusinessDate must be a string like \"2026-10-28\".");
        return new BusinessDate(d);
    }

    public override void Write(Utf8JsonWriter writer, BusinessDate value, JsonSerializerOptions options) =>
        writer.WriteStringValue(value.ToString());
}
