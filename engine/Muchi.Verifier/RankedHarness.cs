using System.Globalization;
using System.Text;
using Muchi.Engine;
using Muchi.Net;

namespace Muchi.Verifier
{
    // =====================================================================================
    // Ranked winnability harness (quality pass 2, docs/quality/ranked.md, docs/spec/balance-targets.md §2.5).
    // Rides the ranked fields the server issues (contracts/ranked-fields.sample.json: the matchmaker's CPU fill, the class
    // cap, the course draw and the day's going, built by server/src/domain/rankedSample.ts) with three riders — a
    // button-masher, an average rider and a skilled rider — and reports win / top-3 rates per class × horse × rider.
    // Every rider rides the same fields (paired), fixed seeds, so the numbers are reproducible and asserted in CI.
    // =====================================================================================

    /// <summary>
    /// "連打する人": taps START some ticks after the gate, never touches the rein or the lanes, and from 800 m out mashes the
    /// whip button (press, release on the next tick) every few ticks. In 1.3 the early whips are wasted (早打ち); in 1.4 the
    /// first press in the window is an instant plain go (no gather), the rest are whips off the rhythm.
    /// </summary>
    public sealed class MasherRider : IRider
    {
        private Pcg32 _rng;
        private int _startDelay, _next, _released = -1;

        public void Reset(RaceSim sim, int slot, ulong seed) { _rng = new Pcg32(seed, 91); _startDelay = _rng.Range(0, 13); _next = -1; _released = -1; }

        public byte Decide(RaceSim sim, int slot, int t)
        {
            var me = sim.GetHorse(slot);
            if (me.Finished) return 0;
            if (!me.Departed) return t >= sim.P.GateOpenTick + _startDelay ? Cmd.Start : (byte)0;
            if (_released == t) return Cmd.Start; // the release of the tap one tick ago
            long rem = RiderUtil.RemainingM(sim, me);
            if (rem > 800) return 0;
            if (_next < 0) _next = t;
            if (t < _next) return 0;
            _next = t + 3 + _rng.Range(0, 6);
            _released = t + 1;
            return Cmd.Whip;
        }
    }

    /// <summary>The skilled rider of the ruleset in the race: <see cref="SkilledRider"/> in 1.3 and older, <see cref="TacticalRider"/> in 1.4.</summary>
    public sealed class BestRider : IRider
    {
        private IRider _r;
        public void Reset(RaceSim sim, int slot, ulong seed) { _r = sim.TacticsEnabled ? new TacticalRider() : (IRider)new SkilledRider(); _r.Reset(sim, slot, seed); }
        public byte Decide(RaceSim sim, int slot, int t) => _r.Decide(sim, slot, t);
    }

    public sealed class RankedSampleRace
    {
        public RaceConfig Config;
        public int Slot;
        /// <summary>The player's horse is outside its distance or surface aptitude on this course (−aptitudeOutPenalty each).</summary>
        public bool PlayerOffAptitude;
    }

    public sealed class RankedSampleSet
    {
        public string ClassId, Horse, Stage;
        public bool Beginner;
        public int Rating, StatCap;
        public List<RankedSampleRace> Races = new List<RankedSampleRace>();
        /// <summary>Free coins per place in ranked (progression.raceFreeCoinsByPlace.ranked).</summary>
        public int[] CoinsByPlace = new int[0];
        /// <summary>The economy sim's assumption: every place equally likely (the mean of <see cref="CoinsByPlace"/>).</summary>
        public double UniformCoins => CoinsByPlace.Length == 0 ? 0 : CoinsByPlace.Average();
        public string Key => ClassId + "/" + Horse + "/" + Stage;
        public string Label => ClassId + (Stage == "beginner" ? "（初心者マッチ 1〜5戦）" : Stage == "ramp" ? "（6〜15戦）" : "") + " / " + (Horse == "starter" ? "相棒" : "30日目");
    }

    public sealed class RankedCell
    {
        public string Set, Rider;
        public int Races, Wins, Top3;
        public double AvgPlace;
        public int OffRaces, OffWins;
        public double AvgCoins;
        /// <summary>Expected ranked coins per race ÷ the economy sim's uniform-place value (1 = exactly what E1 assumes).</summary>
        public double CoinsVsUniform;
        public string SetKey, Ruleset;
        /// <summary>Finishes per place (index 0 = 1st).</summary>
        public int[] Places = new int[12];
        public double Win => Races == 0 ? 0 : (double)Wins / Races;
        public double Top3Rate => Races == 0 ? 0 : (double)Top3 / Races;
    }

    public static class RankedHarness
    {
        public static readonly string[] Riders = { "masher", "average", "skilled" };

        public static IRider NewRider(string id) => id switch
        {
            "masher" => new MasherRider(),
            "average" => new CasualRider(),
            "skilled" => new BestRider(),
            _ => throw new ArgumentException("rider " + id),
        };

