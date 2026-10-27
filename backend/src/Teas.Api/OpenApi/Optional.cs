using System.Text.Json;
using System.Text.Json.Serialization;

namespace Teas.Api.OpenApi;

public interface IOptional { bool IsSet { get; } }

/// <summary>A request member with three states: absent (IsSet false = unchanged), null (remove), a value. Schema: type [null, T], not required.</summary>
[JsonConverter(typeof(OptionalConverterFactory))]
public readonly struct Optional<T>(T? value) : IOptional
{
    public bool IsSet { get; } = true;   // a default(Optional<T>) is the absent state
    public T? Value { get; } = value;
}

sealed class OptionalConverterFactory : JsonConverterFactory
{
    public override bool CanConvert(Type t) => t.IsGenericType && t.GetGenericTypeDefinition() == typeof(Optional<>);

    public override JsonConverter CreateConverter(Type t, JsonSerializerOptions options) =>
        (JsonConverter)Activator.CreateInstance(typeof(OptionalConverter<>).MakeGenericType(t.GetGenericArguments()[0]))!;
}

sealed class OptionalConverter<T> : JsonConverter<Optional<T>>
{
    public override bool HandleNull => true; // so an explicit null reaches Read (a missing member never calls it)

    public override Optional<T> Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) =>
        reader.TokenType == JsonTokenType.Null ? new Optional<T>(default) : new Optional<T>(JsonSerializer.Deserialize<T>(ref reader, options));

    public override void Write(Utf8JsonWriter writer, Optional<T> value, JsonSerializerOptions options)
    {
        if (value.Value is null) writer.WriteNullValue();
        else JsonSerializer.Serialize(writer, value.Value, options);
    }
}
