using System;
using System.Collections.Generic;
using System.Globalization;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Engine;
using Muchi.Net;

namespace Muchi.Client
{
    // アクセシビリティ設定 (REQ-A11Y-001..016, contracts/protocol.md §41, server/src/domain/accessibility.ts).
    // Presentation settings and one input aid (WhipHold). Nothing here changes the engine, a ruleset, the verifier or a
    // replay: WhipHold only produces the bytes a tapping finger could produce (§41.7, the §27.2 fairness rule).

    public enum TextSize { Standard = 0, Large = 1, Largest = 2 }
    public enum ColorMode { Standard = 0, Cvd = 1 }
    public enum OneHandedLayout { Off = 0, Left = 1, Right = 2 }
    public enum WhipInput { Tap = 0, Hold = 1 }

    /// <summary>The account's accessibility settings (GET/PUT /v1/settings/accessibility, `accessibility` in GET /v1/player).</summary>
    public sealed class AccessibilitySettings
    {
        public TextSize TextSize = TextSize.Standard;
        public ColorMode ColorMode = ColorMode.Standard;
        public bool ReduceMotion;
        public bool Haptics = true;
        public bool Subtitles = true;
        public OneHandedLayout OneHanded = OneHandedLayout.Off;
        public WhipInput WhipInput = WhipInput.Tap;
        /// <summary>Server revision (+1 on every PUT that changed a value); 0 = never set.</summary>
        public int Rev;
        public long? UpdatedAt;

        /// <summary>REQ-A11Y-001: standard text and colours, motion on, haptics on, subtitles on, two-handed, tap.</summary>
        public static AccessibilitySettings Defaults => new AccessibilitySettings();

        public AccessibilitySettings Clone() => (AccessibilitySettings)MemberwiseClone();

        /// <summary>The seven values are equal (Rev / UpdatedAt ignored).</summary>
        public bool SameValues(AccessibilitySettings o) => o != null && TextSize == o.TextSize && ColorMode == o.ColorMode && ReduceMotion == o.ReduceMotion
            && Haptics == o.Haptics && Subtitles == o.Subtitles && OneHanded == o.OneHanded && WhipInput == o.WhipInput;

        /// <summary>Unknown or missing values fall back to the defaults (a newer server never breaks an older app).</summary>
        public static AccessibilitySettings Parse(JsonNode o)
        {
            var s = new AccessibilitySettings();
            if (o == null || o.Kind != JsonKind.Object) return s;
            s.TextSize = ParseTextSize(J.Str(o, "textSize"));
            s.ColorMode = J.Str(o, "colorMode") == "cvd" ? ColorMode.Cvd : ColorMode.Standard;
            s.ReduceMotion = BoolOr(o, "reduceMotion", false);
            s.Haptics = BoolOr(o, "haptics", true);
            s.Subtitles = BoolOr(o, "subtitles", true);
            var h = J.Str(o, "oneHanded");
            s.OneHanded = h == "left" ? OneHandedLayout.Left : h == "right" ? OneHandedLayout.Right : OneHandedLayout.Off;
            s.WhipInput = J.Str(o, "whipInput") == "hold" ? WhipInput.Hold : WhipInput.Tap;
            s.Rev = J.Int(o, "rev");
            s.UpdatedAt = J.LongN(o, "updatedAt");
            return s;
        }

        public static AccessibilitySettings Parse(string json)
        {
            if (string.IsNullOrWhiteSpace(json)) return new AccessibilitySettings();
            try { return Parse(JsonNode.Parse(json)); } catch (FormatException) { return new AccessibilitySettings(); }
        }

        private static bool BoolOr(JsonNode o, string k, bool def)
        {
            var v = J.Opt(o, k);
            return v != null && v.Kind == JsonKind.Bool ? v.AsBool() : def;
        }

        public static TextSize ParseTextSize(string s) => s == "large" ? TextSize.Large : s == "largest" ? TextSize.Largest : TextSize.Standard;
        public static string Wire(TextSize t) => t == TextSize.Large ? "large" : t == TextSize.Largest ? "largest" : "standard";
        public static string Wire(ColorMode m) => m == ColorMode.Cvd ? "cvd" : "standard";
        public static string Wire(OneHandedLayout h) => h == OneHandedLayout.Left ? "left" : h == OneHandedLayout.Right ? "right" : "off";
        public static string Wire(WhipInput w) => w == WhipInput.Hold ? "hold" : "tap";

