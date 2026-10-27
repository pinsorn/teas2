namespace Teas.Domain;

/// <summary>A calendar date in Asia/Bangkok (UTC+7, no DST). The only way to ask "what day is it".</summary>
public readonly record struct BusinessDate(DateOnly Value)
{
    static readonly TimeZoneInfo Bangkok = TimeZoneInfo.FindSystemTimeZoneById("Asia/Bangkok");

    public static BusinessDate Today(TimeProvider clock) =>
        new(DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(clock.GetUtcNow(), Bangkok).DateTime));

    public override string ToString() => Value.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture);
}
