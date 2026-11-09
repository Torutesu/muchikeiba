using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Net;

namespace Muchi.Client
{
    // 勝負服エディタ (REQ-SILK-001..016, contracts/protocol.md §35, server/src/domain/silksEditor.ts).
    // Parts are never random: free, earned by a fixed condition, or sold for a fixed coin price. Looks only.

    /// <summary>
    /// REQ-SILK-002: the shared silks code — "1" + eight two-digit base-36 fields (lowercase), 17 characters:
    /// pattern, colour 1, colour 2, colour 3 ("zz" when the pattern takes 2 colours), sleeve, cap, cap colour 1, cap colour 2.
    /// Same rules as TS encodeSilksCode / decodeSilksCode (checked against contracts/silks-code.vectors.json).
    /// </summary>
    public static class SilksCode
    {
        public const int Length = 17;
        /// <summary>Largest part number a field holds ("zz" = 1295 is reserved for "no third colour").</summary>
        public const int MaxNumber = 36 * 36 - 2;
        private const int None = 36 * 36 - 1;
        private const string Digits = "0123456789abcdefghijklmnopqrstuvwxyz";

        /// <summary>Eight numbers (index 3 may be null) → code. Throws ArgumentException on a bad field.</summary>
        public static string Encode(int?[] n)
        {
            if (n == null || n.Length != 8) throw new ArgumentException("a silks code has 8 fields");
            var c = new char[Length];
            c[0] = '1';
            for (int i = 0; i < 8; i++)
            {
                int v;
                if (n[i] == null)
                {
                    if (i != 3) throw new ArgumentException("only the third body colour may be empty");
                    v = None;
                }
                else
                {
                    v = n[i].Value;
                    if (v < 0 || v > MaxNumber) throw new ArgumentException("silks code field " + i + " out of range");
                }
                c[1 + i * 2] = Digits[v / 36];
                c[2 + i * 2] = Digits[v % 36];
            }
            return new string(c);
        }

        /// <summary>The eight numbers of a version-1 code (index 3 null for "zz"), or null when the text is not one.</summary>
        public static int?[] Decode(string code)
        {
            if (code == null || code.Length != Length || code[0] != '1') return null;
            var outv = new int?[8];
            for (int i = 0; i < 8; i++)
            {
                int hi = Digits.IndexOf(code[1 + i * 2]), lo = Digits.IndexOf(code[2 + i * 2]);
                if (hi < 0 || lo < 0) return null;
                int v = hi * 36 + lo;
                if (v == None) { if (i != 3) return null; outv[i] = null; }
                else outv[i] = v;
            }
            return outv;
        }

        public static bool IsValid(string code) => Decode(code) != null;

        /// <summary>Design → code with the part numbers of the catalog. Throws on an unknown part.</summary>
        public static string Encode(SilksDesign d, SilksCodeTables t)
        {
            int N(Dictionary<string, int> m, string id, string what)
            {
                if (id == null || !m.TryGetValue(id, out var v)) throw new ArgumentException("unknown " + what + " " + id);
                return v;
            }
            return Encode(new int?[]
            {
                N(t.Patterns, d.Pattern, "pattern"), N(t.Colors, d.Colors[0], "colour"), N(t.Colors, d.Colors[1], "colour"),
                d.Colors.Length > 2 ? N(t.Colors, d.Colors[2], "colour") : (int?)null,
                N(t.Sleeves, d.Sleeve, "sleeve"), N(t.Caps, d.Cap, "cap"), N(t.Colors, d.CapColors[0], "colour"), N(t.Colors, d.CapColors[1], "colour"),
            });
        }

        /// <summary>Code → design, or null when the code is malformed or names a part the catalog does not know.</summary>
        public static SilksDesign Decode(string code, SilksCodeTables t)
        {
            var n = Decode(code);
            if (n == null) return null;
            string Id(Dictionary<int, string> m, int? x) => x != null && m.TryGetValue(x.Value, out var id) ? id : null;
            var pattern = Id(t.PatternById, n[0]);
            if (pattern == null) return null;
            int count = t.PatternColors.TryGetValue(pattern, out var k) ? k : 2;
            if ((count == 3) != (n[3] != null)) return null;
            var colors = new List<string> { Id(t.ColorById, n[1]), Id(t.ColorById, n[2]) };
            if (count == 3) colors.Add(Id(t.ColorById, n[3]));
            var d = new SilksDesign
            {
                Pattern = pattern, Colors = colors.ToArray(), Sleeve = Id(t.SleeveById, n[4]), Cap = Id(t.CapById, n[5]),
                CapColors = new[] { Id(t.ColorById, n[6]), Id(t.ColorById, n[7]) },
            };
            if (d.Sleeve == null || d.Cap == null || Array.IndexOf(d.Colors, null) >= 0 || Array.IndexOf(d.CapColors, null) >= 0) return null;
            return d;
        }

