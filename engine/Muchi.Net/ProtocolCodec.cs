using System;
using System.Collections.Generic;
using System.Globalization;
using Muchi.Engine;

namespace Muchi.Net
{
    /// <summary>Replay log (contracts/protocol.md §7).</summary>
    public sealed class ReplayLog
    {
        public RaceConfig Config;
        public int EndTick;
        public List<InputRecord> Inputs = new List<InputRecord>();
    }

    /// <summary>JSON ⇄ engine model conversions for contracts/protocol.md §2, §7, §8.</summary>
    public static class ProtocolCodec
    {
        // ------------------------------------------------------------- enums
        public static string StyleToString(RunningStyle s)
        {
            switch (s)
            {
                case RunningStyle.Nige: return "nige";
                case RunningStyle.Senko: return "senko";
                case RunningStyle.Sashi: return "sashi";
                default: return "oikomi";
            }
        }

        public static RunningStyle ParseStyle(string s)
        {
            switch (s)
            {
                case "nige": return RunningStyle.Nige;
                case "senko": return RunningStyle.Senko;
                case "sashi": return RunningStyle.Sashi;
                case "oikomi": return RunningStyle.Oikomi;
                default: throw new FormatException("unknown style: " + s);
            }
        }

        // ground condition (REQ-RACE-034/035): names depend on the surface
        private static readonly string[] TurfGoing = { "firm", "good", "yielding", "soft" };
        private static readonly string[] DirtGoing = { "fast", "good", "muddy", "sloppy" };

        public static string GoingToString(Going g, Surface s) => (s == Surface.Dirt ? DirtGoing : TurfGoing)[(int)g];

        public static Going ParseGoing(string s, Surface surface)
        {
            var names = surface == Surface.Dirt ? DirtGoing : TurfGoing;
            for (int i = 0; i < names.Length; i++) if (names[i] == s) return (Going)i;
            throw new FormatException("invalid going for " + SurfaceToString(surface) + ": " + s);
        }

        public static string GoingAptitudeToString(GoingAptitude a) => a == GoingAptitude.Fast ? "fast" : a == GoingAptitude.Heavy ? "heavy" : "any";

        public static GoingAptitude ParseGoingAptitude(string s)
        {
            switch (s)
            {
                case "any": return GoingAptitude.Any;
                case "fast": return GoingAptitude.Fast;
                case "heavy": return GoingAptitude.Heavy;
            }
            throw new FormatException("invalid goingAptitude: " + s);
        }

        // unique skills (ruleset 1.3, REQ-UXS-051): trigger names in the order of SkillTrigger
        private static readonly string[] SkillTriggerNames = { "finalStraight", "cornerRail", "lowStamina", "spurtBehind", "remaining", "leading", "slipstream", "goodStart" };

        public static string SkillTriggerToString(SkillTrigger t) => SkillTriggerNames[(int)t];

        public static SkillTrigger ParseSkillTrigger(string s)
        {
            for (int i = 0; i < SkillTriggerNames.Length; i++) if (SkillTriggerNames[i] == s) return (SkillTrigger)i;
            throw new FormatException("invalid skill trigger: " + s);
        }

        public static SkillSpec ParseSkill(JsonNode k) => new SkillSpec
        {
            Id = k.Get("id").AsString(),
            Name = k.Get("name").AsString(),
            Trigger = ParseSkillTrigger(k.Get("trigger").AsString()),
            Value = k.Get("value").AsInt(),
            SpeedPermille = k.Get("speedPermille").AsInt(),
            AccelPermille = k.Get("accelPermille").AsInt(),
            DrainSavePermille = k.Get("drainSavePermille").AsInt(),
            RecoverPermille = k.Get("recoverPermille").AsInt(),
            DurationTicks = k.Get("durationTicks").AsInt(),
        };

        public static JsonNode SkillToJson(SkillSpec k)
        {
            var o = JsonNode.Obj();
            o.Set("id", k.Id);
            o.Set("name", k.Name);
            o.Set("trigger", SkillTriggerToString(k.Trigger));
            o.Set("value", k.Value);
            o.Set("speedPermille", k.SpeedPermille);
            o.Set("accelPermille", k.AccelPermille);
            o.Set("drainSavePermille", k.DrainSavePermille);
            o.Set("recoverPermille", k.RecoverPermille);
            o.Set("durationTicks", k.DurationTicks);
            return o;
        }

        public static string SurfaceToString(Surface s) => s == Surface.Turf ? "turf" : s == Surface.Dirt ? "dirt" : "both";

