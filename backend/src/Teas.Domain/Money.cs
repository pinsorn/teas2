using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace Teas.Domain;

/// <summary>Thrown when an amount does not fit numeric(18,2). P3 maps <see cref="Code"/> to 422.</summary>
public sealed class MoneyOutOfRangeException() : Exception("Amount exceeds 16 integer digits.")
{
    public string Code => "money.out_of_range";
}

/// <summary>
/// THB amount, always at most 2 dp and at most 16 integer digits (numeric(18,2)). The only way in is
/// <see cref="Of"/> (rounds half away from zero) or <see cref="TryParse"/>; wire form is a JSON string "64200.00".
/// </summary>
[JsonConverter(typeof(MoneyJsonConverter))]
public readonly partial struct Money : IEquatable<Money>
{
    const decimal Limit = 10_000_000_000_000_000m; // 10^16

    [GeneratedRegex(@"^-?(0|[1-9][0-9]{0,15})\.[0-9]{2}\z")]
    private static partial Regex Pattern();

    Money(decimal value) => Value = value;

    public decimal Value { get; }

    public static Money Zero => default;

    /// <summary>Rounds half away from zero to 2 dp; throws <see cref="MoneyOutOfRangeException"/> beyond 16 integer digits.</summary>
    public static Money Of(decimal amount)
    {
        var r = Math.Round(amount, 2, MidpointRounding.AwayFromZero);
        if (Math.Abs(r) >= Limit) throw new MoneyOutOfRangeException();
        return new Money(r);
    }

    /// <summary>Never throws. Accepts only canonical text: optional '-' (not for zero), no leading zeros, exactly 2 ASCII decimals.</summary>
    public static bool TryParse(string? s, out Money money)
    {
        money = default;
        if (s is null || !Pattern().IsMatch(s)) return false;
        if (!decimal.TryParse(s, NumberStyles.AllowLeadingSign | NumberStyles.AllowDecimalPoint, CultureInfo.InvariantCulture, out var d)) return false;
        if (d == 0 && s[0] == '-') return false;
        money = new Money(d);
        return true;
    }

    public static Money operator +(Money a, Money b) => Of(a.Value + b.Value);
    public static Money operator -(Money a, Money b) => Of(a.Value - b.Value);
    public static bool operator ==(Money a, Money b) => a.Value == b.Value;
    public static bool operator !=(Money a, Money b) => a.Value != b.Value;

    public bool Equals(Money other) => Value == other.Value;
    public override bool Equals(object? obj) => obj is Money m && Equals(m);
    public override int GetHashCode() => Value.GetHashCode();
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
