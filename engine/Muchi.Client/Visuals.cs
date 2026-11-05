using System.Collections.Generic;
using Muchi.Net;

namespace Muchi.Client
{
    // Visual descriptors sent by the server (contracts/assets.md, REQ-ASSET-*).
    // They never take part in the simulation or the result hash; AssetKeys turns them into asset keys.

    /// <summary>Horse look. Legs = [left fore, right fore, left hind, right hind].</summary>
    public sealed class Appearance
    {
        public string Coat = "bay", Face = "none", Mane = "normal", Build = "standard";
        public string[] Legs = { "none", "none", "none", "none" };

        internal static Appearance Parse(JsonNode o)
        {
            if (o == null) return null;
            var a = new Appearance
            {
                Coat = J.Str(o, "coat") ?? "bay", Face = J.Str(o, "face") ?? "none", Mane = J.Str(o, "mane") ?? "normal", Build = J.Str(o, "build") ?? "standard",
            };
            var legs = J.List(o, "legs", x => x.AsString());
            if (legs.Count == 4) a.Legs = legs.ToArray();
            return a;
        }
    }

    /// <summary>Jockey silks: pattern + palette colour ids (2 or 3, per pattern) + cap pattern.</summary>
    public sealed class Silks
    {
        public string Pattern = "plain", Cap = "plain";
        public string[] Colors = { "white", "navy" };

        internal static Silks Parse(JsonNode o)
        {
            if (o == null) return null;
            return new Silks { Pattern = J.Str(o, "pattern") ?? "plain", Cap = J.Str(o, "cap") ?? "plain", Colors = J.List(o, "colors", x => x.AsString()).ToArray() };
        }

        internal JsonNode ToJson()
        {
            var b = JsonNode.Obj();
            b.Set("pattern", Pattern);
            var c = JsonNode.Arr();
            foreach (var x in Colors) c.Add(JsonNode.Str(x));
            b.Set("colors", c);
            b.Set("cap", Cap);
            return b;
        }
    }

    /// <summary>Team emblem from the fixed parts set: shape + symbol + 2 palette colours.</summary>
    public sealed class Emblem
    {
        public string Shape, Symbol;
        public string[] Colors = new string[2];

        internal static Emblem Parse(JsonNode o)
        {
            if (o == null) return null;
            return new Emblem { Shape = J.Str(o, "shape"), Symbol = J.Str(o, "symbol"), Colors = J.List(o, "colors", x => x.AsString()).ToArray() };
        }

        internal JsonNode ToJson()
        {
            var b = JsonNode.Obj();
            b.Set("shape", Shape);
            b.Set("symbol", Symbol);
            var c = JsonNode.Arr();
            foreach (var x in Colors) c.Add(JsonNode.Str(x));
            b.Set("colors", c);
            return b;
        }
    }

    /// <summary>Which scene to load for a race and how to orient it.</summary>
    public sealed class TrackVisual
    {
        public string TrackId, Venue, Surface;
        /// <summary>"left" (counter-clockwise, turns to the left) or "right".</summary>
        public string Direction = "left";
        /// <summary>Ground condition or null (good).</summary>
        public string Going;
        public bool Night;
        /// <summary>Asset keys: scene/venue, scene/surface, scene/night (null by day), fx/going (null on good ground).</summary>
        public string VenueKey, SurfaceKey, NightKey, GoingKey;
        public bool LeftHanded => Direction != "right";

        internal static TrackVisual Parse(JsonNode o)
        {
            if (o == null) return null;
            var k = J.Opt(o, "keys");
            return new TrackVisual
            {
                TrackId = J.Str(o, "trackId"), Venue = J.Str(o, "venue"), Surface = J.Str(o, "surface"), Direction = J.Str(o, "direction") ?? "left",
                Going = J.Str(o, "going"), Night = J.Bool(o, "night"),
                VenueKey = J.Str(k, "venue"), SurfaceKey = J.Str(k, "surface"), NightKey = J.Str(k, "night"), GoingKey = J.Str(k, "going"),
            };
        }
    }

    /// <summary>One runner's look in a race (from the `start` message).</summary>
    public sealed class EntrantVisual
    {
        public int Slot, Gate, Bracket;
        public Appearance Appearance;
        public Silks Silks;
        public string DisplayName, TitleId;
        /// <summary>Voice clip key of the horse's name (voice/ja/name/n&lt;fnv64&gt;).</summary>
        public string VoiceName;

        internal static EntrantVisual Parse(JsonNode o) => new EntrantVisual
        {
            Slot = J.Int(o, "slot"), Gate = J.Int(o, "gate"), Bracket = J.Int(o, "bracket"),
            Appearance = Appearance.Parse(J.Opt(o, "appearance")) ?? new Appearance(), Silks = Silks.Parse(J.Opt(o, "silks")) ?? new Silks(),
            DisplayName = J.Str(o, "displayName"), TitleId = J.Str(o, "titleId"), VoiceName = J.Str(o, "voiceName"),
        };
    }

    /// <summary>
    /// Visuals of a race (contracts/protocol.md `start.visuals`). Absent on servers older than the visual
    /// contract: use <see cref="Fallback"/>, which derives everything from the config alone.
    /// </summary>
    public sealed class RaceVisuals
    {
        public TrackVisual Track;
        public List<EntrantVisual> Entrants = new List<EntrantVisual>();

        public EntrantVisual ForSlot(int slot)
        {
            foreach (var e in Entrants) if (e.Slot == slot) return e;
            return null;
        }