        /// <summary>Expands the compact sample (one copy of every horse / course / net block) into the exact configs.</summary>
        public static List<RankedSampleSet> Load(string path, RulesetParams rulesetOverride = null)
        {
            var root = JsonNode.Parse(File.ReadAllText(path));
            var horses = root.Get("horses");
            var tracks = root.Get("tracks");
            var sets = new List<RankedSampleSet>();
            var coins = root.Has("coinsByPlace") ? root.Get("coinsByPlace").Items.Select(x => x.AsInt()).ToArray() : new int[0];
            foreach (var s in root.Get("sets").Items)
            {
                var set = new RankedSampleSet
                {
                    ClassId = s.Get("classId").AsString(), Horse = s.Get("horse").AsString(), Stage = s.Get("stage").AsString(), Beginner = s.Get("beginner").AsBool(),
                    Rating = s.Get("rating").AsInt(), StatCap = s.Get("statCap").AsInt(), CoinsByPlace = coins,
                };
                foreach (var r in s.Get("races").Items)
                {
                    var cfg = JsonNode.Obj().Set("v", 1).Set("raceId", r.Get("raceId").AsString()).Set("mode", "ranked").Set("seed", r.Get("seed").AsString())
                        .Set("track", tracks.Get(r.Get("track").AsString())).Set("net", root.Get("net")).Set("ruleset", root.Get("ruleset"));
                    var ents = JsonNode.Arr();
                    var list = r.Get("entrants");
                    for (int i = 0; i < list.Count; i++)
                    {
                        var e = list[i];
                        bool human = !e[2].IsNull;
                        ents.Add(JsonNode.Obj().Set("slot", i).Set("kind", human ? "human" : "cpu").Set("playerId", human ? JsonNode.Str(e[2].AsString()) : JsonNode.Null())
                            .Set("cpuLevel", e[1].AsInt()).Set("horse", horses.Get(e[0].AsString())));
                    }
                    cfg.Set("entrants", ents);
                    var config = ProtocolCodec.ParseConfig(cfg);
                    if (rulesetOverride != null) config.Ruleset = rulesetOverride;
                    int slot = r.Get("playerSlot").AsInt();
                    var h = config.Entrants[slot].Horse;
                    bool off = config.Track.DistanceM < h.DistMinM || config.Track.DistanceM > h.DistMaxM || (h.Surface != Surface.Both && h.Surface != config.Track.Surface);
                    set.Races.Add(new RankedSampleRace { Config = config, Slot = slot, PlayerOffAptitude = off });
                }
                sets.Add(set);
            }
            return sets;
        }

        public static RankedCell Ride(RankedSampleSet set, string rider, int maxRaces = int.MaxValue)
        {
            var c = new RankedCell { Set = set.Label, SetKey = set.Key, Rider = rider, Ruleset = set.Races.Count > 0 ? set.Races[0].Config.Ruleset.RulesetVersion : "" };
            long places = 0, coins = 0;
            int n = 0;
            foreach (var r in set.Races)
            {
                if (n++ >= maxRaces) break;
                ulong seed = r.Config.Seed;
                var sim = BalanceHarness.Run(r.Config, new Dictionary<int, IRider> { [r.Slot] = NewRider(rider) }, seed);
                int pl = BalanceHarness.PlaceOf(sim, r.Slot);
                c.Races++; places += pl + 1;
                if (pl < c.Places.Length) c.Places[pl]++;
                if (pl < set.CoinsByPlace.Length) coins += set.CoinsByPlace[pl];
                if (pl == 0) c.Wins++;
                if (pl < 3) c.Top3++;
                if (r.PlayerOffAptitude) { c.OffRaces++; if (pl == 0) c.OffWins++; }
            }
            c.AvgPlace = c.Races == 0 ? 0 : (double)places / c.Races;
            c.AvgCoins = c.Races == 0 ? 0 : (double)coins / c.Races;
            c.CoinsVsUniform = set.UniformCoins == 0 ? 0 : c.AvgCoins / set.UniformCoins;
            return c;
        }

        public static List<RankedCell> RunAll(List<RankedSampleSet> sets, int maxRaces = int.MaxValue)
        {
            var cells = new List<RankedCell>();
            foreach (var s in sets)
                foreach (var r in Riders)
                    cells.Add(Ride(s, r, maxRaces));
            return cells;
        }

        /// <summary>
        /// contracts/ranked-places.vectors.json: every cell's place counts, which the economy test replays as the ranked places of
        /// a free player (server/test/economy.test.ts, W8: E1 holds at the places the field really gives an average rider).
        /// </summary>
        public static string Vectors(IEnumerable<RankedCell> cells)
        {
            var sb = new StringBuilder();
            sb.Append("{\n \"_note\": \"Written by Muchi.Verifier harness-ranked-vectors (RankedHarness.Vectors) from contracts/ranked-fields.sample.json on rulesets 1.3.0 and 1.4.0; checked by BalanceTests.RankedFieldsMeetTheWinnabilityTargets. Do not edit.\",\n \"cells\": [\n");
            bool first = true;
            foreach (var c in cells)
            {
                if (!first) sb.Append(",\n");
                first = false;
                sb.Append("  {\"set\": \"" + c.SetKey + "\", \"ruleset\": \"" + c.Ruleset + "\", \"rider\": \"" + c.Rider + "\", \"races\": " + c.Races + ", \"places\": [" + string.Join(", ", c.Places) + "]}");
            }
            sb.Append("\n ]\n}\n");
            return sb.ToString();
        }

        public static string Markdown(List<RankedCell> cells)
        {
            var sb = new StringBuilder();
            sb.AppendLine("| クラス / 馬 | 乗り手 | レース | 勝率 | 3着以内 | 平均着順 | 適性外のレース | 適性外での勝ち | コイン/レース（÷ 一様） |");
            sb.AppendLine("|---|---|---|---|---|---|---|---|---|");
            foreach (var c in cells)
                sb.AppendLine("| " + c.Set + " | " + c.Rider + " | " + c.Races + " | " + (c.Win * 100).ToString("F1", CultureInfo.InvariantCulture) + "% | "
                    + (c.Top3Rate * 100).ToString("F1", CultureInfo.InvariantCulture) + "% | " + c.AvgPlace.ToString("F2", CultureInfo.InvariantCulture) + " | " + c.OffRaces + " | " + c.OffWins + " | "
                    + c.AvgCoins.ToString("F1", CultureInfo.InvariantCulture) + "（" + c.CoinsVsUniform.ToString("F2", CultureInfo.InvariantCulture) + "） |");
            return sb.ToString();
        }
    }
}
