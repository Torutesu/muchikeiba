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
        public int DrainMilliPerSpeedSqPerTick;
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
        public int CpuTargetRankNigePermille;
        public int CpuTargetRankSenkoPermille;
        public int CpuTargetRankSashiPermille;
        public int CpuTargetRankOikomiPermille;

        /// <summary>Every integer key, in canonical order (rulesetVersion is the extra string key).</summary>
        public static readonly string[] IntKeys =
        {
            "maxTicks", "gateOpenTick", "startReactionWindowTicks", "startBoostPermille", "startBoostTicks",
            "autoStartDelayTicks", "laneCount", "laneWidthMm", "laneChangeTicks", "laneChangeClearanceMm",
            "blockRangeMm", "slipstreamRangeMm", "slipstreamSavePermille", "baseCruiseSpeedMmPerSec",
            "speedStatBonusMmPerSecPer1000", "cruiseSpeedPermille", "accelMmPerSec2", "decelMmPerSec2",
            "reinSpeedPermille", "reinDrainPermille", "spurtDistanceM", "spurtSpeedBonusMaxMmPerSec",
            "staminaBase", "staminaPerStatPoint", "drainMilliPerSpeedSqPerTick", "gutsFloorMinPermille",
            "gutsFloorMaxPermille", "aptitudeOutPenaltyPermille", "badComposureThreshold",
            "badComposureExtraDrainPermille", "kakariChancePer100000PerTickAtTemper0", "kakariDurationTicks",
            "kakariComposureLossPerTick", "reinComposureRecoverPerTick", "naturalComposureRecoverPerTick",
            "blockedComposureLossIntervalTicks", "maxWhips", "whipEffectTicks", "whipAccelBonusMmPerSec2",
            "whipSpeedBonusMmPerSec", "whipDiminishWindowTicks", "whipDiminishPermille", "earlyWhipEffectPermille",
            "earlyWhipComposurePenalty", "whipStaminaCost", "cpuDecisionIntervalTicks", "cpuWhipIntervalTicks",
            "cpuTargetRankNigePermille", "cpuTargetRankSenkoPermille", "cpuTargetRankSashiPermille",
            "cpuTargetRankOikomiPermille",
        };

        public const string VersionKey = "rulesetVersion";

        /// <summary>Builds params from a key/value map. Missing or unknown keys throw ArgumentException.</summary>
        public static RulesetParams FromValues(string rulesetVersion, IDictionary<string, long> values)
        {
            if (string.IsNullOrEmpty(rulesetVersion)) throw new ArgumentException("rulesetVersion required");
            var known = new HashSet<string>(IntKeys);
            foreach (var k in values.Keys)
                if (!known.Contains(k)) throw new ArgumentException("unknown ruleset key: " + k);
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
            p.DrainMilliPerSpeedSqPerTick = G("drainMilliPerSpeedSqPerTick");
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
            p.CpuTargetRankNigePermille = G("cpuTargetRankNigePermille");
            p.CpuTargetRankSenkoPermille = G("cpuTargetRankSenkoPermille");
            p.CpuTargetRankSashiPermille = G("cpuTargetRankSashiPermille");
            p.CpuTargetRankOikomiPermille = G("cpuTargetRankOikomiPermille");
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
                BlockRangeMm, SlipstreamRangeMm, SlipstreamSavePermille, BaseCruiseSpeedMmPerSec,
                SpeedStatBonusMmPerSecPer1000, CruiseSpeedPermille, AccelMmPerSec2, DecelMmPerSec2,
                ReinSpeedPermille, ReinDrainPermille, SpurtDistanceM, SpurtSpeedBonusMaxMmPerSec,
                StaminaBase, StaminaPerStatPoint, DrainMilliPerSpeedSqPerTick, GutsFloorMinPermille,
                GutsFloorMaxPermille, AptitudeOutPenaltyPermille, BadComposureThreshold,
                BadComposureExtraDrainPermille, KakariChancePer100000PerTickAtTemper0, KakariDurationTicks,
                KakariComposureLossPerTick, ReinComposureRecoverPerTick, NaturalComposureRecoverPerTick,
                BlockedComposureLossIntervalTicks, MaxWhips, WhipEffectTicks, WhipAccelBonusMmPerSec2,
                WhipSpeedBonusMmPerSec, WhipDiminishWindowTicks, WhipDiminishPermille, EarlyWhipEffectPermille,
                EarlyWhipComposurePenalty, WhipStaminaCost, CpuDecisionIntervalTicks, CpuWhipIntervalTicks,
                CpuTargetRankNigePermille, CpuTargetRankSenkoPermille, CpuTargetRankSashiPermille,
                CpuTargetRankOikomiPermille,
            };
            for (int i = 0; i < IntKeys.Length; i++) v.Add(new KeyValuePair<string, long>(IntKeys[i], vals[i]));
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
            if (GutsFloorMaxPermille < GutsFloorMinPermille) throw new ArgumentException("guts floor range invalid");
        }
    }
}