        public static Surface ParseSurface(string s, bool allowBoth)
        {
            switch (s)
            {
                case "turf": return Surface.Turf;
                case "dirt": return Surface.Dirt;
                case "both":
                    if (allowBoth) return Surface.Both;
                    break;
            }
            throw new FormatException("invalid surface: " + s);
        }

        public static string ModeToString(RaceMode m) => m == RaceMode.Ranked ? "ranked" : m == RaceMode.Friend ? "friend" : m == RaceMode.TimeAttack ? "timeattack" : m == RaceMode.Event ? "event" : m == RaceMode.Tournament ? "tournament" : m == RaceMode.Challenge ? "challenge" : m == RaceMode.Cup ? "cup" : "tutorial";

        public static RaceMode ParseMode(string s)
        {
            switch (s)
            {
                case "ranked": return RaceMode.Ranked;
                case "friend": return RaceMode.Friend;
                case "tutorial": return RaceMode.Tutorial;
                case "timeattack": return RaceMode.TimeAttack;
                case "event": return RaceMode.Event;
                case "tournament": return RaceMode.Tournament;
                case "challenge": return RaceMode.Challenge;
                case "cup": return RaceMode.Cup;
                default: throw new FormatException("invalid mode: " + s);
            }
        }

        // ------------------------------------------------------------- ruleset
        public static RulesetParams ParseRuleset(JsonNode o)
        {
            string version = null;
            var values = new Dictionary<string, long>();
            foreach (var p in o.Props)
            {
                if (p.Key == RulesetParams.VersionKey) version = p.Value.AsString();
                else values[p.Key] = p.Value.AsLong();
            }
            if (version == null) throw new FormatException("ruleset.rulesetVersion required");
            try { return RulesetParams.FromValues(version, values); }
            catch (ArgumentException e) { throw new FormatException(e.Message); }
        }

        public static RulesetParams ParseRuleset(string json) => ParseRuleset(JsonNode.Parse(json));

        public static JsonNode RulesetToJson(RulesetParams p)
        {
            var o = JsonNode.Obj();
            o.Set(RulesetParams.VersionKey, p.RulesetVersion);
            foreach (var kv in p.ToValues()) o.Set(kv.Key, kv.Value);
            return o;
        }

        // ------------------------------------------------------------- config
        public static RaceConfig ParseConfig(string json) => ParseConfig(JsonNode.Parse(json));

        public static RaceConfig ParseConfig(JsonNode o)
        {
            var c = new RaceConfig();
            c.V = o.Get("v").AsInt();
            if (c.V != 1) throw new FormatException("unsupported config version");
            c.RaceId = o.Get("raceId").AsString();
            c.Mode = ParseMode(o.Get("mode").AsString());
            string seed = o.Get("seed").AsString();
            if (!ulong.TryParse(seed, NumberStyles.None, CultureInfo.InvariantCulture, out c.Seed))
                throw new FormatException("seed must be a uint64 base-10 string");

            var t = o.Get("track");
            c.Track = new TrackSpec
            {
                Id = t.Get("id").AsString(),
                Surface = ParseSurface(t.Get("surface").AsString(), false),
                DistanceM = t.Get("distanceM").AsInt(),
            };
            c.Track.Segments.AddRange(ParseSegments(t.Get("segments")));
            if (t.TryGet("going", out var gn) && !gn.IsNull) c.Track.Going = ParseGoing(gn.AsString(), c.Track.Surface);
            if (t.TryGet("night", out var nn) && !nn.IsNull) c.Track.Night = nn.AsBool();

            var n = o.Get("net");
            c.Net = new NetParams
            {
                TickHz = n.Get("tickHz").AsInt(),
                InputDelayTicks = n.Get("inputDelayTicks").AsInt(),
                BundleIntervalTicks = n.Get("bundleIntervalTicks").AsInt(),
                ChecksumIntervalTicks = n.Get("checksumIntervalTicks").AsInt(),
                DisconnectGraceMs = n.Get("disconnectGraceMs").AsInt(),
            };

            c.Ruleset = ParseRuleset(o.Get("ruleset"));

            foreach (var e in o.Get("entrants").Items)
            {
                var kind = e.Get("kind").AsString();
                var ent = new Entrant
                {
                    Slot = e.Get("slot").AsInt(),
                    Kind = kind == "human" ? EntrantKind.Human : kind == "cpu" ? EntrantKind.Cpu : throw new FormatException("invalid entrant kind"),
                    PlayerId = e.Get("playerId").IsNull ? null : e.Get("playerId").AsString(),
                    CpuLevel = e.Get("cpuLevel").AsInt(),
                };
                ent.Horse = ParseHorse(e.Get("horse"));
                c.Entrants.Add(ent);
            }
            try { c.Validate(); }
            catch (ArgumentException ex) { throw new FormatException(ex.Message); }
            return c;
        }