        /// <summary>The PUT body: always all seven keys (the server replaces the whole blob, keys left out = defaults).</summary>
        public JsonNode ToBody()
        {
            var b = JsonNode.Obj();
            b.Set("textSize", Wire(TextSize));
            b.Set("colorMode", Wire(ColorMode));
            b.Set("reduceMotion", ReduceMotion);
            b.Set("haptics", Haptics);
            b.Set("subtitles", Subtitles);
            b.Set("oneHanded", Wire(OneHanded));
            b.Set("whipInput", Wire(WhipInput));
            return b;
        }

        /// <summary>The device copy (the body + rev / updatedAt), read back with <see cref="Parse(string)"/>.</summary>
        public string ToLocalJson()
        {
            var b = ToBody();
            b.Set("rev", Rev);
            if (UpdatedAt.HasValue) b.Set("updatedAt", UpdatedAt.Value);
            return b.ToString();
        }
    }

    /// <summary>REQ-A11Y-005: body text multipliers. Headings and big numbers (≥ <see cref="HeadingPx"/>) keep their size.</summary>
    public static class TextScale
    {
        public const float HeadingPx = 28f;
        public static float Factor(TextSize s) => s == TextSize.Largest ? 1.30f : s == TextSize.Large ? 1.15f : 1.00f;
        /// <summary>The size to draw a text designed at <paramref name="basePx"/> (the standard layout).</summary>
        public static float Px(float basePx, TextSize s) => basePx >= HeadingPx ? basePx : basePx * Factor(s);
        /// <summary>
        /// The smallest size a box may shrink a text to when it does not fit: never below the standard size in
        /// Japanese; English keeps its 66 % floor (REQ-L10N-013).
        /// </summary>
        public static float MinPx(float basePx, bool english) => english ? basePx * 0.66f : basePx;
    }

    /// <summary>
    /// REQ-A11Y-006: colour tokens for gauge / position / status cues (contracts/a11y-tokens.json — AccessibilityTests
    /// keeps this table equal to it). Screens take these colours from here, never hard-coded.
    /// </summary>
    public static class AccessibilityTokens
    {
        public const string Background = "#08182a";
        public const string GaugeOk = "gauge.ok", GaugeLow = "gauge.low", GaugeCritical = "gauge.critical";
        public const string PositionSelf = "position.self", PositionOther = "position.other";
        public const string StatusOk = "status.ok", StatusDanger = "status.danger", WhipChance = "cue.whipChance";
        public static readonly string[] Names = { GaugeOk, GaugeLow, GaugeCritical, PositionSelf, PositionOther, StatusOk, StatusDanger, WhipChance };

        public static readonly IReadOnlyDictionary<string, string> Standard = new Dictionary<string, string>
        {
            [GaugeOk] = "#00d2ed", [GaugeLow] = "#ffd34f", [GaugeCritical] = "#ff5a4a",
            [PositionSelf] = "#ffd34f", [PositionOther] = "#00d2ed",
            [StatusOk] = "#8fe3a8", [StatusDanger] = "#ff7a6b", [WhipChance] = "#ffe661",
        };
        public static readonly IReadOnlyDictionary<string, string> Cvd = new Dictionary<string, string>
        {
            [GaugeOk] = "#00d2ed", [GaugeLow] = "#ffff33", [GaugeCritical] = "#cc6633",
            [PositionSelf] = "#ffff33", [PositionOther] = "#5f8fb3",
            [StatusOk] = "#00d2ed", [StatusDanger] = "#ff9a3d", [WhipChance] = "#ffff33",
        };

        public static IReadOnlyDictionary<string, string> Palette(ColorMode m) => m == ColorMode.Cvd ? Cvd : Standard;
        /// <summary>sRGB hex of a token in a mode (unknown tokens throw: a typo must not silently draw the wrong colour).</summary>
        public static string Color(ColorMode m, string token) => Palette(m)[token];
        /// <summary>The cvd mode also adds a hatch to the critical gauge (colour is never the only cue).</summary>
        public static bool CriticalHatch(ColorMode m) => m == ColorMode.Cvd;

