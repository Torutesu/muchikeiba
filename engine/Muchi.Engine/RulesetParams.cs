using System;
using System.Collections.Generic;

namespace Muchi.Engine
{
    /// <summary>
    /// All race tuning values (REQ-RACE-049). The key set must equal
    /// contracts/ruleset-params.default.json exactly; values are integers.
    /// Nothing here has a default: the server always sends the full set.
    /// </summary>
    public sealed class RulesetParams
    {
        public string RulesetVersion;

        public int MaxTicks;
        public int GateOpenTick;
        public int StartReactionWindowTicks;
        public int StartBoostPermille;
        public int StartBoostTicks;
        public int AutoStartDelayTicks;
        public int LaneCount;
        public int LaneWidthMm;
        public int LaneChangeTicks;
        public int LaneChangeClearanceMm;
        public int BlockRangeMm;
        public int MinGapMm;
        public int SlipstreamRangeMm;
        public int SlipstreamSavePermille;
        public int BaseCruiseSpeedMmPerSec;
        public int SpeedStatBonusMmPerSecPer1000;
        public int CruiseSpeedPermille;
        public int AccelMmPerSec2;
        public int DecelMmPerSec2;
        public int ReinSpeedPermille;
        public int ReinDrainPermille;
        public int SpurtDistanceM;
        public int SpurtSpeedBonusMaxMmPerSec;
        public int StaminaBase;
        public int StaminaPerStatPoint;
        public int DrainMicroPerSpeedSqPerTick;
        public int GutsFloorMinPermille;
        public int GutsFloorMaxPermille;
        public int AptitudeOutPenaltyPermille;
        public int BadComposureThreshold;
        public int BadComposureExtraDrainPermille;
        public int KakariChancePer100000PerTickAtTemper0;
        public int KakariDurationTicks;
        public int KakariComposureLossPerTick;
        public int ReinComposureRecoverPerTick;
        public int NaturalComposureRecoverPerTick;
        public int BlockedComposureLossIntervalTicks;
        public int MaxWhips;
        public int WhipEffectTicks;
        public int WhipAccelBonusMmPerSec2;
        public int WhipSpeedBonusMmPerSec;
        public int WhipDiminishWindowTicks;
        public int WhipDiminishPermille;
        public int EarlyWhipEffectPermille;
        public int EarlyWhipComposurePenalty;
        public int WhipStaminaCost;
        public int CpuDecisionIntervalTicks;
        public int CpuWhipIntervalTicks;
        public int CpuWhipStartDistanceM;
        public int CpuTargetRankNigePermille;
        public int CpuTargetRankSenkoPermille;
        public int CpuTargetRankSashiPermille;
        public int CpuTargetRankOikomiPermille;

        // ---- ground conditions (ruleset additions; REQ-RACE-034/035) ----
        // Indexed by Going (0 firm|fast, 1 good, 2 yielding|muddy, 3 soft|sloppy).
        public readonly int[] GoingTurfSpeedPermille = { 1000, 1000, 1000, 1000 };
        public readonly int[] GoingDirtSpeedPermille = { 1000, 1000, 1000, 1000 };
        public readonly int[] GoingTurfDrainPermille = { 1000, 1000, 1000, 1000 };
        public readonly int[] GoingDirtDrainPermille = { 1000, 1000, 1000, 1000 };
        /// <summary>Dirt is slower than turf at the same going.</summary>
        public int DirtSpeedPermille = 1000;
        /// <summary>Top-speed bonus for a horse whose GoingAptitude matches the ground (and the same penalty when opposite).</summary>
        public int GoingSpecialistPermille;
        /// <summary>True when the ground keys were present (they are optional so pre-1.1 rulesets in stored replays still parse).</summary>
        public bool HasGoingKeys;

