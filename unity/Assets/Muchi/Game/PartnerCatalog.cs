using System;
using System.Collections.Generic;
using System.Linq;
using Muchi.Client;
using Muchi.Net;

namespace Muchi.Game
{
    /// <summary>One prebuilt horse+jockey model (Assets/Resources/Models/Partners/catalog.json).</summary>
    public sealed class PartnerVariant
    {
        public string Id, Coat, Silk, Model, OpponentLod, Preview;
    }

    /// <summary>
    /// Maps the asset contract (contracts/assets.md: coat/face/legs/mane/build + silks pattern/colours) onto the
    /// prototype art set, which has 25 combined models = 5 coats × 5 silks (Partner_&lt;Coat&gt;_&lt;Silk&gt;).
    ///
    /// Mapping (documented in docs/handoff-unity-3d.md):
    /// - coat: bay/dark_bay/brown → Bay, chestnut → Chestnut (Palomino when the mane is flaxen),
    ///   black → Black, gray/white → DappleGrey, unknown/default → Bay.
    /// - silks: the first colour that has a family decides — red/maroon/pink/orange → Crimson,
    ///   blue/sky/navy → Azure, purple → Violet, green/lime → Emerald, yellow/gold → Gold;
    ///   neutrals (white/black/silver/brown) fall through to the next colour; none → Crimson.
    /// - Not modelled by the prototype art (ignored, fall back to the model's built-in look):
    ///   horse/face, horse/leg, horse/mane (except flaxen chestnut), horse/build, silks/pattern, silks/cap.
    /// </summary>
    public sealed class PartnerCatalog
    {
        public static readonly string[] Coats = { "Bay", "Chestnut", "DappleGrey", "Black", "Palomino" };
        public static readonly string[] SilkFamilies = { "Crimson", "Azure", "Violet", "Emerald", "Gold" };
        /// <summary>Wardrobe order used by the app (MuchiApp.PartnerPreview / EquippedPartner).</summary>
        public static readonly string[] Featured = { "Partner_Bay_Crimson", "Partner_Chestnut_Azure", "Partner_DappleGrey_Violet", "Partner_Black_Emerald", "Partner_Palomino_Gold" };

        /// <summary>Kinds the prototype models cannot show; keys of these kinds always use the model's own look.</summary>
        public static readonly string[] UnmodelledKinds = { "horse/face", "horse/leg", "horse/mane", "horse/build", "silks/pattern", "silks/cap", "silks/sleeve", "silks/color" }; // silks/sleeve, silks/color: 勝負服エディタ masks / swatches (REQ-SILK-*, handoff round 14)

        private static readonly Dictionary<string, string> CoatMap = new Dictionary<string, string>
        {
            ["bay"] = "Bay", ["dark_bay"] = "Bay", ["brown"] = "Bay", ["chestnut"] = "Chestnut",
            ["black"] = "Black", ["gray"] = "DappleGrey", ["grey"] = "DappleGrey", ["white"] = "DappleGrey", ["default"] = "Bay",
        };

        private static readonly Dictionary<string, string> ColorMap = new Dictionary<string, string>
        {
            ["red"] = "Crimson", ["maroon"] = "Crimson", ["pink"] = "Crimson", ["orange"] = "Crimson",
            ["blue"] = "Azure", ["sky"] = "Azure", ["navy"] = "Azure",
            ["purple"] = "Violet",
            ["green"] = "Emerald", ["lime"] = "Emerald",
            ["yellow"] = "Gold", ["gold"] = "Gold",
        };

        /// <summary>Palette colours with no silk family of their own (they defer to the next colour).</summary>
        public static readonly string[] NeutralColors = { "white", "black", "silver", "brown" };

        private readonly Dictionary<string, PartnerVariant> _byId = new Dictionary<string, PartnerVariant>(StringComparer.Ordinal);
        public IReadOnlyCollection<PartnerVariant> Variants => _byId.Values;

