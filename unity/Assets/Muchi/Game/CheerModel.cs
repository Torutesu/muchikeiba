using System;
using System.Collections.Generic;
using Muchi.Client;
using Muchi.Engine;
using Muchi.Net;

namespace Muchi.Game
{
    // 観戦中の応援 (REQ-CHEER-001..016, contracts/protocol.md §55, docs/handoff-codex-round19-spectator-cheer.md): the game layer.
    // Pure C# (no UnityEngine). The spectate screen binds the horse chips and the three cheer buttons; the race HUD binds the
    // racer's quiet 「応援 ×n」. Cheers never touch the race (LockstepClient keeps them outside the simulation), nothing is sold
    // and there is no free text. KPI: one cheer_send / cheer_seen row per race (CheerRaceTally), sent by Finish.

    /// <summary>One cheer button (いけ！ / 差せ！ / 粘れ！). Disabled while the 2 s pace runs or cheering is not possible.</summary>
    public sealed class CheerButton
    {
        public string Kind, Label;
        public bool Enabled;
    }

    /// <summary>One horse the spectator can point a cheer at (horse number = slot + 1).</summary>
    public sealed class CheerHorseChip
    {
        public int Slot;
        public string NumberText, HorseName;
        public bool Selected;
        /// <summary>Cheers this horse got this race (from the windows the room sent us).</summary>
        public int Total;
    }

    public sealed class CheerModel
    {
        public const string KeyIndicator = "muchi.cheer.indicator";

        public const string Title = "応援";
        public const string TargetLabel = "応援する馬";
        public const string HorseNumber = "{n}番";
        public const string PaceNote = "応援は2秒に1回まで";
        public const string FairnessNote = "応援はレースの結果に影響しません";
        public const string UnavailableNote = "このレースでは応援できません";
        public const string SentToast = "{n}番に「{cheer}」";
        public const string IndicatorSetting = "レース中の応援表示";
        public const string IndicatorSettingDesc = "観戦している人からの応援を、レース中に小さく表示します";
        public const string MomentLabel = "応援の多かった瞬間";
        public const string MomentCount = "応援 {n}";

        private readonly IKeyValueStore _store;
        private readonly Func<long> _clock;
        private readonly Action<AnalyticsEvent> _track;
        private LockstepClient _client;
        private CheerThrottle _throttle = new CheerThrottle();
        private CheerRaceTally _tally = new CheerRaceTally();
        private string _role;

        public CheerModel(IKeyValueStore store = null, Func<long> clock = null, Action<AnalyticsEvent> track = null, AccessibilitySettings accessibility = null)
        {
            _store = store;
            _clock = clock ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            _track = track;
            ApplyAccessibility(accessibility);
            Indicator.On = IndicatorOn;
        }

        public CheerIndicator Indicator { get; } = new CheerIndicator();
        public CheerBurst Burst { get; } = new CheerBurst();
        public List<CheerHorseChip> Horses { get; } = new List<CheerHorseChip>();
        public List<CheerButton> Buttons { get; } = new List<CheerButton>();
        public int SelectedSlot { get; private set; } = -1;
        /// <summary>A one-line confirmation after a cheer (「3番に「いけ！」」), or null.</summary>
        public string Toast { get; private set; }

        /// <summary>REQ-CHEER-010: the racer's setting (default on). Stored on the device; applies at once.</summary>
        public bool IndicatorOn
        {
            get => _store?.Get(KeyIndicator) != "0";
            set { _store?.Set(KeyIndicator, value ? "1" : "0"); Indicator.On = value; }
        }

        /// <summary>REQ-CHEER-010 (§41): reduced motion turns the pulses off (text only). Call again when the settings change.</summary>
        public void ApplyAccessibility(AccessibilitySettings s)
        {
            bool reduced = MotionPolicy.For(s).Reduced;
            Indicator.ReduceMotion = reduced;
            Burst.ReduceMotion = reduced;
        }

        /// <summary>True while the spectate screen should show the buttons (the room offered cheers and the race is live for us).</summary>
        public bool Available => _client != null && _role == "spectator" && _client.CanCheer;
        /// <summary>The line under the buttons: the pace, or why cheering is not possible.</summary>
        public string Note => _role == "spectator" && _client != null && _client.CheerOffer == null ? UnavailableNote : PaceNote;

        // ---------------------------------------------------------------- spectator