        /// <summary>Every integer key, in canonical order (rulesetVersion is the extra string key).</summary>
        public static readonly string[] IntKeys =
        {
            "maxTicks", "gateOpenTick", "startReactionWindowTicks", "startBoostPermille", "startBoostTicks",
            "autoStartDelayTicks", "laneCount", "laneWidthMm", "laneChangeTicks", "laneChangeClearanceMm",
            "blockRangeMm", "minGapMm", "slipstreamRangeMm", "slipstreamSavePermille", "baseCruiseSpeedMmPerSec",
            "speedStatBonusMmPerSecPer1000", "cruiseSpeedPermille", "accelMmPerSec2", "decelMmPerSec2",
            "reinSpeedPermille", "reinDrainPermille", "spurtDistanceM", "spurtSpeedBonusMaxMmPerSec",
            "staminaBase", "staminaPerStatPoint", "drainMicroPerSpeedSqPerTick", "gutsFloorMinPermille",
            "gutsFloorMaxPermille", "aptitudeOutPenaltyPermille", "badComposureThreshold",
            "badComposureExtraDrainPermille", "kakariChancePer100000PerTickAtTemper0", "kakariDurationTicks",
            "kakariComposureLossPerTick", "reinComposureRecoverPerTick", "naturalComposureRecoverPerTick",
            "blockedComposureLossIntervalTicks", "maxWhips", "whipEffectTicks", "whipAccelBonusMmPerSec2",
            "whipSpeedBonusMmPerSec", "whipDiminishWindowTicks", "whipDiminishPermille", "earlyWhipEffectPermille",
            "earlyWhipComposurePenalty", "whipStaminaCost", "cpuDecisionIntervalTicks", "cpuWhipIntervalTicks", "cpuWhipStartDistanceM",
            "cpuTargetRankNigePermille", "cpuTargetRankSenkoPermille", "cpuTargetRankSashiPermille",
            "cpuTargetRankOikomiPermille",
        };

        public const string VersionKey = "rulesetVersion";

        /// <summary>
        /// Keys added after the first ruleset. They may be absent (stored replays from before they existed);
        /// absent keys take the neutral value below, which reproduces the old behaviour exactly.
        /// Either all of them are present or none (partial sets are rejected).
        /// </summary>
        public static readonly string[] OptionalIntKeys =
        {
            "goingTurfFirmSpeedPermille", "goingTurfGoodSpeedPermille", "goingTurfYieldingSpeedPermille", "goingTurfSoftSpeedPermille",
            "goingDirtFastSpeedPermille", "goingDirtGoodSpeedPermille", "goingDirtMuddySpeedPermille", "goingDirtSloppySpeedPermille",
            "goingTurfFirmDrainPermille", "goingTurfGoodDrainPermille", "goingTurfYieldingDrainPermille", "goingTurfSoftDrainPermille",
            "goingDirtFastDrainPermille", "goingDirtGoodDrainPermille", "goingDirtMuddyDrainPermille", "goingDirtSloppyDrainPermille",
            "dirtSpeedPermille", "goingSpecialistPermille",
        };

        /// <summary>Neutral values for <see cref="OptionalIntKeys"/> (same order).</summary>
        public static readonly int[] OptionalNeutralValues =
        {
            1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000,
            1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000,
            1000, 0,
        };