        /// <summary>REQ-SILK-002/003: the code to draw for any silks (the server's code, else built from the legacy keys).</summary>
        public static string OfSilks(Silks s, SilksCodeTables t)
        {
            if (s == null) return null;
            if (s.Code != null && IsValid(s.Code)) return s.Code;
            try { return Encode(SilksDesign.FromLegacy(s), t); } catch (ArgumentException) { return null; }
        }
    }

    /// <summary>REQ-SILK-001: a composed design. Colours: body [1, 2, (3)], cap [1, 2].</summary>
    public sealed class SilksDesign
    {
        public string Pattern = "plain", Sleeve = "match", Cap = "plain";
        public string[] Colors = { "white", "navy" };
        public string[] CapColors = { "white", "navy" };

        /// <summary>Legacy silks (pattern, colours, cap): sleeves like the body, cap in body colours 1 and 2.</summary>
        public static SilksDesign FromLegacy(Silks s) => new SilksDesign
        {
            Pattern = s.Pattern, Colors = (string[])s.Colors.Clone(), Sleeve = s.Sleeve ?? "match", Cap = s.Cap,
            CapColors = s.CapColors != null && s.CapColors.Length == 2 ? (string[])s.CapColors.Clone() : new[] { s.Colors.Length > 0 ? s.Colors[0] : "white", s.Colors.Length > 1 ? s.Colors[1] : "navy" },
        };

        public SilksDesign Clone() => new SilksDesign { Pattern = Pattern, Sleeve = Sleeve, Cap = Cap, Colors = (string[])Colors.Clone(), CapColors = (string[])CapColors.Clone() };

        public bool SameAs(SilksDesign o) => o != null && Pattern == o.Pattern && Sleeve == o.Sleeve && Cap == o.Cap
            && string.Join(",", Colors) == string.Join(",", o.Colors) && string.Join(",", CapColors) == string.Join(",", o.CapColors);

        internal static SilksDesign Parse(JsonNode o)
        {
            if (o == null) return null;
            return new SilksDesign { Pattern = J.Str(o, "pattern"), Colors = J.Strs(o, "colors"), Sleeve = J.Str(o, "sleeve") ?? "match", Cap = J.Str(o, "cap"), CapColors = J.Strs(o, "capColors") };
        }

        internal JsonNode ToJson()
        {
            var b = JsonNode.Obj();
            b.Set("pattern", Pattern);
            var c = JsonNode.Arr();
            foreach (var x in Colors) c.Add(JsonNode.Str(x));
            b.Set("colors", c);
            b.Set("sleeve", Sleeve);
            b.Set("cap", Cap);
            var cc = JsonNode.Arr();
            foreach (var x in CapColors) cc.Add(JsonNode.Str(x));
            b.Set("capColors", cc);
            return b;
        }
    }

    /// <summary>Part numbers of the catalog (GET /v1/silks/editor `parts[].code`), for SilksCode.</summary>
    public sealed class SilksCodeTables
    {
        public readonly Dictionary<string, int> Patterns = new Dictionary<string, int>(), Colors = new Dictionary<string, int>(), Sleeves = new Dictionary<string, int>(), Caps = new Dictionary<string, int>();
        public readonly Dictionary<int, string> PatternById = new Dictionary<int, string>(), ColorById = new Dictionary<int, string>(), SleeveById = new Dictionary<int, string>(), CapById = new Dictionary<int, string>();
        public readonly Dictionary<string, int> PatternColors = new Dictionary<string, int>();

        public void AddPattern(string id, int code, int colors) { Patterns[id] = code; PatternById[code] = id; PatternColors[id] = colors; }
        public void AddColor(string id, int code) { Colors[id] = code; ColorById[code] = id; }
        public void AddSleeve(string id, int code) { Sleeves[id] = code; SleeveById[code] = id; }
        public void AddCap(string id, int code) { Caps[id] = code; CapById[code] = id; }

        /// <summary>From the editor catalog's parts (or from server/master/silks-editor.json + visuals in tests).</summary>
        public static SilksCodeTables From(SilksEditorView v)
        {
            var t = new SilksCodeTables();
            foreach (var p in v.Patterns) t.AddPattern(p.Id, p.Code, p.ColorCount);
            foreach (var p in v.Colors) t.AddColor(p.Id, p.Code);
            foreach (var p in v.Sleeves) t.AddSleeve(p.Id, p.Code);
            foreach (var p in v.Caps) t.AddCap(p.Id, p.Code);
            return t;
        }
    }

