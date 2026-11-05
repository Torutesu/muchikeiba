using System;
using System.Collections.Generic;

namespace Muchi.Engine
{
    /// <summary>One confirmed input: [tick, slot, cmd] (contracts/protocol.md §7).</summary>
    public struct InputRecord
    {
        public int Tick;
        public int Slot;
        public byte Cmd;

        public InputRecord(int tick, int slot, byte cmd) { Tick = tick; Slot = slot; Cmd = cmd; }
    }

    public sealed class ReplayOutput
    {
        public RaceResult Result;
        /// <summary>tick → checksum, in tick order.</summary>
        public SortedDictionary<int, string> Checksums = new SortedDictionary<int, string>();
        public RaceSim Sim;
    }

    /// <summary>Re-runs a race from its config and confirmed inputs (REQ-RACE-073, REQ-VER-001).</summary>
    public static class RaceReplay
    {
        public static ReplayOutput Run(RaceConfig config, IList<InputRecord> inputs)
        {
            var sim = new RaceSim(config);
            var outp = new ReplayOutput { Sim = sim };
            var byTick = new SortedDictionary<int, List<InputRecord>>();
            foreach (var r in inputs)
            {
                if (r.Slot < 0 || r.Slot >= config.Entrants.Count) throw new ArgumentException("input slot out of range");
                if (r.Tick < 0 || r.Tick >= config.Ruleset.MaxTicks) throw new ArgumentException("input tick out of range");
                if (!byTick.TryGetValue(r.Tick, out var list)) byTick[r.Tick] = list = new List<InputRecord>();
                list.Add(r);
            }
            var cmds = new byte[config.Entrants.Count];
            while (!sim.IsFinished)
            {
                Array.Clear(cmds, 0, cmds.Length);
                if (byTick.TryGetValue(sim.Tick, out var list))
                    foreach (var r in list) cmds[r.Slot] |= r.Cmd;
                sim.Step(cmds);
                if (sim.ChecksumDueForLastTick) outp.Checksums[sim.LastChecksumTick] = sim.LastChecksum;
            }
            outp.Result = sim.Result;
            return outp;
        }
    }
}
