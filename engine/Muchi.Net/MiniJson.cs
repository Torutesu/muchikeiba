using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace Muchi.Net
{
    public enum JsonKind { Null, Bool, Number, String, Array, Object }

    /// <summary>
    /// Minimal dependency-free JSON DOM (enough for contracts/protocol.md).
    /// Numbers keep their raw text so 64-bit integers are never rounded.
    /// </summary>
    public sealed class JsonNode
    {
        public JsonKind Kind { get; private set; }
        private bool _bool;
        private string _text; // string value or raw number text
        private List<JsonNode> _items;
        private List<KeyValuePair<string, JsonNode>> _props;

        public static JsonNode Null() => new JsonNode { Kind = JsonKind.Null };
        public static JsonNode Bool(bool b) => new JsonNode { Kind = JsonKind.Bool, _bool = b };
        public static JsonNode Num(long v) => new JsonNode { Kind = JsonKind.Number, _text = v.ToString(CultureInfo.InvariantCulture) };
        public static JsonNode NumRaw(string raw) => new JsonNode { Kind = JsonKind.Number, _text = raw };
        public static JsonNode Str(string s) => s == null ? Null() : new JsonNode { Kind = JsonKind.String, _text = s };
        public static JsonNode Arr() => new JsonNode { Kind = JsonKind.Array, _items = new List<JsonNode>() };
        public static JsonNode Obj() => new JsonNode { Kind = JsonKind.Object, _props = new List<KeyValuePair<string, JsonNode>>() };

        // ---- builders
        public JsonNode Add(JsonNode item) { Require(JsonKind.Array); _items.Add(item); return this; }
        public JsonNode Set(string key, JsonNode value)
        {
            Require(JsonKind.Object);
            for (int i = 0; i < _props.Count; i++)
                if (_props[i].Key == key) { _props[i] = new KeyValuePair<string, JsonNode>(key, value); return this; }
            _props.Add(new KeyValuePair<string, JsonNode>(key, value));
            return this;
        }
        public JsonNode Set(string key, long v) => Set(key, Num(v));
        public JsonNode Set(string key, string v) => Set(key, Str(v));
        public JsonNode Set(string key, bool v) => Set(key, Bool(v));

        // ---- accessors
        public int Count => Kind == JsonKind.Array ? _items.Count : Kind == JsonKind.Object ? _props.Count : 0;
        public JsonNode this[int i] { get { Require(JsonKind.Array); return _items[i]; } }
        public IReadOnlyList<JsonNode> Items { get { Require(JsonKind.Array); return _items; } }
        public IReadOnlyList<KeyValuePair<string, JsonNode>> Props { get { Require(JsonKind.Object); return _props; } }

        public bool Has(string key) => TryGet(key, out _);

        public bool TryGet(string key, out JsonNode value)
        {
            value = null;
            if (Kind != JsonKind.Object) return false;
            foreach (var p in _props)
                if (p.Key == key) { value = p.Value; return true; }
            return false;
        }

        public JsonNode Get(string key)
        {
            if (!TryGet(key, out var v)) throw new FormatException("missing key: " + key);
            return v;
        }

        public bool IsNull => Kind == JsonKind.Null;

        public string AsString()
        {
            if (Kind != JsonKind.String) throw new FormatException("expected string");
            return _text;
        }

        public bool AsBool()
        {
            if (Kind != JsonKind.Bool) throw new FormatException("expected bool");
            return _bool;
        }

        public long AsLong()
        {
            if (Kind != JsonKind.Number) throw new FormatException("expected number");
            if (!long.TryParse(_text, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var v))
                throw new FormatException("expected integer: " + _text);
            return v;
        }

        /// <summary>Raw text of a number exactly as written (e.g. "47.5"), for callers that need non-integers without floats.</summary>
        public string NumberText
        {
            get
            {
                if (Kind != JsonKind.Number) throw new FormatException("expected number");
                return _text;
            }
        }

        public int AsInt()
        {
            long v = AsLong();
            if (v < int.MinValue || v > int.MaxValue) throw new FormatException("integer out of int32 range");
            return (int)v;
        }

        private void Require(JsonKind k)
        {
            if (Kind != k) throw new FormatException("expected " + k + " but was " + Kind);
        }

        // ---- serialization
        public override string ToString()
        {
            var sb = new StringBuilder();
            Write(sb);
            return sb.ToString();
        }

        public void Write(StringBuilder sb)
        {
            switch (Kind)
            {
                case JsonKind.Null: sb.Append("null"); break;
                case JsonKind.Bool: sb.Append(_bool ? "true" : "false"); break;
                case JsonKind.Number: sb.Append(_text); break;
                case JsonKind.String: WriteString(sb, _text); break;
                case JsonKind.Array:
                    sb.Append('[');
                    for (int i = 0; i < _items.Count; i++) { if (i > 0) sb.Append(','); _items[i].Write(sb); }
                    sb.Append(']');
                    break;
                case JsonKind.Object:
                    sb.Append('{');
                    for (int i = 0; i < _props.Count; i++)
                    {
                        if (i > 0) sb.Append(',');
                        WriteString(sb, _props[i].Key);
                        sb.Append(':');
                        _props[i].Value.Write(sb);
                    }
                    sb.Append('}');
                    break;
            }
        }

        public static void WriteString(StringBuilder sb, string s)
        {
            sb.Append('"');
            foreach (char ch in s)
            {
                switch (ch)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    case '\b': sb.Append("\\b"); break;
                    case '\f': sb.Append("\\f"); break;
                    default:
                        if (ch < 0x20) sb.Append("\\u").Append(((int)ch).ToString("x4", CultureInfo.InvariantCulture));
                        else sb.Append(ch);
                        break;
                }
            }
            sb.Append('"');
        }

        // ---- parsing
        public static JsonNode Parse(string text)
        {
            if (text == null) throw new FormatException("null json");
            var p = new Parser(text);
            p.SkipWs();
            var v = p.ParseValue(0);
            p.SkipWs();
            if (!p.End) throw new FormatException("trailing characters at " + p.Pos);
            return v;
        }

        private sealed class Parser
        {
            private readonly string _s;
            public int Pos;
            private const int MaxDepth = 64;

            public Parser(string s) { _s = s; }
            public bool End => Pos >= _s.Length;

            public void SkipWs()
            {
                while (Pos < _s.Length && (_s[Pos] == ' ' || _s[Pos] == '\t' || _s[Pos] == '\n' || _s[Pos] == '\r')) Pos++;
            }

            private char Peek()
            {
                if (Pos >= _s.Length) throw new FormatException("unexpected end of json");
                return _s[Pos];
            }

            private void Expect(char c)
            {
                if (Peek() != c) throw new FormatException("expected '" + c + "' at " + Pos);
                Pos++;
            }

            public JsonNode ParseValue(int depth)
            {
                if (depth > MaxDepth) throw new FormatException("json too deep");
                char c = Peek();
                switch (c)
                {
                    case '{': return ParseObject(depth);
                    case '[': return ParseArray(depth);
                    case '"': return Str(ParseString());
                    case 't': Literal("true"); return Bool(true);
                    case 'f': Literal("false"); return Bool(false);
                    case 'n': Literal("null"); return Null();
                    default:
                        if (c == '-' || (c >= '0' && c <= '9')) return ParseNumber();
                        throw new FormatException("unexpected character '" + c + "' at " + Pos);
                }
            }

            private void Literal(string lit)
            {
                if (Pos + lit.Length > _s.Length || string.CompareOrdinal(_s, Pos, lit, 0, lit.Length) != 0)
                    throw new FormatException("invalid literal at " + Pos);
                Pos += lit.Length;
            }

            private JsonNode ParseNumber()
            {
                int start = Pos;
                if (_s[Pos] == '-') Pos++;
                while (Pos < _s.Length && ((_s[Pos] >= '0' && _s[Pos] <= '9') || _s[Pos] == '.' || _s[Pos] == 'e' || _s[Pos] == 'E' || _s[Pos] == '+' || _s[Pos] == '-'))
                    Pos++;
                string raw = _s.Substring(start, Pos - start);
                if (raw == "-" || raw.Length == 0) throw new FormatException("invalid number at " + start);
                return NumRaw(raw);
            }

            private string ParseString()
            {
                Expect('"');
                var sb = new StringBuilder();
                while (true)
                {
                    if (Pos >= _s.Length) throw new FormatException("unterminated string");
                    char c = _s[Pos++];
                    if (c == '"') break;
                    if (c == '\\')
                    {
                        if (Pos >= _s.Length) throw new FormatException("bad escape");
                        char e = _s[Pos++];
                        switch (e)
                        {
                            case '"': sb.Append('"'); break;
                            case '\\': sb.Append('\\'); break;
                            case '/': sb.Append('/'); break;
                            case 'b': sb.Append('\b'); break;
                            case 'f': sb.Append('\f'); break;
                            case 'n': sb.Append('\n'); break;
                            case 'r': sb.Append('\r'); break;
                            case 't': sb.Append('\t'); break;
                            case 'u':
                                if (Pos + 4 > _s.Length) throw new FormatException("bad unicode escape");
                                sb.Append((char)int.Parse(_s.Substring(Pos, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture));
                                Pos += 4;
                                break;
                            default: throw new FormatException("bad escape \\" + e);
                        }
                    }
                    else
                    {
                        if (c < 0x20) throw new FormatException("control character in string");
                        sb.Append(c);
                    }
                }
                return sb.ToString();
            }

            private JsonNode ParseArray(int depth)
            {
                Expect('[');
                var a = Arr();
                SkipWs();
                if (Peek() == ']') { Pos++; return a; }
                while (true)
                {
                    SkipWs();
                    a.Add(ParseValue(depth + 1));
                    SkipWs();
                    char c = Peek();
                    Pos++;
                    if (c == ']') return a;
                    if (c != ',') throw new FormatException("expected ',' or ']' at " + (Pos - 1));
                }
            }

            private JsonNode ParseObject(int depth)
            {
                Expect('{');
                var o = Obj();
                SkipWs();
                if (Peek() == '}') { Pos++; return o; }
                while (true)
                {
                    SkipWs();
                    string key = ParseString();
                    SkipWs();
                    Expect(':');
                    SkipWs();
                    var v = ParseValue(depth + 1);
                    if (o.Has(key)) throw new FormatException("duplicate key: " + key);
                    o.Set(key, v);
                    SkipWs();
                    char c = Peek();
                    Pos++;
                    if (c == '}') return o;
                    if (c != ',') throw new FormatException("expected ',' or '}' at " + (Pos - 1));
                }
            }
        }
    }
}
