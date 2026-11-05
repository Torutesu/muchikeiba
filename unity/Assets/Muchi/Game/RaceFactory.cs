using System;
using Muchi.Client;
using Muchi.Engine;
using Muchi.Net;

namespace Muchi.Game
{
    /// <summary>Offline race configs for the app (tutorial and practice). Online races come from the server.</summary>
    public static class RaceFactory
    {
        /// <summary>Practice course: same layout as the server's kirameki_turf_2000 (server/master/tracks.json).</summary>
        public static TrackSpec PracticeTrack() => new TrackSpec
        {
            Id = "kirameki_turf_2000",
            Surface = Surface.Turf,
            DistanceM = 2000,
            Segments =
            {
                new TrackSegment(SegmentKind.Straight, 300),
                new TrackSegment(SegmentKind.Corner, 300, 110),
                new TrackSegment(SegmentKind.Straight, 450),
                new TrackSegment(SegmentKind.Corner, 450, 110),
                new TrackSegment(SegmentKind.Straight, 500),
            },
        };

        private static readonly string[] CpuNames =
        {
            "ハヤテノツバサ", "ユウヤケボシ", "アオゾラマーチ", "シラカバノオカ", "ナミノリタロウ", "ツキミダンゴ",
            "ホシクズノミチ", "コハルビヨリ", "カゼマチリボン", "ミナモノヒカリ", "サクラフブキ",
        };

        public static RulesetParams ParseRuleset(string json) => ProtocolCodec.ParseRuleset(json);

        /// <summary>First ride (tutorial "いきなり本番"): 400 m straight, auto start, only the whip matters.</summary>
        public static RaceConfig Tutorial(RulesetParams ruleset) => OfflinePresets.Tutorial(ruleset);

        /// <summary>12-runner practice race on the 2000 m practice course; the player is slot 0 (gate 1).</summary>
        public static RaceConfig Practice(RulesetParams ruleset, HorseSpec player, ulong seed)
        {
            var cfg = new RaceConfig { RaceId = "offline_practice", Mode = RaceMode.Friend, Seed = seed, Ruleset = ruleset, Track = PracticeTrack() };
            cfg.Entrants.Add(new Entrant { Slot = 0, Kind = EntrantKind.Human, PlayerId = "local", CpuLevel = 3, Horse = player });
            var rng = new Random((int)(seed & 0x7fffffff));
            for (int i = 1; i < 12; i++)
            {
                int Stat() => 430 + rng.Next(0, 140);
                cfg.Entrants.Add(new Entrant
                {
                    Slot = i, Kind = EntrantKind.Cpu, CpuLevel = 3,
                    Horse = new HorseSpec
                    {
                        Id = "cpu" + i, Name = CpuNames[i - 1], Speed = Stat(), Stamina = Stat(), Burst = Stat(), Guts = Stat(), Temper = Stat(),
                        Style = (RunningStyle)(i % 4), DistMinM = 1600, DistMaxM = 2400, Surface = Surface.Turf,
                    },
                });
            }
            cfg.Validate();
            return cfg;
        }

        /// <summary>A default partner for offline play (stats like a fresh SR horse).</summary>
        public static HorseSpec DefaultPartner(string name) => new HorseSpec
        {
            Id = "local_partner", Name = string.IsNullOrEmpty(name) ? "アイボウ" : name,
            Speed = 560, Stamina = 540, Burst = 580, Guts = 520, Temper = 600,
            Style = RunningStyle.Sashi, DistMinM = 1600, DistMaxM = 2400, Surface = Surface.Turf,
        };

        /// <summary>Server horse → engine horse (offline practice with your real partner).</summary>
        public static HorseSpec FromServer(Horse h)
        {
            if (h == null) return DefaultPartner(null);
            var b = h.Base ?? new Stats();
            return new HorseSpec
            {
                Id = h.Id, Name = h.Name ?? "アイボウ",
                Speed = Clamp(b.Speed), Stamina = Clamp(b.Stamina), Burst = Clamp(b.Burst), Guts = Clamp(b.Guts), Temper = Clamp(b.Temper),
                Style = StyleOf(h.Style), DistMinM = h.DistMinM > 0 ? h.DistMinM : 1600, DistMaxM = h.DistMaxM > 0 ? h.DistMaxM : 2400,
                Surface = h.Surface == "dirt" ? Surface.Dirt : h.Surface == "both" ? Surface.Both : Surface.Turf,
            };
        }

        private static int Clamp(int v) => Math.Max(0, Math.Min(1000, v));

        public static RunningStyle StyleOf(string s)
        {
            switch (s)
            {
                case "nige": return RunningStyle.Nige;
                case "senko": return RunningStyle.Senko;
                case "oikomi": return RunningStyle.Oikomi;
                default: return RunningStyle.Sashi;
            }
        }

        /// <summary>Japanese style name for screens.</summary>
        public static string StyleLabel(string s)
        {
            switch (s)
            {
                case "nige": return "逃げ";
                case "senko": return "先行";
                case "oikomi": return "追込";
                case "sashi": return "差し";
                default: return s ?? "";
            }
        }
    }
}