    /// <summary>One part in the editor (pattern / colour / sleeve / cap).</summary>
    public sealed class SilksPart
    {
        public string Type, Id, Name, Asset, Hex, Base;
        public int Code, ColorCount;
        public bool Owned;
        /// <summary>"free" | "item" | "achievement" | "races".</summary>
        public string SourceKind = "free";
        /// <summary>Server-made line: 最初から使える / コイン200で購入 / 実績「…」の2段目で解放 / レースを50回走ると解放 / 商品・報酬で入手.</summary>
        public string SourceLabel;
        /// <summary>Direct sale (null when the part is not sold for coins).</summary>
        public SilksPartShop Shop;

        internal static SilksPart Parse(JsonNode o, string type)
        {
            var src = J.Opt(o, "source");
            var shop = J.Opt(o, "shop");
            return new SilksPart
            {
                Type = type, Id = J.Str(o, "id"), Name = J.Str(o, "name"), Asset = J.Str(o, "asset"), Hex = J.Str(o, "hex"), Base = J.Str(o, "base"),
                Code = J.Int(o, "code"), ColorCount = J.Int(o, "colors", 2), Owned = J.Bool(o, "owned"), SourceKind = J.Str(src, "kind") ?? "free",
                SourceLabel = J.Str(o, "sourceLabel"), Shop = shop == null ? null : SilksPartShop.Parse(shop),
            };
        }
    }

    public sealed class SilksPartShop
    {
        public string ItemId;
        public int Price;
        /// <summary>"any" (paid coins first, then free) | "paidOnly" (有償限定).</summary>
        public string Currency = "any";
        public bool ForSale;
        public bool PaidOnly => Currency == "paidOnly";
        internal static SilksPartShop Parse(JsonNode o) => new SilksPartShop { ItemId = J.Str(o, "itemId"), Price = J.Int(o, "price"), Currency = J.Str(o, "currency") ?? "any", ForSale = J.Bool(o, "forSale") };
    }

    /// <summary>A part the design uses but the player does not have (preview / refusal / unusable preset).</summary>
    public sealed class SilksLockedPart
    {
        public string Type, Id, Name, SourceLabel;
        public SilksPartShop Shop;
        internal static SilksLockedPart Parse(JsonNode o)
        {
            var shop = J.Opt(o, "shop");
            return new SilksLockedPart { Type = J.Str(o, "type"), Id = J.Str(o, "id"), Name = J.Str(o, "name"), SourceLabel = J.Str(o, "sourceLabel"), Shop = shop == null ? null : SilksPartShop.Parse(shop) };
        }
    }

    public sealed class SilksPreset
    {
        public int Slot;
        /// <summary>The player's own text: never translated.</summary>
        public string Name, Code;
        public SilksDesign Design;
        public long SavedAt;
        /// <summary>False when a part was taken back by a refund (Missing lists it) — apply is refused until it is owned again.</summary>
        public bool Usable;
        public List<SilksLockedPart> Missing = new List<SilksLockedPart>();
        /// <summary>"RESERVED" / "LOW_CONTRAST" when a later banned-list import or readability rule refuses it (server message).</summary>
        public List<KeyValuePair<string, string>> Problems = new List<KeyValuePair<string, string>>();
        internal static SilksPreset Parse(JsonNode o) => new SilksPreset
        {
            Slot = J.Int(o, "slot"), Name = J.Str(o, "name"), Code = J.Str(o, "code"), Design = SilksDesign.Parse(J.Opt(o, "design")), SavedAt = J.Long(o, "savedAt"),
            Usable = J.Bool(o, "usable"), Missing = J.List(o, "missing", SilksLockedPart.Parse),
            Problems = J.List(o, "problems", x => new KeyValuePair<string, string>(J.Str(x, "problem"), J.Str(x, "message"))),
        };
    }

