using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;

namespace Muchi.Game
{
    // アクセシビリティ設定 (REQ-A11Y-001..016, contracts/protocol.md §41, docs/handoff-codex-round15-accessibility.md).
    // Pure C# (no UnityEngine). The settings live on the account (GET/PUT /v1/settings/accessibility, `accessibility` in the
    // bootstrap) with a device copy that applies at once and offline. Screens bind the values below; nothing here touches
    // a race result (the whip hold only produces normal taps, Muchi.Client.WhipHold).

    /// <summary>One choice of a settings row (a button).</summary>
    public sealed class AccessibilityChoice
    {
        /// <summary>The wire value ("largest", "cvd", "on", "hold"…), passed back to <see cref="AccessibilityModel.SetAsync(string, string, CancellationToken)"/>.</summary>
        public string Value;
        public string Label;
        public bool Selected;
    }

    /// <summary>One row of the settings screen: name, a one-line description, the choices.</summary>
    public sealed class AccessibilityRow
    {
        /// <summary>The server key (textSize, colorMode, reduceMotion, subtitles, haptics, oneHanded, whipInput).</summary>
        public string Key;
        public string Label, Description;
        /// <summary>"display" (left column) or "controls" (right column).</summary>
        public string Group;
        public List<AccessibilityChoice> Choices = new List<AccessibilityChoice>();
    }

    public sealed class AccessibilityModel : ScreenModel
    {
        /// <summary>The device copy (AccessibilitySettings.ToLocalJson) and its "not sent yet" mark.</summary>
        public const string KeyBlob = "muchi.a11y.settings";
        public const string KeyDirty = "muchi.a11y.dirty";

        public const string TextTitle = "アクセシビリティ";
        public const string TextSubtitle = "文字・色・動き・操作。アカウントに保存され、オフラインでも使えます";
        public const string TextGroupDisplay = "表示";
        public const string TextGroupControls = "操作・音";
        public const string TextTextSize = "文字の大きさ";
        public const string TextTextSizeDesc = "本文の文字を大きくします";
        public const string TextStandard = "標準";
        public const string TextLarge = "大";
        public const string TextLargest = "特大";
        public const string TextColor = "色覚サポート";
        public const string TextColorDesc = "ゲージ・順位・状態の色を見分けやすくします";
        public const string TextMotion = "動きを減らす";
        public const string TextMotionDesc = "揺れ・点滅・演出の動きを減らします";
        public const string TextSubtitles = "字幕（実況）";
        public const string TextSubtitlesDesc = "実況を文字で表示します";
        public const string TextHaptics = "振動";
        public const string TextHapticsDesc = "ムチや警告で端末を振動させます";
        public const string TextOneHanded = "片手レイアウト";
        public const string TextOneHandedDesc = "レースの操作を片側にまとめます";
        public const string TextLeftHand = "左手";
        public const string TextRightHand = "右手";
        public const string TextWhip = "ムチの入力";
        public const string TextWhipDesc = "長押しで決まった間隔のムチ（1レース3本まで、残りはタップ）";
        public const string TextTap = "タップ";
        public const string TextHold = "長押し";
        public const string TextOn = "オン";
        public const string TextOff = "オフ";
        public const string TextFairness = "長押しはタップと同じ操作を決まった間隔で送るだけです。ランク戦の強さは変わりません。";
        public const string TextFlash = "点滅は1秒に3回までに抑えています";
        public const string TextSaved = "アクセシビリティ設定を保存しました";
        public const string TextOffline = "オンラインになったら保存します";
        public const string TextHoldLeft = "長押し あと{n}";

        public AccessibilityModel(GameBackend backend, IKeyValueStore store = null) : base(backend, store ?? backend?.Store) { }

        // ---------------------------------------------------------------- what screens bind
        public AccessibilitySettings Settings => B.Accessibility;
        /// <summary>Body text multiplier (1.0 / 1.15 / 1.3).</summary>
        public float TextScaleFactor => TextScale.Factor(Settings.TextSize);
        /// <summary>The size to draw a text designed at <paramref name="basePx"/> (headings ≥ 28 px unchanged).</summary>
        public float Px(float basePx) => TextScale.Px(basePx, Settings.TextSize);
        /// <summary>The current palette: token → sRGB hex (AccessibilityTokens names).</summary>
        public IReadOnlyDictionary<string, string> Palette => AccessibilityTokens.Palette(Settings.ColorMode);
        public string Color(string token) => AccessibilityTokens.Color(Settings.ColorMode, token);
        public bool CriticalHatch => AccessibilityTokens.CriticalHatch(Settings.ColorMode);
        public MotionPolicy Motion => MotionPolicy.For(Settings);
        public bool Haptics => Settings.Haptics;
        public bool Subtitles => Settings.Subtitles;
        public OneHandedLayout OneHanded => Settings.OneHanded;
        public WhipInput WhipInput => Settings.WhipInput;
        /// <summary>Shared limiter for one-shot flashes (REQ-A11Y-008): ask it before lighting anything.</summary>
        public static readonly FlashLimiter Flashes = new FlashLimiter();
        /// <summary>A change has not reached the server yet (sent by the next <see cref="SyncAsync"/>).</summary>
        public bool Dirty => Kv.Get(KeyDirty) == "1";

        /// <summary>Sets the race input's whip mode (call when a race screen opens).</summary>
        public void ApplyTo(RaceInput input) { if (input != null) input.WhipMode = Settings.WhipInput; }
        /// <summary>The HUD hint under the whip in hold mode (null in tap mode).</summary>
        public string HoldHint(int repeatsLeft) => Settings.WhipInput == WhipInput.Hold ? Loc.T(TextHoldLeft).Replace("{n}", repeatsLeft.ToString(System.Globalization.CultureInfo.InvariantCulture)) : null;