        /// <summary>Builds params from a key/value map. Missing or unknown keys throw ArgumentException.</summary>
        public static RulesetParams FromValues(string rulesetVersion, IDictionary<string, long> values)
        {
            if (string.IsNullOrEmpty(rulesetVersion)) throw new ArgumentException("rulesetVersion required");
            var known = new HashSet<string>(IntKeys);
            foreach (var k in OptionalIntKeys) known.Add(k);
            foreach (var k in values.Keys)
                if (!known.Contains(k)) throw new ArgumentException("unknown ruleset key: " + k);
            int optionalPresent = 0;
            foreach (var k in OptionalIntKeys) if (values.ContainsKey(k)) optionalPresent++;
            if (optionalPresent != 0 && optionalPresent != OptionalIntKeys.Length)
                throw new ArgumentException("ground-condition ruleset keys must be all present or all absent");
            foreach (var k in IntKeys)
                if (!values.ContainsKey(k)) throw new ArgumentException("missing ruleset key: " + k);

            var p = new RulesetParams { RulesetVersion = rulesetVersion };
            int G(string k)
            {
                long v = values[k];
                if (v < int.MinValue || v > int.MaxValue) throw new ArgumentException("ruleset value out of range: " + k);
                return (int)v;
            }
            p.MaxTicks = G("maxTicks");
            p.GateOpenTick = G("gateOpenTick");
            p.StartReactionWindowTicks = G("startReactionWindowTicks");
            p.StartBoostPermille = G("startBoostPermille");
            p.StartBoostTicks = G("startBoostTicks");
            p.AutoStartDelayTicks = G("autoStartDelayTicks");
            p.LaneCount = G("laneCount");
            p.LaneWidthMm = G("laneWidthMm");
            p.LaneChangeTicks = G("laneChangeTicks");
            p.LaneChangeClearanceMm = G("laneChangeClearanceMm");
            p.BlockRangeMm = G("blockRangeMm");
            p.MinGapMm = G("minGapMm");
            p.SlipstreamRangeMm = G("slipstreamRangeMm");
            p.SlipstreamSavePermille = G("slipstreamSavePermille");
            p.BaseCruiseSpeedMmPerSec = G("baseCruiseSpeedMmPerSec");
            p.SpeedStatBonusMmPerSecPer1000 = G("speedStatBonusMmPerSecPer1000");
            p.CruiseSpeedPermille = G("cruiseSpeedPermille");
            p.AccelMmPerSec2 = G("accelMmPerSec2");
            p.DecelMmPerSec2 = G("decelMmPerSec2");
            p.ReinSpeedPermille = G("reinSpeedPermille");
            p.ReinDrainPermille = G("reinDrainPermille");
            p.SpurtDistanceM = G("spurtDistanceM");
            p.SpurtSpeedBonusMaxMmPerSec = G("spurtSpeedBonusMaxMmPerSec");
            p.StaminaBase = G("staminaBase");
            p.StaminaPerStatPoint = G("staminaPerStatPoint");
            p.DrainMicroPerSpeedSqPerTick = G("drainMicroPerSpeedSqPerTick");
            p.GutsFloorMinPermille = G("gutsFloorMinPermille");
            p.GutsFloorMaxPermille = G("gutsFloorMaxPermille");
            p.AptitudeOutPenaltyPermille = G("aptitudeOutPenaltyPermille");
            p.BadComposureThreshold = G("badComposureThreshold");
            p.BadComposureExtraDrainPermille = G("badComposureExtraDrainPermille");
            p.KakariChancePer100000PerTickAtTemper0 = G("kakariChancePer100000PerTickAtTemper0");
            p.KakariDurationTicks = G("kakariDurationTicks");
            p.KakariComposureLossPerTick = G("kakariComposureLossPerTick");
            p.ReinComposureRecoverPerTick = G("reinComposureRecoverPerTick");
            p.NaturalComposureRecoverPerTick = G("naturalComposureRecoverPerTick");
            p.BlockedComposureLossIntervalTicks = G("blockedComposureLossIntervalTicks");
            p.MaxWhips = G("maxWhips");
            p.WhipEffectTicks = G("whipEffectTicks");
            p.WhipAccelBonusMmPerSec2 = G("whipAccelBonusMmPerSec2");
            p.WhipSpeedBonusMmPerSec = G("whipSpeedBonusMmPerSec");
            p.WhipDiminishWindowTicks = G("whipDiminishWindowTicks");
            p.WhipDiminishPermille = G("whipDiminishPermille");
            p.EarlyWhipEffectPermille = G("earlyWhipEffectPermille");
            p.EarlyWhipComposurePenalty = G("earlyWhipComposurePenalty");
            p.WhipStaminaCost = G("whipStaminaCost");
            p.CpuDecisionIntervalTicks = G("cpuDecisionIntervalTicks");
            p.CpuWhipIntervalTicks = G("cpuWhipIntervalTicks");
            p.CpuWhipStartDistanceM = G("cpuWhipStartDistanceM");
            p.CpuTargetRankNigePermille = G("cpuTargetRankNigePermille");
            p.CpuTargetRankSenkoPermille = G("cpuTargetRankSenkoPermille");
            p.CpuTargetRankSashiPermille = G("cpuTargetRankSashiPermille");
            p.CpuTargetRankOikomiPermille = G("cpuTargetRankOikomiPermille");
            if (optionalPresent > 0)
            {
                p.HasGoingKeys = true;
                string[] g = { "Firm", "Good", "Yielding", "Soft" }, d = { "Fast", "Good", "Muddy", "Sloppy" };
                for (int i = 0; i < 4; i++)
                {
                    p.GoingTurfSpeedPermille[i] = G("goingTurf" + g[i] + "SpeedPermille");
                    p.GoingDirtSpeedPermille[i] = G("goingDirt" + d[i] + "SpeedPermille");
                    p.GoingTurfDrainPermille[i] = G("goingTurf" + g[i] + "DrainPermille");
                    p.GoingDirtDrainPermille[i] = G("goingDirt" + d[i] + "DrainPermille");
                }
                p.DirtSpeedPermille = G("dirtSpeedPermille");
                p.GoingSpecialistPermille = G("goingSpecialistPermille");
            }
            p.Validate();
            return p;
        }