        /// <summary>Track segments as the config writes them (also the practice catalog's courses, protocol §50.1).</summary>
        public static List<TrackSegment> ParseSegments(JsonNode arr)
        {
            var list = new List<TrackSegment>();
            foreach (var s in arr.Items)
            {
                string kind = s.Get("kind").AsString();
                var seg = new TrackSegment { LengthM = s.Get("lengthM").AsInt() };
                if (kind == "straight") seg.Kind = SegmentKind.Straight;
                else if (kind == "corner") { seg.Kind = SegmentKind.Corner; seg.RadiusM = s.Get("radiusM").AsInt(); }
                else throw new FormatException("invalid segment kind: " + kind);
                list.Add(seg);
            }
            return list;
        }

        /// <summary>An entrant's horse (RaceHorse, protocol §2); also the practice catalog's horses (§50.1).</summary>
        public static HorseSpec ParseHorse(JsonNode h)
        {
            var horse = new HorseSpec
            {
                Id = h.Get("id").AsString(),
                Name = h.Get("name").AsString(),
                Speed = h.Get("speed").AsInt(),
                Stamina = h.Get("stamina").AsInt(),
                Burst = h.Get("burst").AsInt(),
                Guts = h.Get("guts").AsInt(),
                Temper = h.Get("temper").AsInt(),
                Style = ParseStyle(h.Get("style").AsString()),
                DistMinM = h.Get("distMinM").AsInt(),
                DistMaxM = h.Get("distMaxM").AsInt(),
                Surface = ParseSurface(h.Get("surface").AsString(), true),
            };
            if (h.TryGet("goingAptitude", out var ga) && !ga.IsNull) horse.GoingAptitude = ParseGoingAptitude(ga.AsString());
            if (h.TryGet("skill", out var sk) && !sk.IsNull) horse.Skill = ParseSkill(sk);
            return horse;
        }

        public static JsonNode HorseToJson(HorseSpec h)
        {
            var ho = JsonNode.Obj();
            ho.Set("id", h.Id);
            ho.Set("name", h.Name);
            ho.Set("speed", h.Speed);
            ho.Set("stamina", h.Stamina);
            ho.Set("burst", h.Burst);
            ho.Set("guts", h.Guts);
            ho.Set("temper", h.Temper);
            ho.Set("style", StyleToString(h.Style));
            ho.Set("distMinM", h.DistMinM);
            ho.Set("distMaxM", h.DistMaxM);
            ho.Set("surface", SurfaceToString(h.Surface));
            if (h.GoingAptitude.HasValue) ho.Set("goingAptitude", GoingAptitudeToString(h.GoingAptitude.Value));
            if (h.Skill != null) ho.Set("skill", SkillToJson(h.Skill));
            return ho;
        }

        public static JsonNode ConfigToJson(RaceConfig c)
        {
            var o = JsonNode.Obj();
            o.Set("v", c.V);
            o.Set("raceId", c.RaceId);
            o.Set("mode", ModeToString(c.Mode));
            o.Set("seed", c.Seed.ToString(CultureInfo.InvariantCulture));
            var t = JsonNode.Obj();
            t.Set("id", c.Track.Id);
            t.Set("surface", SurfaceToString(c.Track.Surface));
            t.Set("distanceM", c.Track.DistanceM);
            var segs = JsonNode.Arr();
            foreach (var s in c.Track.Segments)
            {
                var so = JsonNode.Obj();
                so.Set("kind", s.Kind == SegmentKind.Straight ? "straight" : "corner");
                so.Set("lengthM", s.LengthM);
                if (s.Kind == SegmentKind.Corner) so.Set("radiusM", s.RadiusM);
                segs.Add(so);
            }
            t.Set("segments", segs);
            // optional fields are written only when present, so old configs round-trip byte-for-byte
            if (c.Track.Going.HasValue) t.Set("going", GoingToString(c.Track.Going.Value, c.Track.Surface));
            if (c.Track.Night.HasValue) t.Set("night", JsonNode.Bool(c.Track.Night.Value));
            o.Set("track", t);
            var n = JsonNode.Obj();
            n.Set("tickHz", c.Net.TickHz);
            n.Set("inputDelayTicks", c.Net.InputDelayTicks);
            n.Set("bundleIntervalTicks", c.Net.BundleIntervalTicks);
            n.Set("checksumIntervalTicks", c.Net.ChecksumIntervalTicks);
            n.Set("disconnectGraceMs", c.Net.DisconnectGraceMs);
            o.Set("net", n);
            o.Set("ruleset", RulesetToJson(c.Ruleset));
            var es = JsonNode.Arr();
            foreach (var e in c.Entrants)
            {
                var eo = JsonNode.Obj();
                eo.Set("slot", e.Slot);
                eo.Set("kind", e.Kind == EntrantKind.Human ? "human" : "cpu");
                eo.Set("playerId", JsonNode.Str(e.PlayerId));
                eo.Set("cpuLevel", e.CpuLevel);
                eo.Set("horse", HorseToJson(e.Horse));
                es.Add(eo);
            }
            o.Set("entrants", es);
            return o;
        }