        public static RaceVisuals Parse(JsonNode o)
        {
            if (o == null || o.Kind != JsonKind.Object) return null;
            return new RaceVisuals { Track = TrackVisual.Parse(J.Opt(o, "track")), Entrants = J.List(o, "entrants", EntrantVisual.Parse) };
        }

        /// <summary>Default looks when the server sent none (offline races, old servers).</summary>
        public static RaceVisuals Fallback(Muchi.Engine.RaceConfig config, string direction = "left")
        {
            var t = config.Track;
            string venue = t.Id != null && t.Id.Contains("_") ? t.Id.Substring(0, t.Id.IndexOf('_')) : (t.Id ?? "unknown");
            string surface = t.Surface == Muchi.Engine.Surface.Dirt ? "dirt" : "turf";
            string going = t.Going.HasValue ? AssetKeys.GoingName(t.Going.Value, t.Surface) : null;
            var v = new RaceVisuals
            {
                Track = new TrackVisual
                {
                    TrackId = t.Id, Venue = venue, Surface = surface, Direction = direction, Going = going, Night = t.Night == true,
                    VenueKey = AssetKeys.Venue(venue), SurfaceKey = AssetKeys.SurfaceScene(venue, surface),
                    NightKey = t.Night == true ? AssetKeys.Night(venue) : null, GoingKey = going != null && going != "good" ? AssetKeys.Going(going) : null,
                },
            };
            int n = config.Entrants.Count;
            foreach (var e in config.Entrants)
                v.Entrants.Add(new EntrantVisual
                {
                    Slot = e.Slot, Gate = e.Slot + 1, Bracket = AssetKeys.BracketOf(e.Slot + 1, n),
                    Appearance = new Appearance(), Silks = new Silks(), VoiceName = AssetKeys.VoiceName(e.Horse.Name ?? ""),
                });
            return v;
        }
    }

    /// <summary>GET /v1/visuals: the catalog of looks the client can show (cache by Version).</summary>
    public sealed class VisualsCatalog
    {
        public int Version;
        /// <summary>palette id → "#RRGGBB"</summary>
        public Dictionary<string, string> Palette = new Dictionary<string, string>();
        public List<string> Coats = new List<string>(), Faces = new List<string>(), Legs = new List<string>(), Manes = new List<string>(), Builds = new List<string>();
        public List<SilksPatternInfo> SilksPatterns = new List<SilksPatternInfo>();
        public List<string> Caps = new List<string>();
        /// <summary>bracket (1..8) → (cloth palette id, number palette id)</summary>
        public Dictionary<int, string[]> GateBrackets = new Dictionary<int, string[]>();
        public List<TrackVisual> Tracks = new List<TrackVisual>();
        public List<string> EmblemShapes = new List<string>(), EmblemSymbols = new List<string>();
        public List<string> RaceSfx = new List<string>(), UiSfx = new List<string>();
        public Dictionary<string, Appearance> TemplateAppearances = new Dictionary<string, Appearance>();
        public Dictionary<string, string> ItemIcons = new Dictionary<string, string>(), BannerArt = new Dictionary<string, string>(), EventArt = new Dictionary<string, string>(), TitleIcons = new Dictionary<string, string>();

        internal static VisualsCatalog Parse(JsonNode o)
        {
            var c = new VisualsCatalog { Version = J.Int(o, "version") };
            foreach (var p in J.List(o, "palette", x => x)) c.Palette[J.Str(p, "id")] = J.Str(p, "hex");
            var h = J.Opt(o, "horse");
            c.Coats = J.List(h, "coats", x => x.AsString()); c.Faces = J.List(h, "faces", x => x.AsString()); c.Legs = J.List(h, "legs", x => x.AsString());
            c.Manes = J.List(h, "manes", x => x.AsString()); c.Builds = J.List(h, "builds", x => x.AsString());
            var s = J.Opt(o, "silks");
            c.SilksPatterns = J.List(s, "patterns", x => new SilksPatternInfo { Id = J.Str(x, "id"), Colors = J.Int(x, "colors", 2), UnlockItem = J.Str(x, "unlockItem") });
            c.Caps = J.List(s, "caps", x => x.AsString());
            foreach (var g in J.List(o, "gateBrackets", x => x)) c.GateBrackets[J.Int(g, "bracket")] = new[] { J.Str(g, "cloth"), J.Str(g, "number") };
            c.Tracks = J.List(o, "tracks", TrackVisual.Parse);
            var e = J.Opt(o, "emblem");
            c.EmblemShapes = J.List(e, "shapes", x => x.AsString()); c.EmblemSymbols = J.List(e, "symbols", x => x.AsString());
            var sfx = J.Opt(o, "sfx");
            c.RaceSfx = J.List(sfx, "race", x => x.AsString()); c.UiSfx = J.List(sfx, "ui", x => x.AsString());
            var tpl = J.Opt(o, "templates");
            if (tpl != null) foreach (var kv in tpl.Props) c.TemplateAppearances[kv.Key] = Appearance.Parse(J.Opt(kv.Value, "appearance"));
            var items = J.Opt(o, "items");
            if (items != null) foreach (var kv in items.Props) c.ItemIcons[kv.Key] = J.Str(kv.Value, "icon");
            c.BannerArt = J.Map(o, "banners", x => x.AsString());
            c.EventArt = J.Map(o, "events", x => x.AsString());
            c.TitleIcons = J.Map(o, "titles", x => x.AsString());
            return c;
        }
    }

    public sealed class SilksPatternInfo
    {
        public string Id;
        public int Colors;
        /// <summary>Costume item that unlocks this pattern, or null when free.</summary>
        public string UnlockItem;
    }
}