        public static AccessibilitySettings ReadLocal(IKeyValueStore kv) => AccessibilitySettings.Parse(kv?.Get(KeyBlob));

        // ---------------------------------------------------------------- sync
        /// <summary>
        /// REQ-A11Y-004, at start-up and when the screen opens: an unsent device change is PUT (the device wins);
        /// otherwise the server's value (the bootstrap's, or a GET) replaces the device copy (a change made on another
        /// device arrives). Offline it keeps the device copy. <paramref name="useBootstrap"/>: right after start-up, take the
        /// bootstrap's `accessibility` instead of a GET.
        /// </summary>
        public async Task<ActionResult> SyncAsync(bool useBootstrap = false, CancellationToken ct = default)
        {
            Message = null;
            if (!ServerAvailable) return ActionResult.Success();
            try
            {
                AccessibilitySettings s;
                if (Dirty) s = await B.Api.SetAccessibilityAsync(Settings, ct);
                else s = useBootstrap && B.Player != null ? B.Player.Accessibility : await B.Api.GetAccessibilityAsync(ct);
                Online = true;
                Store(s, dirty: false);
                return ActionResult.Success();
            }
            catch (ApiException e) { Message = UxText.For(e); return ActionResult.Error(Message); }
        }

        /// <summary>Changes settings: applied and stored on the device at once, then PUT (offline: kept as unsent).</summary>
        public async Task<ActionResult> SetAsync(Action<AccessibilitySettings> change, CancellationToken ct = default)
        {
            var next = Settings.Clone();
            change?.Invoke(next);
            if (next.SameValues(Settings)) return ActionResult.Success();
            Store(next, dirty: true);
            if (!ServerAvailable) return ActionResult.Success(TextOffline);
            try
            {
                var s = await B.Api.SetAccessibilityAsync(next, ct);
                Online = true;
                // a newer change made while this was in flight stays (and stays unsent)
                if (Settings.SameValues(next)) Store(s, dirty: false);
                return ActionResult.Success(TextSaved);
            }
            catch (ApiException e) { Message = UxText.For(e); return ActionResult.Error(TextOffline); }
        }

        /// <summary>A settings-screen button: <paramref name="key"/> = row key, <paramref name="value"/> = choice value.</summary>
        public Task<ActionResult> SetAsync(string key, string value, CancellationToken ct = default) => SetAsync(s => Apply(s, key, value), ct);

        private void Store(AccessibilitySettings s, bool dirty)
        {
            Kv.Set(KeyBlob, s.ToLocalJson());
            Kv.Set(KeyDirty, dirty ? "1" : "0");
            B.Accessibility = s;
        }

        public static void Apply(AccessibilitySettings s, string key, string value)
        {
            switch (key)
            {
                case "textSize": s.TextSize = AccessibilitySettings.ParseTextSize(value); break;
                case "colorMode": s.ColorMode = value == "cvd" ? ColorMode.Cvd : ColorMode.Standard; break;
                case "reduceMotion": s.ReduceMotion = value == "on"; break;
                case "subtitles": s.Subtitles = value != "off"; break;
                case "haptics": s.Haptics = value != "off"; break;
                case "oneHanded": s.OneHanded = value == "left" ? OneHandedLayout.Left : value == "right" ? OneHandedLayout.Right : OneHandedLayout.Off; break;
                case "whipInput": s.WhipInput = value == "hold" ? WhipInput.Hold : WhipInput.Tap; break;
            }
        }

        // ---------------------------------------------------------------- the settings screen
        /// <summary>The seven rows in screen order (display column, then controls column), the current choice selected.</summary>
        public List<AccessibilityRow> Rows()
        {
            var s = Settings;
            AccessibilityRow Row(string key, string group, string label, string desc, string current, params (string v, string l)[] choices)
            {
                var r = new AccessibilityRow { Key = key, Group = group, Label = Loc.T(label), Description = Loc.T(desc) };
                foreach (var (v, l) in choices) r.Choices.Add(new AccessibilityChoice { Value = v, Label = Loc.T(l), Selected = v == current });
                return r;
            }
            string OnOff(bool b) => b ? "on" : "off";
            return new List<AccessibilityRow>
            {
                Row("textSize", "display", TextTextSize, TextTextSizeDesc, AccessibilitySettings.Wire(s.TextSize), ("standard", TextStandard), ("large", TextLarge), ("largest", TextLargest)),
                Row("colorMode", "display", TextColor, TextColorDesc, AccessibilitySettings.Wire(s.ColorMode), ("standard", TextStandard), ("cvd", TextColor)),
                Row("reduceMotion", "display", TextMotion, TextMotionDesc, OnOff(s.ReduceMotion), ("off", TextOff), ("on", TextOn)),
                Row("subtitles", "controls", TextSubtitles, TextSubtitlesDesc, OnOff(s.Subtitles), ("on", TextOn), ("off", TextOff)),
                Row("haptics", "controls", TextHaptics, TextHapticsDesc, OnOff(s.Haptics), ("on", TextOn), ("off", TextOff)),
                Row("oneHanded", "controls", TextOneHanded, TextOneHandedDesc, AccessibilitySettings.Wire(s.OneHanded), ("off", TextOff), ("left", TextLeftHand), ("right", TextRightHand)),
                Row("whipInput", "controls", TextWhip, TextWhipDesc, AccessibilitySettings.Wire(s.WhipInput), ("tap", TextTap), ("hold", TextHold)),
            };
        }
    }
}
