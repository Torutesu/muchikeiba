using System.Globalization;
using System.Text;
using Muchi.Engine;

namespace Muchi.Verifier
{
    /// <summary>Monte-Carlo balance measurement over CPU-only races (used by tests and the `balance` command).</summary>
    public sealed class BalanceReport
    {
        public int Races;
        public int Dnf;
        public long WinnerTicksSum, LastTicksSum;
        public int MinWinnerTicks = int.MaxValue, MaxLastTicks;
        public int[] StyleRunners = new int[4];
        public int[] StyleWins = new int[4];
        public int StrongestWins;          // horse with the highest stat total won
        public int StrongestTop3;
        public int ExhaustedFinishers;     // finished with zero stamina
        public int Finishers;
        public long[] StyleSpurtStaminaPermille = new long[4];
        public long[] StyleSpurtRankSum = new long[4];
        public int[] StyleSpurtCount = new int[4];
        public int[] AptRunners = new int[3];   // by GoingAptitude (any / fast / heavy)
        public int[] AptWins = new int[3];
        public double AptWinRate(GoingAptitude a) => AptRunners[(int)a] == 0 ? 0 : (double)AptWins[(int)a] / AptRunners[(int)a];

        public double AvgWinnerSeconds(int tickHz, int gate) => (double)WinnerTicksSum / Races / tickHz - (double)gate / tickHz;
        public double AvgLastSeconds(int tickHz, int gate) => (double)LastTicksSum / Races / tickHz - (double)gate / tickHz;

        public double StyleWinRate(RunningStyle s) => StyleRunners[(int)s] == 0 ? 0 : (double)StyleWins[(int)s] / StyleRunners[(int)s];

        public string Describe(int tickHz, int gate)
        {
            var sb = new StringBuilder();
            var ci = CultureInfo.InvariantCulture;
            sb.AppendLine("races=" + Races + " dnf=" + Dnf);
            sb.AppendLine("winner avg " + AvgWinnerSeconds(tickHz, gate).ToString("F1", ci) + "s, last avg " + AvgLastSeconds(tickHz, gate).ToString("F1", ci) + "s");
            sb.AppendLine("fastest winner " + ((double)(MinWinnerTicks - gate) / tickHz).ToString("F1", ci) + "s, slowest last " + ((double)(MaxLastTicks - gate) / tickHz).ToString("F1", ci) + "s");
            for (int s = 0; s < 4; s++)
                sb.AppendLine(((RunningStyle)s) + " win-rate-per-runner " + StyleWinRate((RunningStyle)s).ToString("P1", ci) + " (runners " + StyleRunners[s] + ", wins " + StyleWins[s] + ")");
            sb.AppendLine("strongest horse wins " + ((double)StrongestWins / Races).ToString("P1", ci) + ", top3 " + ((double)StrongestTop3 / Races).ToString("P1", ci) + " (uniform = 8.3% / 25%)");
            for (int s = 0; s < 4; s++)
                if (StyleSpurtCount[s] > 0)
                    sb.AppendLine(((RunningStyle)s) + " at spurt: stamina " + (StyleSpurtStaminaPermille[s] / StyleSpurtCount[s]) + "‰ rank " + ((double)StyleSpurtRankSum[s] / StyleSpurtCount[s]).ToString("F1", ci));
            if (AptRunners[1] + AptRunners[2] > 0)
                for (int a = 0; a < 3; a++)
                    sb.AppendLine("goingAptitude " + ((GoingAptitude)a) + " win-rate-per-runner " + AptWinRate((GoingAptitude)a).ToString("P1", ci) + " (runners " + AptRunners[a] + ")");
            sb.AppendLine("finishers with empty stamina " + ((double)ExhaustedFinishers / Math.Max(1, Finishers)).ToString("P1", ci));
            return sb.ToString();
        }
    }

    public static class BalanceProbe
    {
        /// <param name="aptMix">Give slots goingAptitude any/fast/heavy round-robin and report win rates per aptitude.</param>
        public static BalanceReport Run(RulesetParams ruleset, int races, ulong seedBase = 1, int spread = 150, TrackSpec track = null, bool aptMix = false)
        {
            var rep = new BalanceReport();
            for (int r = 0; r < races; r++)
            {
                var rng = new Pcg32(seedBase + (ulong)r * 7919UL, 3);
                var horses = new List<HorseSpec>();
                for (int i = 0; i < 12; i++) horses.Add(SampleRaces.RandomHorse(ref rng, "b" + i, 500, spread));
                var surface = (track ?? SampleRaces.Turf2000()).Surface;
                for (int i = 0; i < 12; i++)
                {
                    horses[i].Surface = surface; // measure the ground, not surface aptitude
                    if (aptMix) horses[i].GoingAptitude = (GoingAptitude)(i % 3);
                }
                var cfg = SampleRaces.Config("balance_" + r, SeedMix.Mix(seedBase + (ulong)r), track ?? SampleRaces.Turf2000(), ruleset, horses, 0, 3);
                var sim = new RaceSim(cfg);
                var seen = new bool[12];
                while (!sim.IsFinished)
                {
                    sim.Step(null);
                    for (int i = 0; i < 12; i++)
                    {
                        var hs = sim.GetHorse(i);
                        if (hs.InSpurt && !seen[i])
                        {
                            seen[i] = true;
                            int st = (int)horses[i].Style;
                            rep.StyleSpurtCount[st]++;
                            rep.StyleSpurtStaminaPermille[st] += hs.StaminaPermille;
                            rep.StyleSpurtRankSum[st] += hs.Rank;
                        }
                    }
                }
                var outp = new ReplayOutput { Sim = sim, Result = sim.Result };
                var res = outp.Result;
                rep.Races++;
                int strongest = 0, best = -1;
                for (int i = 0; i < 12; i++)
                {
                    var h = horses[i];
                    int total = h.Speed + h.Stamina + h.Burst + h.Guts;
                    if (total > best) { best = total; strongest = i; }
                    rep.StyleRunners[(int)h.Style]++;
                }
                rep.StyleWins[(int)horses[res.Order[0]].Style]++;
                if (aptMix)
                {
                    for (int i = 0; i < 12; i++) rep.AptRunners[i % 3]++;
                    rep.AptWins[res.Order[0] % 3]++;
                }
                if (res.Order[0] == strongest) rep.StrongestWins++;
                for (int p = 0; p < 3; p++) if (res.Order[p] == strongest) rep.StrongestTop3++;
                int win = res.FinishTicks[0];
                int last = res.FinishTicks[11];
                if (win < 0 || last < 0) { rep.Dnf++; continue; }
                rep.WinnerTicksSum += win;
                rep.LastTicksSum += last;
                rep.MinWinnerTicks = Math.Min(rep.MinWinnerTicks, win);
                rep.MaxLastTicks = Math.Max(rep.MaxLastTicks, last);
                for (int i = 0; i < 12; i++)
                {
                    var hs = outp.Sim.GetHorse(i);
                    if (hs.Finished) { rep.Finishers++; if (hs.Stamina.Raw == 0) rep.ExhaustedFinishers++; }
                }
            }
            return rep;
        }
    }
}