    /// <summary>GET /v1/silks/editor.</summary>
    public sealed class SilksEditorView
    {
        public int Version, CodeVersion, MaxPresets = 5, PresetNameMax = 12;
        public string Notice;
        public double MinDeltaE;
        public List<SilksPart> Patterns = new List<SilksPart>(), Colors = new List<SilksPart>(), Sleeves = new List<SilksPart>(), Caps = new List<SilksPart>();
        /// <summary>Colour pairs that are too close (body colours 1/2, cap colours) — clients never compute contrast.</summary>
        public HashSet<string> LowContrast = new HashSet<string>();
        public SilksDesign Current;
        public string CurrentCode;
        public Silks CurrentSilks;
        /// <summary>REQ-SILK-010: set once after a refund reset the silks (show it, then MarkSilksNoticeSeenAsync).</summary>
        public string ResetNotice;
        public List<SilksPreset> Presets = new List<SilksPreset>();
        public Wallet Wallet;

        public bool IsLowContrast(string a, string b) => LowContrast.Contains(a + "|" + b);

        public SilksPart Part(string type, string id)
        {
            var list = type == "pattern" ? Patterns : type == "color" ? Colors : type == "sleeve" ? Sleeves : Caps;
            return list.Find(p => p.Id == id);
        }

        internal static SilksEditorView Parse(JsonNode o)
        {
            var parts = J.Opt(o, "parts");
            var cur = J.Opt(o, "current");
            var v = new SilksEditorView
            {
                Version = J.Int(o, "version"), CodeVersion = J.Int(o, "codeVersion"), Notice = J.Str(o, "notice"),
                MaxPresets = J.Int(o, "maxPresets", 5), PresetNameMax = J.Int(o, "presetNameMax", 12),
                Patterns = J.List(parts, "patterns", x => SilksPart.Parse(x, "pattern")), Colors = J.List(parts, "colors", x => SilksPart.Parse(x, "color")),
                Sleeves = J.List(parts, "sleeves", x => SilksPart.Parse(x, "sleeve")), Caps = J.List(parts, "caps", x => SilksPart.Parse(x, "cap")),
                Current = SilksDesign.Parse(J.Opt(cur, "design")), CurrentCode = J.Str(cur, "code"), CurrentSilks = Silks.Parse(J.Opt(cur, "silks")),
                ResetNotice = J.Str(J.Opt(cur, "resetNotice"), "message"),
                Presets = J.List(o, "presets", SilksPreset.Parse), Wallet = Wallet.Parse(J.Opt(o, "wallet")),
            };
            var c = J.Opt(o, "contrast");
            if (c != null && c.TryGet("minDeltaE", out var d) && !d.IsNull) v.MinDeltaE = double.Parse(d.ToString(), System.Globalization.CultureInfo.InvariantCulture);
            var pairs = J.Opt(o, "lowContrastPairs");
            if (pairs != null && pairs.Kind == JsonKind.Array)
                foreach (var p in pairs.Items)
                {
                    var a = p.Items[0].AsString(); var b = p.Items[1].AsString();
                    v.LowContrast.Add(a + "|" + b); v.LowContrast.Add(b + "|" + a);
                }
            return v;
        }
    }

    /// <summary>POST /v1/silks/preview (try before buying; nothing changes).</summary>
    public sealed class SilksPreview
    {
        public SilksDesign Design;
        public string Code;
        public bool Owned, Savable;
        public List<SilksLockedPart> Locked = new List<SilksLockedPart>();
        public int TotalAny, TotalPaidOnly;
        /// <summary>"LOW_CONTRAST" | "RESERVED" with a server-made message.</summary>
        public List<KeyValuePair<string, string>> Problems = new List<KeyValuePair<string, string>>();
        internal static SilksPreview Parse(JsonNode o)
        {
            var tp = J.Opt(o, "totalPrice");
            return new SilksPreview
            {
                Design = SilksDesign.Parse(J.Opt(o, "design")), Code = J.Str(o, "code"), Owned = J.Bool(o, "owned"), Savable = J.Bool(o, "savable"),
                Locked = J.List(o, "locked", SilksLockedPart.Parse), TotalAny = J.Int(tp, "any"), TotalPaidOnly = J.Int(tp, "paidOnly"),
                Problems = J.List(o, "problems", x => new KeyValuePair<string, string>(J.Str(x, "problem"), J.Str(x, "message"))),
            };
        }
    }

    /// <summary>PUT /v1/silks and preset apply.</summary>
    public sealed class SilksSaved
    {
        public SilksDesign Design;
        public string Code;
        public Silks Silks;
        internal static SilksSaved Parse(JsonNode o) => new SilksSaved { Design = SilksDesign.Parse(J.Opt(o, "design")), Code = J.Str(o, "code"), Silks = Silks.Parse(J.Opt(o, "silks")) };
    }

