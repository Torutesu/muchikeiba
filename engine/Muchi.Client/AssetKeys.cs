using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace Muchi.Client
{
    /// <summary>
    /// Asset keys exactly as contracts/assets.md defines them (same rules as server/src/domain/visuals.ts).
    /// Every key the master data can produce is listed in contracts/assets.manifest.json. Missing assets
    /// fall back to "&lt;kind&gt;/default" — use <see cref="Resolve"/> and never crash on a missing key.
    /// </summary>
    public static class AssetKeys
    {
        public const string VoiceLang = "ja";

        public static string Coat(string id) => "horse/coat/" + id;
        public static string Face(string id) => "horse/face/" + id;
        public static string Leg(string id) => "horse/leg/" + id;
        public static string Mane(string id) => "horse/mane/" + id;
        public static string Build(string id) => "horse/build/" + id;
        public static string SilksPattern(string id) => "silks/pattern/" + id;
        public static string SilksCap(string id) => "silks/cap/" + id;
        public static string Gate(int bracket) => "ui/gate/" + bracket.ToString(CultureInfo.InvariantCulture);
        public static string Item(string id) => "item/" + id;
        /// <summary>Tack (bridle / saddle cloth) layered on the horse model; name comes from the cosmetic's asset (REQ-ITEM-006).</summary>
        public static string Tack(string name) => "tack/" + name;
        /// <summary>Stable decor (REQ-ITEM-006).</summary>
        public static string Decor(string name) => "decor/" + name;
        /// <summary>Team cheer stamp (REQ-TEAMFEED-001), master/stamps.json id.</summary>
        public static string Stamp(string id) => "stamp/" + id;
        /// <summary>マイ厩舎 room theme (REQ-STABLE-001); the server sends it as theme.key.</summary>
        public static string StableTheme(string id) => "stable/theme/" + id;
        public static string GachaBanner(string id) => "banner/gacha/" + id;
        public static string EventBanner(string id) => "banner/event/" + id;
        public static string Title(string id) => "title/" + id;
        /// <summary>REQ-COL-003: 図鑑 portrait (obtained / seen) and silhouette (unknown) per horse template.</summary>
        public static string CollectionPortrait(string templateId) => "collection/portrait/" + templateId;
        public static string CollectionSilhouette(string templateId) => "collection/silhouette/" + templateId;
        /// <summary>REQ-ACH-004: achievement badge per tier.</summary>
        public static string Badge(string achievementId, int tier) => "badge/" + achievementId + "_" + tier.ToString(CultureInfo.InvariantCulture);
        public static string EmblemShape(string id) => "emblem/shape/" + id;
        public static string EmblemSymbol(string id) => "emblem/symbol/" + id;
        public static string Venue(string venue) => "scene/venue/" + venue;
        public static string SurfaceScene(string venue, string surface) => "scene/surface/" + venue + "_" + surface;
        public static string Night(string venue) => "scene/night/" + venue;
        public static string Going(string going) => "fx/going/" + going;
        /// <summary>REQ-ROOM-001: racecourse look theme (cosmetic, own screen only).</summary>
        public static string CourseLook(string id) => "scene/look/" + id;
        /// <summary>REQ-ROOM-004: friend-room weather effect (scene only).</summary>
        public static string Weather(string id) => "fx/weather/" + id;
        public static string RaceSfx(string id) => "sfx/race/" + id;
        public static string UiSfx(string id) => "sfx/ui/" + id;
        public static string VoicePhrase(string clipId) => "voice/" + VoiceLang + "/phrase/" + clipId.Replace("#", "_p");
        public static string VoiceNum(int n) => "voice/" + VoiceLang + "/num/" + n.ToString(CultureInfo.InvariantCulture);
        /// <summary>Horse names are voiced per name text (FNV-1a 64 of the UTF-8 name), not per horse id.</summary>
        public static string VoiceName(string name) => "voice/" + VoiceLang + "/name/n" + Fnv64Hex((name ?? "").Normalize(NormalizationForm.FormC));

        /// <summary>All keys needed to draw a horse (coat, face, 4 legs, mane, build).</summary>
        public static string[] HorseKeys(Appearance a)
        {
            a = a ?? new Appearance();
            return new[] { Coat(a.Coat), Face(a.Face), Leg(a.Legs[0]), Leg(a.Legs[1]), Leg(a.Legs[2]), Leg(a.Legs[3]), Mane(a.Mane), Build(a.Build) };
        }

        /// <summary>
        /// Commentary clip key → voice asset key: fixed clips ("gate_open_1#0"), "num:&lt;n&gt;" and
        /// "name:&lt;horseId&gt;" (needs the horse's name; returns null when it is unknown) and "skill:&lt;skillId&gt;" (a unique
        /// skill's name, voiced like a horse name by its text; needs the skill's name, e.g. from the race config's horse.skill).
        /// </summary>
        public static string VoiceClip(string clipKey, Func<string, string> horseNameById, Func<string, string> skillNameById = null)
        {
            if (clipKey != null && clipKey.StartsWith("skill:", StringComparison.Ordinal))
            {
                string skill = skillNameById?.Invoke(clipKey.Substring(6));
                return skill == null ? null : VoiceName(skill);
            }
            if (clipKey == null) return null;
            if (clipKey.StartsWith("num:", StringComparison.Ordinal)) return VoiceNum(int.Parse(clipKey.Substring(4), CultureInfo.InvariantCulture));
            if (clipKey.StartsWith("name:", StringComparison.Ordinal))
            {
                string name = horseNameById?.Invoke(clipKey.Substring(5));
                return name == null ? null : VoiceName(name);
            }
            return VoicePhrase(clipKey);
        }

        /// <summary>Kind of a key: everything before the last segment (variant suffix "@vN" ignored).</summary>
        public static string KindOf(string key)
        {
            int at = key.LastIndexOf('@');
            if (at > 0) key = key.Substring(0, at);
            int slash = key.LastIndexOf('/');
            return slash < 0 ? "" : key.Substring(0, slash);
        }

        public static string Fallback(string kind) => kind + "/default";

        /// <summary>The key if the asset exists, else its kind's fallback, else null (show nothing; never throw).</summary>
        public static string Resolve(string key, Func<string, bool> exists)
        {
            if (string.IsNullOrEmpty(key)) return null;
            if (exists(key)) return key;
            string fb = Fallback(KindOf(key));
            return exists(fb) ? fb : null;
        }

        /// <summary>Well-formed key: lowercase segments [a-z0-9_] joined by '/', at least two, optional "@vN".</summary>
        public static bool IsValid(string key)
        {
            if (string.IsNullOrEmpty(key)) return false;
            string body = key;
            int at = key.IndexOf('@');
            if (at >= 0)
            {
                string v = key.Substring(at + 1);
                if (v.Length < 2 || v[0] != 'v') return false;
                for (int i = 1; i < v.Length; i++) if (v[i] < '0' || v[i] > '9') return false;
                body = key.Substring(0, at);
            }
            var segs = body.Split('/');
            if (segs.Length < 2) return false;
            foreach (var s in segs)
            {
                if (s.Length == 0) return false;
                foreach (char ch in s) if (!(ch >= 'a' && ch <= 'z' || ch >= '0' && ch <= '9' || ch == '_')) return false;
            }
            return true;
        }

        /// <summary>Saddle-cloth bracket (枠番 1..8) of a gate in a field of `runners` (contracts/assets.md §4).</summary>
        public static int BracketOf(int gate, int runners)
        {
            if (runners <= 8) return gate;
            int single = 16 - runners;
            if (gate <= single) return gate;
            return single + (gate - single + 1) / 2;
        }

        /// <summary>Wire name of a going (names depend on the surface: turf firm/good/yielding/soft, dirt fast/good/muddy/sloppy).</summary>
        public static string GoingName(Muchi.Engine.Going g, Muchi.Engine.Surface surface)
        {
            bool dirt = surface == Muchi.Engine.Surface.Dirt;
            switch (g)
            {
                case Muchi.Engine.Going.FirmOrFast: return dirt ? "fast" : "firm";
                case Muchi.Engine.Going.YieldingOrMuddy: return dirt ? "muddy" : "yielding";
                case Muchi.Engine.Going.SoftOrSloppy: return dirt ? "sloppy" : "soft";
                default: return "good";
            }
        }

        /// <summary>FNV-1a 64 of the UTF-8 string, 16 lowercase hex (same as the server's fnv1a64Hex).</summary>
        public static string Fnv64Hex(string s)
        {
            var f = Muchi.Engine.Fnv1a64.Create();
            foreach (byte b in Encoding.UTF8.GetBytes(s)) f.AddByte(b);
            return f.Hex;
        }

        /// <summary>Every key in contracts/assets.manifest.json (for coverage checks in the Unity editor).</summary>
        public static List<string> ParseManifestKeys(string manifestJson)
        {
            var o = Muchi.Net.JsonNode.Parse(manifestJson);
            return J.List(o, "keys", x => x.AsString());
        }
    }
}