        public static PartnerCatalog Parse(string catalogJson)
        {
            var c = new PartnerCatalog();
            var root = JsonNode.Parse(catalogJson);
            foreach (var v in root.Get("partnerVariants").Items)
            {
                var p = new PartnerVariant
                {
                    Id = Str(v, "id"), Coat = Str(v, "coat"), Silk = Str(v, "silk"),
                    Model = Str(v, "model"), OpponentLod = Str(v, "opponentLod"), Preview = Str(v, "preview"),
                };
                if (p.Id != null) c._byId[p.Id] = p;
            }
            return c;
        }

        private static string Str(JsonNode o, string k) => o.TryGet(k, out var n) && n.Kind == JsonKind.String ? n.AsString() : null;

        public PartnerVariant Get(string id) => id != null && _byId.TryGetValue(id, out var v) ? v : null;

        public static string CoatFor(Appearance a)
        {
            if (a == null) return "Bay";
            string c = a.Coat ?? "bay";
            if (c == "chestnut" && a.Mane == "flaxen") return "Palomino";
            return CoatMap.TryGetValue(c, out var m) ? m : "Bay";
        }

        public static string SilkFor(Silks s)
        {
            if (s?.Colors != null)
                foreach (var col in s.Colors)
                    if (col != null && ColorMap.TryGetValue(col, out var fam)) return fam;
            return "Crimson";
        }

        public static string IdFor(Appearance a, Silks s) => "Partner_" + CoatFor(a) + "_" + SilkFor(s);

        /// <summary>Best available variant for a look: exact coat×silk, else same coat, else the first variant.</summary>
        public PartnerVariant Resolve(Appearance a, Silks s)
        {
            var exact = Get(IdFor(a, s));
            if (exact != null) return exact;
            string coat = CoatFor(a);
            var sameCoat = _byId.Values.Where(v => v.Coat == coat).OrderBy(v => v.Id, StringComparer.Ordinal).FirstOrDefault();
            return sameCoat ?? _byId.Values.OrderBy(v => v.Id, StringComparer.Ordinal).FirstOrDefault();
        }

        /// <summary>
        /// Every horse/* and silks/* key of the asset manifest must either map to a catalog model (coats; silks
        /// colours via the palette) or belong to a documented unmodelled kind. Returns human-readable problems.
        /// </summary>
        public List<string> CoverageProblems(IEnumerable<string> manifestKeys, IEnumerable<string> paletteColors)
        {
            var problems = new List<string>();
            foreach (var key in manifestKeys)
            {
                if (!key.StartsWith("horse/", StringComparison.Ordinal) && !key.StartsWith("silks/", StringComparison.Ordinal)) continue;
                string kind = AssetKeys.KindOf(key);
                string name = key.Substring(kind.Length + 1);
                if (kind == "horse/coat")
                {
                    if (name == "default") continue;
                    if (!CoatMap.ContainsKey(name)) { problems.Add(key + ": coat has no partner mapping"); continue; }
                    var a = new Appearance { Coat = name };
                    if (!_byId.Values.Any(v => v.Coat == CoatFor(a))) problems.Add(key + ": mapped coat " + CoatFor(a) + " has no model in the catalog");
                }
                else if (!UnmodelledKinds.Contains(kind))
                {
                    problems.Add(key + ": kind " + kind + " is neither mapped nor listed as unmodelled");
                }
            }
            foreach (var col in paletteColors)
            {
                if (NeutralColors.Contains(col)) continue;
                if (!ColorMap.TryGetValue(col, out var fam)) problems.Add("palette/" + col + ": colour has no silk family");
                else if (!_byId.Values.Any(v => v.Silk == fam)) problems.Add("palette/" + col + ": silk family " + fam + " has no model in the catalog");
            }
            foreach (var coat in Coats)
                foreach (var silk in SilkFamilies)
                    if (Get("Partner_" + coat + "_" + silk) == null) problems.Add("catalog: missing Partner_" + coat + "_" + silk);
            return problems;
        }
    }
}