        /// <summary>WCAG 2.x contrast ratio of two sRGB hex colours (1 … 21).</summary>
        public static double Contrast(string a, string b)
        {
            double x = Luminance(a), y = Luminance(b);
            return (Math.Max(x, y) + 0.05) / (Math.Min(x, y) + 0.05);
        }

        public static double Luminance(string hex)
        {
            double Lin(int i)
            {
                double c = int.Parse(hex.Substring(i, 2), NumberStyles.HexNumber, CultureInfo.InvariantCulture) / 255.0;
                return c <= 0.04045 ? c / 12.92 : Math.Pow((c + 0.055) / 1.055, 2.4);
            }
            return 0.2126 * Lin(1) + 0.7152 * Lin(3) + 0.0722 * Lin(5);
        }
    }

    /// <summary>REQ-A11Y-007: what moves on screen. Results, odds and the reveal order never depend on it.</summary>
    public sealed class MotionPolicy
    {
        public bool Reduced { get; private set; }
        /// <summary>Camera shake multiplier (0 = none).</summary>
        public float CameraShakeScale { get; private set; } = 1f;
        /// <summary>The whip's field-of-view kick multiplier (0 = none).</summary>
        public float FovKickScale { get; private set; } = 1f;
        public bool SpeedLines { get; private set; } = true;
        /// <summary>The slow zoom of full-screen key art.</summary>
        public bool BackgroundDrift { get; private set; } = true;
        /// <summary>Blink the critical stamina gauge (off: steady colour + the text line).</summary>
        public bool GaugeBlink { get; private set; } = true;
        /// <summary>Reduced transitions and reveal steps are at most this long.</summary>
        public const int ReducedMaxMs = 150;

        public static MotionPolicy For(bool reduceMotion) => !reduceMotion ? new MotionPolicy() : new MotionPolicy
        {
            Reduced = true, CameraShakeScale = 0f, FovKickScale = 0f, SpeedLines = false, BackgroundDrift = false, GaugeBlink = false,
        };
        public static MotionPolicy For(AccessibilitySettings s) => For(s != null && s.ReduceMotion);

        /// <summary>A screen transition / sheet slide designed at <paramref name="normalMs"/>.</summary>
        public int TransitionMs(int normalMs) => Reduced ? Math.Min(normalMs, ReducedMaxMs) : normalMs;
        /// <summary>The gacha card back's rarity glow before the face shows (0 = the face at once).</summary>
        public int RevealGlowMs(int normalMs) => Reduced ? 0 : normalMs;
        /// <summary>The card flip.</summary>
        public int RevealFlipMs(int normalMs) => Reduced ? Math.Min(normalMs, ReducedMaxMs) : normalMs;
    }

    /// <summary>
    /// REQ-A11Y-008: one-shot flashes (「伸びる！」, an overtake, the whip hit) pass through this, so no effect flashes more
    /// than <see cref="MaxPerSecond"/> times in any one-second window (WCAG 2.3.1). A refused flash shows its text without
    /// the light. Repeating blinks are limited by their period instead (≥ 1/3 s per light-dark pair).
    /// </summary>
    public sealed class FlashLimiter
    {
        public const int MaxPerSecond = 3;
        public const int WindowMs = 1000;
        private readonly Queue<long> _recent = new Queue<long>();

        /// <summary>True (and counted) when a flash may start at <paramref name="nowMs"/>.</summary>
        public bool TryFlash(long nowMs)
        {
            while (_recent.Count > 0 && nowMs - _recent.Peek() >= WindowMs) _recent.Dequeue();
            if (_recent.Count >= MaxPerSecond) return false;
            _recent.Enqueue(nowMs);
            return true;
        }

        public void Reset() => _recent.Clear();

        /// <summary>Light-dark pairs per second of a repeating blink (alternate = one direction per period).</summary>
        public static double BlinkRate(double periodSeconds, bool alternate) => 1.0 / (periodSeconds * (alternate ? 2 : 1));
    }

