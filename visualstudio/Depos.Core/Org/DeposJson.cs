using System.IO;
using System.Text;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace Depos.Core.Org;

/// <summary>
/// Checks for JSON from Depos: it is untrusted input. A port of
/// <c>src/ext/web/json.ts</c> and the JetBrains <c>DeposJson.kt</c>, with the
/// same limits.
/// </summary>
public static class DeposJson
{
    public const int Text = 100_000;
    public const int Short = 1_000;
    public const int Items = 50_000;

    /// <summary>The parsed body, or null when it is not JSON at all. Dates stay strings.</summary>
    public static JToken? Parse(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        try
        {
            using var reader = new JsonTextReader(new StringReader(text!))
            {
                DateParseHandling = DateParseHandling.None,
                FloatParseHandling = FloatParseHandling.Double,
                MaxDepth = 64,
            };
            var token = JToken.ReadFrom(reader);
            while (reader.Read())
            {
                if (reader.TokenType != JsonToken.Comment) return null;
            }
            return token;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    public static JObject? Obj(JToken? value) => value as JObject;

    /// <summary>A string of at most <paramref name="max"/> characters; null for anything else, a missing key included.</summary>
    public static string? Str(this JObject value, string name, int max = Short) => StringOf(value[name], max);

    /// <summary>A string element, of at most <paramref name="max"/> characters.</summary>
    public static string? StringOf(JToken? value, int max = Short) =>
        value is JValue { Type: JTokenType.String, Value: string text } && text.Length <= max ? text : null;

    public static bool? Bool(this JObject value, string name) =>
        value[name] is JValue { Type: JTokenType.Boolean, Value: bool flag } ? flag : null;

    public static long? Number(this JObject value, string name) => value[name] switch
    {
        JValue { Type: JTokenType.Integer } integer => Convert.ToInt64(integer.Value),
        JValue { Type: JTokenType.Float } real => (long)Convert.ToDouble(real.Value),
        _ => null,
    };

    public static JArray? List(this JObject value, string name) =>
        value[name] is JArray array && array.Count <= Items ? array : null;

    /// <summary>The key is present and holds <c>null</c>, which is not the same as missing.</summary>
    public static bool IsNull(this JObject value, string name) =>
        value.TryGetValue(name, out var token) && token.Type == JTokenType.Null;

    /// <summary>One map key per package: ecosystem and note key.</summary>
    public static string LookupKey(string ecosystem, string noteKey) => ecosystem + "\u0000" + noteKey;

    /// <summary>Compact JSON, as a request body or a file on disk.</summary>
    public static string Write(JToken value) => value.ToString(Formatting.None);
}

/// <summary>URL encodings that match what the VS Code extension sends.</summary>
public static class DeposUri
{
    /// <summary>JavaScript's <c>encodeURIComponent</c>.</summary>
    public static string EncodeComponent(string value) => Encode(value, "-_.!~*'()", spaceAsPlus: false);

    /// <summary><c>URLSearchParams</c> encoding: like a form, spaces as <c>+</c>.</summary>
    public static string EncodeQuery(IEnumerable<KeyValuePair<string, string>> parameters) =>
        string.Join("&", parameters.Select(pair =>
            Encode(pair.Key, "-_.*", spaceAsPlus: true) + "=" + Encode(pair.Value, "-_.*", spaceAsPlus: true)));

    private static string Encode(string value, string unreserved, bool spaceAsPlus)
    {
        var builder = new StringBuilder();
        foreach (var raw in Encoding.UTF8.GetBytes(value))
        {
            var character = (char)raw;
            if (character is >= 'A' and <= 'Z' or >= 'a' and <= 'z' or >= '0' and <= '9' || unreserved.IndexOf(character) >= 0)
                builder.Append(character);
            else if (spaceAsPlus && character == ' ')
                builder.Append('+');
            else
                builder.Append('%').Append(raw.ToString("X2"));
        }
        return builder.ToString();
    }
}
