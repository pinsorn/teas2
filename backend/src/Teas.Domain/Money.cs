using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace Teas.Domain;

/// <summary>THB amount. Wire form is a JSON string with exactly two decimals ("64200.00"); never a number.</summary>
[JsonConverter(typeof(MoneyJsonConverter))]
public readonly partial record struct Money(decimal Value)
{
    [GeneratedRegex(@"^-?\d+\.\d{2}$")]
    private static partial Regex Pattern();

    /// <summary>Rounds half away from zero to 2 dp.</summary>
    public static Money Of(decimal amount) => new(Math.Round(amount, 2, MidpointRounding.AwayFromZero));

    public static bool TryParse(string? s, out Money money)
    {
        money = default;
        if (s is null || !Pattern().IsMatch(s)) return false;
        money = new Money(decimal.Parse(s, NumberStyles.AllowLeadingSign | NumberStyles.AllowDecimalPoint, CultureInfo.InvariantCulture));
        return true;
    }

    public override string ToString() => Value.ToString("F2", CultureInfo.InvariantCulture);
}

public sealed class MoneyJsonConverter : JsonConverter<Money>
{
    public override Money Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        if (reader.TokenType != JsonTokenType.String || !Money.TryParse(reader.GetString(), out var m))
            throw new JsonException("Money must be a string with exactly two decimals, e.g. \"64200.00\".");
        return m;
    }

    public override void Write(Utf8JsonWriter writer, Money value, JsonSerializerOptions options) =>
        writer.WriteStringValue(value.ToString());
}