    public sealed class SilksPresets
    {
        public int Slot = -1;
        public List<SilksPreset> Presets = new List<SilksPreset>();
        internal static SilksPresets Parse(JsonNode o) => new SilksPresets { Slot = J.Int(o, "slot", -1), Presets = J.List(o, "presets", SilksPreset.Parse) };
    }

    /// <summary>POST /v1/silks/parts/:itemId/buy.</summary>
    public sealed class SilksPartPurchase
    {
        public string ItemId, PartType, PartId;
        public int SpentPaid, SpentFree;
        public Wallet Wallet;
        internal static SilksPartPurchase Parse(JsonNode o)
        {
            var sp = J.Opt(o, "spent");
            var part = J.Opt(o, "part");
            return new SilksPartPurchase { ItemId = J.Str(o, "itemId"), SpentPaid = J.Int(sp, "paid"), SpentFree = J.Int(sp, "free"), Wallet = Wallet.Parse(J.Opt(o, "wallet")), PartType = J.Str(part, "type"), PartId = J.Str(part, "id") };
        }
    }

    public sealed partial class ApiClient
    {
        private static JsonNode DesignBody(SilksDesign design, string code)
        {
            var b = JsonNode.Obj();
            if (code != null) b.Set("code", code); else b.Set("design", design.ToJson());
            return b;
        }

        /// <summary>REQ-SILK-012: parts with ownership / source / price, the current design and code, presets.</summary>
        public Task<SilksEditorView> GetSilksEditorAsync(CancellationToken ct = default)
            => Call("GET", "/v1/silks/editor", null, true, null, true, SilksEditorView.Parse, ct);

        /// <summary>REQ-SILK-006: try on a design (parts need not be owned): locked parts, total price, problems.</summary>
        public Task<SilksPreview> PreviewSilksAsync(SilksDesign design, CancellationToken ct = default)
            => Call("POST", "/v1/silks/preview", DesignBody(design, null), true, null, true, SilksPreview.Parse, ct);

        /// <summary>REQ-SILK-012: validate and equip (idempotent). 409 NOT_ELIGIBLE (details.locked) / 400 LOW_CONTRAST / RESERVED.</summary>
        public Task<SilksSaved> SaveSilksAsync(SilksDesign design, CancellationToken ct = default)
            => Call("PUT", "/v1/silks", DesignBody(design, null), true, null, true, SilksSaved.Parse, ct);

        /// <summary>REQ-SILK-011: save to the smallest free slot (409 CONFLICT when all are used). Name is private; null = default.</summary>
        public Task<SilksPresets> SaveSilksPresetAsync(SilksDesign design, string name = null, CancellationToken ct = default)
        {
            var b = DesignBody(design, null);
            if (name != null) b.Set("name", name);
            return Call("POST", "/v1/silks/presets", b, true, null, false, SilksPresets.Parse, ct);
        }

        /// <summary>REQ-SILK-011: overwrite a slot's design and/or name.</summary>
        public Task<SilksPresets> UpdateSilksPresetAsync(int slot, SilksDesign design, string name = null, CancellationToken ct = default)
        {
            var b = design != null ? DesignBody(design, null) : JsonNode.Obj();
            if (name != null) b.Set("name", name);
            return Call("PUT", "/v1/silks/presets/" + slot, b, true, null, true, SilksPresets.Parse, ct);
        }

        public Task<SilksPresets> DeleteSilksPresetAsync(int slot, CancellationToken ct = default)
            => Call("DELETE", "/v1/silks/presets/" + slot, null, true, null, true, SilksPresets.Parse, ct);

        public Task<SilksSaved> ApplySilksPresetAsync(int slot, CancellationToken ct = default)
            => Call("POST", "/v1/silks/presets/" + slot + "/apply", JsonNode.Obj(), true, null, true, SilksSaved.Parse, ct);

        /// <summary>REQ-SILK-005: buy one part for its fixed price (same purchase as the shop's cosmetics tab). Keyed and retried safely.</summary>
        public Task<SilksPartPurchase> BuySilksPartAsync(string itemId, string idempotencyKey = null, CancellationToken ct = default)
            => Call("POST", "/v1/silks/parts/" + Seg(itemId) + "/buy", JsonNode.Obj(), true, idempotencyKey ?? NewIdempotencyKey(), true, SilksPartPurchase.Parse, ct);

        /// <summary>REQ-SILK-010: the refund reset notice was shown.</summary>
        public Task<bool> MarkSilksNoticeSeenAsync(CancellationToken ct = default)
            => Call("POST", "/v1/silks/notice-seen", JsonNode.Obj(), true, null, true, o => J.Bool(o, "ok"), ct);
    }
}