        /// <summary>The spectate screen started (after the room's start). Builds the chips (first horse selected) and the buttons.</summary>
        public void AttachSpectator(LockstepClient client)
        {
            Attach(client, "spectator");
            _throttle = new CheerThrottle(client.CheerOffer?.MinIntervalMs ?? 2000);
            Horses.Clear();
            if (client.Config != null)
                foreach (var e in client.Config.Entrants)
                    Horses.Add(new CheerHorseChip { Slot = e.Slot, NumberText = HorseNumber.Replace("{n}", (e.Slot + 1).ToString()), HorseName = e.Horse?.Name ?? "" });
            Select(Horses.Count > 0 ? Horses[0].Slot : -1);
            Refresh();
        }

        public void Select(int slot)
        {
            SelectedSlot = slot;
            foreach (var h in Horses) h.Selected = h.Slot == slot;
        }

        /// <summary>Re-evaluates the buttons (call each frame or on a timer: the pace greys them for 2 s).</summary>
        public void Refresh()
        {
            Buttons.Clear();
            long now = _clock();
            bool can = Available && SelectedSlot >= 0 && _throttle.CanSend(now);
            foreach (var k in CheerKinds.All)
            {
                bool offered = _client?.CheerOffer != null && _client.CheerOffer.Kinds.Contains(k);
                if (_client?.CheerOffer != null && !offered) continue;
                Buttons.Add(new CheerButton { Kind = k, Label = CheerKinds.Label(k), Enabled = can && offered });
            }
        }

        /// <summary>REQ-CHEER-003/004: one tap = one cheer for the selected horse, at most one every 2 s. False = nothing sent.</summary>
        public bool Send(string kind)
        {
            long now = _clock();
            Toast = null;
            if (!Available || SelectedSlot < 0 || !_throttle.CanSend(now)) { Refresh(); return false; }
            if (!_client.SendCheer(SelectedSlot, kind)) { Refresh(); return false; }
            _throttle.Mark(now);
            _tally.AddSent();
            Toast = SentToast.Replace("{n}", (SelectedSlot + 1).ToString()).Replace("{cheer}", CheerKinds.Label(kind));
            Refresh();
            return true;
        }

        // ---------------------------------------------------------------- racer

        /// <summary>The race HUD started (we ride slot client.Slot). The indicator stays empty until a window names our horse.</summary>
        public void AttachRacer(LockstepClient client)
        {
            Attach(client, "racer");
            Indicator.Reset();
            Indicator.On = IndicatorOn;
        }

        // ---------------------------------------------------------------- both

        private void Attach(LockstepClient client, string role)
        {
            Detach();
            _client = client ?? throw new ArgumentNullException(nameof(client));
            _role = role;
            _tally = new CheerRaceTally();
            Toast = null;
            client.CheersReceived += OnCheers;
        }

        private void Detach()
        {
            if (_client != null) _client.CheersReceived -= OnCheers;
        }

        private void OnCheers(LockstepClient c, IReadOnlyList<CheerCount> rows)
        {
            long now = _clock();
            if (_role == "racer")
            {
                int seenBefore = Indicator.Seen;
                Indicator.OnCheers(rows, c.Slot, now);
                _tally.AddSeen(Indicator.Seen - seenBefore);
                return;
            }
            Burst.OnCheers(rows, now);
            int n = 0;
            foreach (var r in rows) if (r.Count > 0 && CheerKinds.Known(r.Kind)) n += r.Count;
            _tally.AddSeen(n);
            foreach (var h in Horses) h.Total = Burst.TotalFor(h.Slot);
        }

        /// <summary>The race (or watching it) ended: sends this race's cheer_send / cheer_seen once and stops listening.</summary>
        public void Finish()
        {
            if (_client == null) return;
            var mode = _client.Config == null ? null : CheerKinds.ModeName(_client.Config.Mode);
            foreach (var e in _tally.Finish(_clock(), mode, _role)) _track?.Invoke(e);
            Detach();
            Refresh();
        }

        /// <summary>REQ-CHEER-012: the replay seek bar's markers (fraction 0..1 and the 「応援 n」 caption).</summary>
        public static List<(double Fraction, string Caption)> MomentMarkers(ReplayData data)
        {
            var list = new List<(double, string)>();
            if (data?.CheerMoments == null || data.Log == null) return list;
            int end = data.Log.EndTick > 0 ? data.Log.EndTick : 1;
            foreach (var m in data.CheerMoments) list.Add((m.Fraction(end), MomentCount.Replace("{n}", m.Count.ToString())));
            return list;
        }
    }
}