        /// <summary>Key/value pairs in canonical order (for serialization).</summary>
        public List<KeyValuePair<string, long>> ToValues()
        {
            var v = new List<KeyValuePair<string, long>>();
            int[] vals =
            {
                MaxTicks, GateOpenTick, StartReactionWindowTicks, StartBoostPermille, StartBoostTicks,
                AutoStartDelayTicks, LaneCount, LaneWidthMm, LaneChangeTicks, LaneChangeClearanceMm,
                BlockRangeMm, MinGapMm, SlipstreamRangeMm, SlipstreamSavePermille, BaseCruiseSpeedMmPerSec,
                SpeedStatBonusMmPerSecPer1000, CruiseSpeedPermille, AccelMmPerSec2, DecelMmPerSec2,
                ReinSpeedPermille, ReinDrainPermille, SpurtDistanceM, SpurtSpeedBonusMaxMmPerSec,
                StaminaBase, StaminaPerStatPoint, DrainMicroPerSpeedSqPerTick, GutsFloorMinPermille,
                GutsFloorMaxPermille, AptitudeOutPenaltyPermille, BadComposureThreshold,
                BadComposureExtraDrainPermille, KakariChancePer100000PerTickAtTemper0, KakariDurationTicks,
                KakariComposureLossPerTick, ReinComposureRecoverPerTick, NaturalComposureRecoverPerTick,
                BlockedComposureLossIntervalTicks, MaxWhips, WhipEffectTicks, WhipAccelBonusMmPerSec2,
                WhipSpeedBonusMmPerSec, WhipDiminishWindowTicks, WhipDiminishPermille, EarlyWhipEffectPermille,
                EarlyWhipComposurePenalty, WhipStaminaCost, CpuDecisionIntervalTicks, CpuWhipIntervalTicks, CpuWhipStartDistanceM,
                CpuTargetRankNigePermille, CpuTargetRankSenkoPermille, CpuTargetRankSashiPermille,
                CpuTargetRankOikomiPermille,
            };
            for (int i = 0; i < IntKeys.Length; i++) v.Add(new KeyValuePair<string, long>(IntKeys[i], vals[i]));
            if (HasGoingKeys)
            {
                int[] opt =
                {
                    GoingTurfSpeedPermille[0], GoingTurfSpeedPermille[1], GoingTurfSpeedPermille[2], GoingTurfSpeedPermille[3],
                    GoingDirtSpeedPermille[0], GoingDirtSpeedPermille[1], GoingDirtSpeedPermille[2], GoingDirtSpeedPermille[3],
                    GoingTurfDrainPermille[0], GoingTurfDrainPermille[1], GoingTurfDrainPermille[2], GoingTurfDrainPermille[3],
                    GoingDirtDrainPermille[0], GoingDirtDrainPermille[1], GoingDirtDrainPermille[2], GoingDirtDrainPermille[3],
                    DirtSpeedPermille, GoingSpecialistPermille,
                };
                for (int i = 0; i < OptionalIntKeys.Length; i++) v.Add(new KeyValuePair<string, long>(OptionalIntKeys[i], opt[i]));
            }
            return v;
        }

        private void Validate()
        {
            if (MaxTicks <= GateOpenTick) throw new ArgumentException("maxTicks must exceed gateOpenTick");
            if (LaneCount < 1 || LaneCount > 24) throw new ArgumentException("laneCount out of range");
            if (LaneChangeTicks < 1) throw new ArgumentException("laneChangeTicks must be >= 1");
            if (LaneWidthMm < 1) throw new ArgumentException("laneWidthMm must be >= 1");
            if (AccelMmPerSec2 < 1 || DecelMmPerSec2 < 1) throw new ArgumentException("accel/decel must be >= 1");
            if (CpuDecisionIntervalTicks < 1) throw new ArgumentException("cpuDecisionIntervalTicks must be >= 1");
            if (MaxWhips < 0) throw new ArgumentException("maxWhips must be >= 0");
            if (MinGapMm < 0 || MinGapMm > BlockRangeMm) throw new ArgumentException("minGapMm must be 0..blockRangeMm");
            if (GutsFloorMaxPermille < GutsFloorMinPermille) throw new ArgumentException("guts floor range invalid");
            for (int i = 0; i < 4; i++)
            {
                if (!Permille(GoingTurfSpeedPermille[i]) || !Permille(GoingDirtSpeedPermille[i]) || !Permille(GoingTurfDrainPermille[i]) || !Permille(GoingDirtDrainPermille[i]))
                    throw new ArgumentException("going permille values must be 500..2000");
            }
            if (!Permille(DirtSpeedPermille)) throw new ArgumentException("dirtSpeedPermille must be 500..2000");
            if (GoingSpecialistPermille < 0 || GoingSpecialistPermille > 200) throw new ArgumentException("goingSpecialistPermille must be 0..200");
        }
        private static bool Permille(int v) => v >= 500 && v <= 2000;
    }
}
