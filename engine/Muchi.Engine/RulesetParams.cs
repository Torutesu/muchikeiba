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

        // ---- balance additions (ruleset 1.1, docs/spec/balance-targets.md) ----
        /// <summary>Per-race form: each horse's top speed is scaled by a seeded random ±this‰ (0 = none).</summary>
        public int ConditionVariancePermille;
        /// <summary>CPUs below this level never use the rein to save stamina (only to settle a pulling horse).</summary>
        public int CpuStaminaReinMinLevel = 1;
        /// <summary>CPUs at or above this level always tuck in toward the rail when there is room; lower levels half the time.</summary>
        public int CpuRailMinLevel = 3;
        /// <summary>Auto-steer: every N ticks a horse tucks one lane toward the rail when it is safe (0 = off).</summary>
        public int AutoRailIntervalTicks;
        /// <summary>Auto-steer stays off for this many ticks after the rider steered (so a chosen line is kept).</summary>
        public int AutoRailHoldTicks;
        /// <summary>CPUs at or below this level ride like a casual player (late starts, scattered whips, no stamina rein). 0 = none.</summary>
        public int CpuSloppyMaxLevel;
        /// <summary>True when the balance keys were present (absent in rulesets before 1.1; then the values above apply).</summary>
        public bool HasBalanceKeys;

        // ---- distance scaling (ruleset 1.2, docs/spec/balance-targets.md §2 "1.2.0 で変えたもの") ----
        /// <summary>Turf reference distance for the scaling below (0 = off: stamina and spurt zone ignore the race distance).</summary>
        public int DistanceRefM;
        /// <summary>Dirt reference distance (dirt drains more, so the same balance sits at a shorter distance).</summary>
        public int DistanceRefDirtM;
        /// <summary>How much of the distance ratio the stamina pool follows (‰; 1000 = proportional to distance / ref).</summary>
        public int StaminaDistanceScalePermille;
        /// <summary>How much of the distance ratio the spurt zone length follows (‰; 1000 = proportional).</summary>
        public int SpurtDistanceScalePermille;
        /// <summary>True when the distance keys were present (absent before 1.2; then nothing scales with distance).</summary>
        public bool HasDistanceKeys;

        // ---- unique skills (ruleset 1.3, docs/planning/06-ux-experience-spec.md §7.1, REQ-UXS-051) ----
        /// <summary>Ceiling for a skill's target-speed bonus (‰). Every skill effect is clamped to these caps.</summary>
        public int SkillMaxSpeedPermille;
        /// <summary>Ceiling for a skill's acceleration bonus (‰).</summary>
        public int SkillMaxAccelPermille;
        /// <summary>Ceiling for a skill's stamina-drain saving (‰).</summary>
        public int SkillMaxDrainSavePermille;
        /// <summary>Ceiling for a skill's one-time stamina recovery (‰ of the maximum).</summary>
        public int SkillMaxRecoverPermille;
        /// <summary>Ceiling for how long a skill's effect lasts (ticks).</summary>
        public int SkillMaxDurationTicks;
        /// <summary>True when the skill keys were present (absent before 1.3; then horse skills are ignored entirely).</summary>
        public bool HasSkillKeys;

        // ---- tactics (ruleset 1.4, docs/quality/race-play.md): 仕掛け with the whip hold (溜め → 一閃), rhythm whips, slingshot ----
        /// <summary>The 仕掛け window opens at (spurt zone × this‰) metres to go: a press of the whip there starts the 溜め (gather).</summary>
        public int GoWindowPermille;
        /// <summary>A horse that has not gone by itself goes at (spurt zone × this‰) to go (1000 = where every spurt began before 1.4).</summary>
        public int AutoGoPermille;
        /// <summary>Target speed while gathering (‰ of cruise) and stamina drain while gathering (‰).</summary>
        public int GatherSpeedPermille, GatherDrainPermille;
        /// <summary>Ticks of gathering for a full charge; a full charge goes by itself (溜めきり).</summary>
        public int GatherMaxTicks;
        /// <summary>The 一閃 kick on release at full charge (scaled by charge / max): speed and acceleration bonus for kickTicks.</summary>
        public int KickSpeedBonusMmPerSec, KickAccelBonusMmPerSec2, KickTicks;
        /// <summary>A whip landing this many ticks (inclusive range) after the go or the previous whip is a 会心 (perfect rhythm) whip.</summary>
        public int RhythmFromTicks, RhythmToTicks;
        /// <summary>Extra whip effect (‰) of a 会心 whip (the effect is 1000 + this).</summary>
        public int RhythmBonusPermille;
        /// <summary>Slingshot: changing lane after this many ticks in a slipstream inside the 仕掛け window gives a burst.</summary>
        public int SlingshotMinSlipTicks, SlingshotSpeedBonusMmPerSec, SlingshotAccelBonusMmPerSec2, SlingshotTicks;
        /// <summary>The go line (HUD and CPU): the distance the horse's stamina sustains a spurt × this‰ (calibrated by the harness).</summary>
        public int GoLinePermille;
        /// <summary>CPUs at or above this level gather and time their go from the go line; lower levels leave it to the auto go.</summary>
        public int CpuTacticsMinLevel;
        /// <summary>Share (‰) of the spurt speed bonus a horse that went early gets until it reaches the spurt mark (a long spurt runs at top speed plus this).</summary>
        public int LongSpurtBonusPermille;
        /// <summary>True when the tactics keys were present (absent before 1.4; then nothing of the above exists).</summary>
        public bool HasTacticsKeys;

        /// <summary>
        /// Permille factor for a race of <paramref name="distanceM"/>: 1000 + scale × (distance − ref) / ref, clamped to 200..5000,
        /// with the surface's reference distance. Exactly 1000 when the distance keys are absent or off.
        /// </summary>
        public int DistanceFactorPermille(int distanceM, bool dirt, int scalePermille)
        {
            int refM = dirt ? DistanceRefDirtM : DistanceRefM;
            if (refM <= 0 || scalePermille == 0) return 1000;
            long f = 1000 + (long)scalePermille * (distanceM - refM) / refM;
            return (int)Math.Max(200, Math.Min(5000, f));
        }

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

        /// <summary>
        /// Second group of optional keys (ruleset 1.1 balance). Independent of the ground group; all or none.
        /// Absent = the neutral values below, which reproduce 1.0 behaviour exactly.
        /// </summary>
        public static readonly string[] BalanceIntKeys =
        {
            "conditionVariancePermille", "cpuStaminaReinMinLevel", "cpuRailMinLevel", "autoRailIntervalTicks", "autoRailHoldTicks", "cpuSloppyMaxLevel",
        };

        /// <summary>Neutral values for <see cref="BalanceIntKeys"/> (same order).</summary>
        public static readonly int[] BalanceNeutralValues = { 0, 1, 3, 0, 0, 0 };

        /// <summary>
        /// Third optional group (ruleset 1.2): stamina pool and spurt zone scale with the race distance, so a course's
        /// running-style balance no longer depends on its length. All or none; absent = nothing scales (1.1 and older).
        /// </summary>
        public static readonly string[] DistanceIntKeys = { "distanceRefM", "distanceRefDirtM", "staminaDistanceScalePermille", "spurtDistanceScalePermille" };

        /// <summary>Neutral values for <see cref="DistanceIntKeys"/> (same order).</summary>
        public static readonly int[] DistanceNeutralValues = { 0, 0, 0, 0 };

        /// <summary>
        /// Fourth optional group (ruleset 1.3): caps for unique skills (固有スキル). All or none; absent = skills sent with a
        /// horse are ignored, so 1.2 and older replays reproduce exactly.
        /// </summary>
        public static readonly string[] SkillIntKeys = { "skillMaxSpeedPermille", "skillMaxAccelPermille", "skillMaxDrainSavePermille", "skillMaxRecoverPermille", "skillMaxDurationTicks" };

        /// <summary>Neutral values for <see cref="SkillIntKeys"/> (same order).</summary>
        public static readonly int[] SkillNeutralValues = { 0, 0, 0, 0, 0 };

        /// <summary>
        /// Fifth optional group (ruleset 1.4): tactics — the spurt is the rider's decision (hold the whip to gather, release to
        /// go: 一閃), whips on the rhythm are 会心, pulling out of a slipstream late gives a slingshot. All or none; absent = the
        /// spurt starts at the spurt mark by itself and none of this exists, so 1.3 and older replays reproduce exactly.
        /// After departure, START (bit 0) means WHIP_RELEASE in 1.4 (it was ignored before).
        /// </summary>
        public static readonly string[] TacticsIntKeys =
        {
            "goWindowPermille", "autoGoPermille", "gatherSpeedPermille", "gatherDrainPermille", "gatherMaxTicks",
            "kickSpeedBonusMmPerSec", "kickAccelBonusMmPerSec2", "kickTicks", "rhythmFromTicks", "rhythmToTicks", "rhythmBonusPermille",
            "slingshotMinSlipTicks", "slingshotSpeedBonusMmPerSec", "slingshotAccelBonusMmPerSec2", "slingshotTicks", "goLinePermille", "cpuTacticsMinLevel",
            "longSpurtBonusPermille",
        };

        /// <summary>Builds params from a key/value map. Missing or unknown keys throw ArgumentException.</summary>
        public static RulesetParams FromValues(string rulesetVersion, IDictionary<string, long> values)
        {
            if (string.IsNullOrEmpty(rulesetVersion)) throw new ArgumentException("rulesetVersion required");
            var known = new HashSet<string>(IntKeys);
            foreach (var k in OptionalIntKeys) known.Add(k);
            foreach (var k in BalanceIntKeys) known.Add(k);
            foreach (var k in DistanceIntKeys) known.Add(k);
            foreach (var k in SkillIntKeys) known.Add(k);
            foreach (var k in TacticsIntKeys) known.Add(k);
            foreach (var k in values.Keys)
                if (!known.Contains(k)) throw new ArgumentException("unknown ruleset key: " + k);
            int optionalPresent = 0;
            foreach (var k in OptionalIntKeys) if (values.ContainsKey(k)) optionalPresent++;
            if (optionalPresent != 0 && optionalPresent != OptionalIntKeys.Length)
                throw new ArgumentException("ground-condition ruleset keys must be all present or all absent");
            int balancePresent = 0;
            foreach (var k in BalanceIntKeys) if (values.ContainsKey(k)) balancePresent++;
            if (balancePresent != 0 && balancePresent != BalanceIntKeys.Length)
                throw new ArgumentException("balance ruleset keys must be all present or all absent");
            int distancePresent = 0;
            foreach (var k in DistanceIntKeys) if (values.ContainsKey(k)) distancePresent++;
            if (distancePresent != 0 && distancePresent != DistanceIntKeys.Length)
                throw new ArgumentException("distance ruleset keys must be all present or all absent");
            int skillPresent = 0;
            foreach (var k in SkillIntKeys) if (values.ContainsKey(k)) skillPresent++;
            if (skillPresent != 0 && skillPresent != SkillIntKeys.Length)
                throw new ArgumentException("skill ruleset keys must be all present or all absent");
            int tacticsPresent = 0;
            foreach (var k in TacticsIntKeys) if (values.ContainsKey(k)) tacticsPresent++;
            if (tacticsPresent != 0 && tacticsPresent != TacticsIntKeys.Length)
                throw new ArgumentException("tactics ruleset keys must be all present or all absent");
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
            if (balancePresent > 0)
            {
                p.HasBalanceKeys = true;
                p.ConditionVariancePermille = G("conditionVariancePermille");
                p.CpuStaminaReinMinLevel = G("cpuStaminaReinMinLevel");
                p.CpuRailMinLevel = G("cpuRailMinLevel");
                p.AutoRailIntervalTicks = G("autoRailIntervalTicks");
                p.AutoRailHoldTicks = G("autoRailHoldTicks");
                p.CpuSloppyMaxLevel = G("cpuSloppyMaxLevel");
            }
            if (distancePresent > 0)
            {
                p.HasDistanceKeys = true;
                p.DistanceRefM = G("distanceRefM");
                p.DistanceRefDirtM = G("distanceRefDirtM");
                p.StaminaDistanceScalePermille = G("staminaDistanceScalePermille");
                p.SpurtDistanceScalePermille = G("spurtDistanceScalePermille");
            }
            if (skillPresent > 0)
            {
                p.HasSkillKeys = true;
                p.SkillMaxSpeedPermille = G("skillMaxSpeedPermille");
                p.SkillMaxAccelPermille = G("skillMaxAccelPermille");
                p.SkillMaxDrainSavePermille = G("skillMaxDrainSavePermille");
                p.SkillMaxRecoverPermille = G("skillMaxRecoverPermille");
                p.SkillMaxDurationTicks = G("skillMaxDurationTicks");
            }
            if (tacticsPresent > 0)
            {
                p.HasTacticsKeys = true;
                p.GoWindowPermille = G("goWindowPermille");
                p.AutoGoPermille = G("autoGoPermille");
                p.GatherSpeedPermille = G("gatherSpeedPermille");
                p.GatherDrainPermille = G("gatherDrainPermille");
                p.GatherMaxTicks = G("gatherMaxTicks");
                p.KickSpeedBonusMmPerSec = G("kickSpeedBonusMmPerSec");
                p.KickAccelBonusMmPerSec2 = G("kickAccelBonusMmPerSec2");
                p.KickTicks = G("kickTicks");
                p.RhythmFromTicks = G("rhythmFromTicks");
                p.RhythmToTicks = G("rhythmToTicks");
                p.RhythmBonusPermille = G("rhythmBonusPermille");
                p.SlingshotMinSlipTicks = G("slingshotMinSlipTicks");
                p.SlingshotSpeedBonusMmPerSec = G("slingshotSpeedBonusMmPerSec");
                p.SlingshotAccelBonusMmPerSec2 = G("slingshotAccelBonusMmPerSec2");
                p.SlingshotTicks = G("slingshotTicks");
                p.GoLinePermille = G("goLinePermille");
                p.CpuTacticsMinLevel = G("cpuTacticsMinLevel");
                p.LongSpurtBonusPermille = G("longSpurtBonusPermille");
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
            if (HasBalanceKeys)
            {
                int[] bal = { ConditionVariancePermille, CpuStaminaReinMinLevel, CpuRailMinLevel, AutoRailIntervalTicks, AutoRailHoldTicks, CpuSloppyMaxLevel };
                for (int i = 0; i < BalanceIntKeys.Length; i++) v.Add(new KeyValuePair<string, long>(BalanceIntKeys[i], bal[i]));
            }
            if (HasDistanceKeys)
            {
                int[] dist = { DistanceRefM, DistanceRefDirtM, StaminaDistanceScalePermille, SpurtDistanceScalePermille };
                for (int i = 0; i < DistanceIntKeys.Length; i++) v.Add(new KeyValuePair<string, long>(DistanceIntKeys[i], dist[i]));
            }
            if (HasSkillKeys)
            {
                int[] sk = { SkillMaxSpeedPermille, SkillMaxAccelPermille, SkillMaxDrainSavePermille, SkillMaxRecoverPermille, SkillMaxDurationTicks };
                for (int i = 0; i < SkillIntKeys.Length; i++) v.Add(new KeyValuePair<string, long>(SkillIntKeys[i], sk[i]));
            }
            if (HasTacticsKeys)
            {
                int[] tk =
                {
                    GoWindowPermille, AutoGoPermille, GatherSpeedPermille, GatherDrainPermille, GatherMaxTicks,
                    KickSpeedBonusMmPerSec, KickAccelBonusMmPerSec2, KickTicks, RhythmFromTicks, RhythmToTicks, RhythmBonusPermille,
                    SlingshotMinSlipTicks, SlingshotSpeedBonusMmPerSec, SlingshotAccelBonusMmPerSec2, SlingshotTicks, GoLinePermille, CpuTacticsMinLevel,
                    LongSpurtBonusPermille,
                };
                for (int i = 0; i < TacticsIntKeys.Length; i++) v.Add(new KeyValuePair<string, long>(TacticsIntKeys[i], tk[i]));
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
            if (ConditionVariancePermille < 0 || ConditionVariancePermille > 100) throw new ArgumentException("conditionVariancePermille must be 0..100");
            if (CpuStaminaReinMinLevel < 1 || CpuStaminaReinMinLevel > 6) throw new ArgumentException("cpuStaminaReinMinLevel must be 1..6");
            if (CpuRailMinLevel < 1 || CpuRailMinLevel > 6) throw new ArgumentException("cpuRailMinLevel must be 1..6");
            if (AutoRailIntervalTicks < 0 || AutoRailHoldTicks < 0) throw new ArgumentException("autoRail values must be >= 0");
            if (CpuSloppyMaxLevel < 0 || CpuSloppyMaxLevel > 5) throw new ArgumentException("cpuSloppyMaxLevel must be 0..5");
            if (DistanceRefM < 0 || DistanceRefM > 10000 || DistanceRefDirtM < 0 || DistanceRefDirtM > 10000) throw new ArgumentException("distanceRefM/distanceRefDirtM must be 0..10000");
            if (StaminaDistanceScalePermille < 0 || StaminaDistanceScalePermille > 2000 || SpurtDistanceScalePermille < 0 || SpurtDistanceScalePermille > 2000)
                throw new ArgumentException("distance scale values must be 0..2000");
            if (SkillMaxSpeedPermille < 0 || SkillMaxSpeedPermille > 200 || SkillMaxAccelPermille < 0 || SkillMaxAccelPermille > 1000
                || SkillMaxDrainSavePermille < 0 || SkillMaxDrainSavePermille > 1000 || SkillMaxRecoverPermille < 0 || SkillMaxRecoverPermille > 500)
                throw new ArgumentException("skill caps out of range (speed 0..200, accel 0..1000, drain 0..1000, recover 0..500)");
            if (SkillMaxDurationTicks < 0 || SkillMaxDurationTicks > 1200) throw new ArgumentException("skillMaxDurationTicks must be 0..1200");
            if (HasTacticsKeys)
            {
                if (AutoGoPermille < 100 || AutoGoPermille > 3000 || GoWindowPermille < AutoGoPermille || GoWindowPermille > 3000)
                    throw new ArgumentException("autoGoPermille must be 100..3000 and goWindowPermille autoGoPermille..3000");
                if (!Permille(GatherSpeedPermille + 500) || GatherDrainPermille < 0 || GatherDrainPermille > 1000)
                    throw new ArgumentException("gatherSpeedPermille must be 0..1500 and gatherDrainPermille 0..1000");
                if (GatherMaxTicks < 1 || GatherMaxTicks > 200) throw new ArgumentException("gatherMaxTicks must be 1..200");
                if (KickSpeedBonusMmPerSec < 0 || KickSpeedBonusMmPerSec > 10000 || KickAccelBonusMmPerSec2 < 0 || KickAccelBonusMmPerSec2 > 20000 || KickTicks < 0 || KickTicks > 200)
                    throw new ArgumentException("kick values out of range (speed 0..10000, accel 0..20000, ticks 0..200)");
                if (RhythmFromTicks < 1 || RhythmToTicks < RhythmFromTicks || RhythmToTicks > 200 || RhythmBonusPermille < 0 || RhythmBonusPermille > 2000)
                    throw new ArgumentException("rhythm values out of range (1 <= from <= to <= 200, bonus 0..2000)");
                if (SlingshotMinSlipTicks < 1 || SlingshotSpeedBonusMmPerSec < 0 || SlingshotSpeedBonusMmPerSec > 10000 || SlingshotAccelBonusMmPerSec2 < 0 || SlingshotAccelBonusMmPerSec2 > 20000 || SlingshotTicks < 0 || SlingshotTicks > 200)
                    throw new ArgumentException("slingshot values out of range");
                if (GoLinePermille < 100 || GoLinePermille > 5000) throw new ArgumentException("goLinePermille must be 100..5000");
                if (CpuTacticsMinLevel < 1 || CpuTacticsMinLevel > 6) throw new ArgumentException("cpuTacticsMinLevel must be 1..6");
                if (LongSpurtBonusPermille < 0 || LongSpurtBonusPermille > 1000) throw new ArgumentException("longSpurtBonusPermille must be 0..1000");
            }
        }
        private static bool Permille(int v) => v >= 500 && v <= 2000;
    }
}