        // ------------------------------------------------------------- inputs / replay log
        public static List<InputRecord> ParseInputs(JsonNode arr)
        {
            var list = new List<InputRecord>();
            foreach (var r in arr.Items)
            {
                if (r.Kind != JsonKind.Array || r.Count != 3) throw new FormatException("input must be [tick, slot, cmd]");
                int cmd = r[2].AsInt();
                if (cmd < 0 || cmd > 255) throw new FormatException("cmd must be 0..255");
                list.Add(new InputRecord(r[0].AsInt(), r[1].AsInt(), (byte)cmd));
            }
            return list;
        }

        public static JsonNode InputsToJson(IEnumerable<InputRecord> inputs)
        {
            var a = JsonNode.Arr();
            foreach (var r in inputs) a.Add(JsonNode.Arr().Add(JsonNode.Num(r.Tick)).Add(JsonNode.Num(r.Slot)).Add(JsonNode.Num(r.Cmd)));
            return a;
        }

        public static ReplayLog ParseReplayLog(string json) => ParseReplayLog(JsonNode.Parse(json));

        public static ReplayLog ParseReplayLog(JsonNode o)
        {
            if (o.Get("v").AsInt() != 1) throw new FormatException("unsupported log version");
            var log = new ReplayLog
            {
                Config = ParseConfig(o.Get("config")),
                EndTick = o.Get("endTick").AsInt(),
                Inputs = ParseInputs(o.Get("inputs")),
            };
            int prevTick = -1, prevSlot = -1;
            foreach (var r in log.Inputs)
            {
                if (r.Slot < 0 || r.Slot >= log.Config.Entrants.Count) throw new FormatException("input slot out of range");
                if (r.Tick < 0 || r.Tick >= log.Config.Ruleset.MaxTicks) throw new FormatException("input tick out of range");
                if (r.Tick < prevTick || (r.Tick == prevTick && r.Slot <= prevSlot)) throw new FormatException("inputs must be sorted by tick then slot without duplicates");
                prevTick = r.Tick; prevSlot = r.Slot;
            }
            return log;
        }

        public static JsonNode ReplayLogToJson(ReplayLog log)
        {
            var o = JsonNode.Obj();
            o.Set("v", 1);
            o.Set("config", ConfigToJson(log.Config));
            o.Set("endTick", log.EndTick);
            o.Set("inputs", InputsToJson(log.Inputs));
            return o;
        }

        /// <summary>Verifier response body (contracts/protocol.md §8).</summary>
        public static JsonNode VerifyOutputToJson(ReplayOutput r)
        {
            var o = JsonNode.Obj();
            o.Set("resultHash", r.Result.Hash);
            var order = JsonNode.Arr();
            foreach (var s in r.Result.Order) order.Add(JsonNode.Num(s));
            o.Set("order", order);
            var ft = JsonNode.Arr();
            foreach (var f in r.Result.FinishTicks) ft.Add(JsonNode.Num(f));
            o.Set("finishTicks", ft);
            // finishFracs: Q16.16 fraction of the finish tick per place (-1 = did not finish); lets the server
            // compute exact race times (time attack) without re-simulating.
            var ff = JsonNode.Arr();
            for (int i = 0; i < r.Result.FinishTicks.Length; i++) ff.Add(JsonNode.Num(r.Result.FinishTicks[i] >= 0 ? r.Result.FinishFracOrDistanceRaw[i] : -1));
            o.Set("finishFracs", ff);
            var cs = JsonNode.Obj();
            foreach (var kv in r.Checksums) cs.Set(kv.Key.ToString(CultureInfo.InvariantCulture), kv.Value);
            o.Set("checksums", cs);
            return o;
        }
    }
}