    /// <summary>
    /// REQ-A11Y-012 ムチの長押し: the press is a tap (START before departure, WHIP after); while held after a press made
    /// in the race, one WHIP every <see cref="Spacing"/> ticks — the rhythm of the §27 whip assist — up to
    /// <see cref="MaxRepeats"/> automatic whips per race (the rest are taps). At most one command per simulation tick; in
    /// the tutorial only the press (REQ-UXS-004 is defined for taps). Every sequence it makes is one a tapping finger can
    /// make, and a player who only holds stays below the best tapping (AccessibilityTests.HoldIsCappedBelowSkilledPlay):
    /// the whip window is forgiving, so an unlimited rhythm alone would ride level with skilled tapping — the repeat
    /// budget is what keeps the aid under it (§27.2). For no tapping at all there is the §27 whip assist.
    /// </summary>
    public sealed class WhipHold
    {
        private bool _wasHeld;
        private bool _repeat;
        private int _lastWhipTick = -100000;
        private int _decidedTick = -1;

        /// <summary>max(whipEffectTicks, whipDiminishWindowTicks) + InputAssistant.WhipSpacingExtraTicks.</summary>
        public static int Spacing(RulesetParams p) => Math.Max(p.WhipEffectTicks, p.WhipDiminishWindowTicks) + InputAssistant.WhipSpacingExtraTicks;

        /// <summary>
        /// Automatic whips per race: half the whips minus the press (maxWhips / 2 − 1; 6 whips → 2), so one held press
        /// gives half of the race's whips and the rest are taps. Measured in AccessibilityTests: with all the whips
        /// automatic a single well-timed hold rode level with the best tapping; with half it stays clearly under it.
        /// </summary>
        public static int MaxRepeats(RulesetParams p) => Math.Max(0, p.MaxWhips / 2 - 1);

        /// <summary>Automatic whips this race (tests, diagnostics).</summary>
        public int Repeats { get; private set; }

        /// <summary>Call every frame with the button state; returns the bits to OR into this frame's input.</summary>
        public byte Next(RaceSim sim, int slot, bool held)
        {
            if (sim == null || slot < 0 || slot >= sim.EntrantCount) { _wasHeld = held; return 0; }
            bool press = held && !_wasHeld;
            _wasHeld = held;
            if (!held) { _repeat = false; return 0; }
            int t = sim.Tick;
            var me = sim.GetHorse(slot);
            if (press)
            {
                _decidedTick = t;
                if (!me.Departed) { _repeat = false; return Cmd.Start; }
                _repeat = sim.Config.Mode != RaceMode.Tutorial;
                _lastWhipTick = t;
                return Cmd.Whip;
            }
            if (!_repeat || t == _decidedTick) return 0;
            _decidedTick = t;
            if (me.Finished || me.WhipsLeft <= 0 || Repeats >= MaxRepeats(sim.P) || t - _lastWhipTick < Spacing(sim.P)) return 0;
            _lastWhipTick = t;
            Repeats++;
            return Cmd.Whip;
        }

        /// <summary>Call when a new race starts (the repeat budget is per race).</summary>
        public void Reset() { _wasHeld = false; _repeat = false; _lastWhipTick = -100000; _decidedTick = -1; Repeats = 0; }
    }

    public sealed partial class ApiClient
    {
        /// <summary>REQ-A11Y-002: the account's settings (defaults when never set).</summary>
        public Task<AccessibilitySettings> GetAccessibilityAsync(CancellationToken ct = default)
            => Call("GET", "/v1/settings/accessibility", null, true, null, true, AccessibilitySettings.Parse, ct);

        /// <summary>REQ-A11Y-002: replaces the whole blob (idempotent: the same values twice change nothing, so retries are safe).</summary>
        public Task<AccessibilitySettings> SetAccessibilityAsync(AccessibilitySettings s, CancellationToken ct = default)
            => Call("PUT", "/v1/settings/accessibility", (s ?? AccessibilitySettings.Defaults).ToBody(), true, null, true, AccessibilitySettings.Parse, ct);
    }
}
