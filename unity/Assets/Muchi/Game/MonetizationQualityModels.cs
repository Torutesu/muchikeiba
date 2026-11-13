using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Muchi.Client;

namespace Muchi.Game
{
    // Quality pass 2 (docs/quality/shop.md): the scout confirmation and the purchase receipt in the game layer. Both only
    // arrange what the server built (GET /v1/gacha/:id/options, POST /v1/shop/purchase → receipt): the client never works
    // out a split, a value or a label itself. KPI scout_confirm / purchase_receipt (§58 optional, counts only).

    /// <summary>
    /// The scout confirmation for one way to pull (coins or a ticket): the spend line with paid and free named (paid first),
    /// the split as two bar fractions, the wallet after, the exchange points it adds. A way the player cannot take is never
    /// confirmed: coins short → the shortfall sheet (CoinShortfallModel); closed / upcoming / debt → the error text.
    /// </summary>
    public sealed class ScoutConfirmModel
    {
        private readonly Action<AnalyticsEvent> _track;
        private readonly NowMs _now;
        private bool _viewed, _done;

        public ScoutOptions Options { get; }
        public ScoutWay Way { get; }
        /// <summary>true for the SR+ ticket (its own table, no banner).</summary>
        public bool SrTicket { get; }

        private ScoutConfirmModel(ScoutOptions o, ScoutWay w, bool sr, Action<AnalyticsEvent> track, NowMs now)
        { Options = o; Way = w; SrTicket = sr; _track = track; _now = now ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()); }

        /// <summary>The confirmation for a way of this banner (null when the way does not exist or cannot be taken now).</summary>
        public static ScoutConfirmModel For(ScoutOptions o, string wayId, Action<AnalyticsEvent> track = null, NowMs now = null)
        {
            var w = o?.Way(wayId);
            return w == null || !w.Available ? null : new ScoutConfirmModel(o, w, false, track, now);
        }

        /// <summary>The SR+ ticket's confirmation while one is held (null otherwise).</summary>
        public static ScoutConfirmModel ForSrTicket(ScoutOptions o, Action<AnalyticsEvent> track = null, NowMs now = null)
        {
            if (o == null || o.SrPlusOwned <= 0 || o.SrPlusItemId == null) return null;
            var w = new ScoutWay { Id = "sr_plus", Via = "sr_ticket", ItemId = o.SrPlusItemId, Label = o.SrPlusName + "を使う", Line = o.SrPlusLine, Count = 1, Owned = o.SrPlusOwned, Available = true, PityGain = 0 };
            return new ScoutConfirmModel(o, w, true, track, now);
        }

        /// <summary>What happens when the player taps a pull button: confirm, or the shortfall sheet, or an error line.</summary>
        public enum Route { Confirm, Shortfall, Blocked }
        public static Route RouteFor(ScoutWay w) => w == null ? Route.Blocked : w.Available ? Route.Confirm : w.Block == "short" ? Route.Shortfall : Route.Blocked;

        public string Via => SrTicket ? "sr_ticket" : Way.Via;
        public bool Coins => Way.Via == "coins";
        public string Title => Coins ? Way.Count + "回引く" : Way.Label;
        public string Kicker => SrTicket ? "スカウト券" : Options.Name;
        /// <summary>The server's line (「有償コイン300枚と無償コイン700枚を使います」 / the ticket line).</summary>
        public string SpendLine => Way.Line;
        /// <summary>Bar fractions, paid first (0 when not a coin pull).</summary>
        public float PaidFraction => Coins && (Way.PaysPaid + Way.PaysFree) > 0 ? (float)Way.PaysPaid.Value / (Way.PaysPaid.Value + Way.PaysFree.Value) : 0f;
        public float FreeFraction => Coins && (Way.PaysPaid + Way.PaysFree) > 0 ? 1f - PaidFraction : 0f;
        public string SplitLine => Coins ? "◈ 有償 " + N(Way.PaysPaid ?? 0) + "　·　◎ 無償 " + N(Way.PaysFree ?? 0) : null;
        public string AfterLine => Coins ? "引いた後　◈ 有償 " + N(Way.AfterPaid ?? 0) + "　·　◎ 無償 " + N(Way.AfterFree ?? 0)
            : Way.Owned.HasValue ? "いま " + Way.Owned.Value + "枚　→　引いた後 " + (Way.Owned.Value - 1) + "枚" : null;
        public string PityLine => Way.PityGain > 0 ? "天井の交換pt ＋" + Way.PityGain : null;
        public string Notice => Coins ? Options.Notice : null;
        public string PullLabel => Coins ? "引く（" + N(Way.Price ?? 0) + "コイン）" : "券を使って引く";
        /// <summary>The rates the pull draws from: the banner's odds page, or the SR+ ticket's own table.</summary>
        public string OddsLabel => SrTicket ? "この券の提供割合を見る" : "提供割合を見る";

        /// <summary>Call when the sheet is shown (one scout_confirm view per sheet).</summary>
        public void Shown() { if (_viewed) return; _viewed = true; _track?.Invoke(AnalyticsEvent.ScoutConfirm(_now(), "view", Via, Way.Count)); }
        /// <summary>The player pulled: returns false when the sheet already ended (a second tap does nothing).</summary>
        public bool Pull() { if (_done) return false; _done = true; _track?.Invoke(AnalyticsEvent.ScoutConfirm(_now(), "pull", Via, Way.Count)); return true; }
        public void Cancel() { if (_done) return; _done = true; _track?.Invoke(AnalyticsEvent.ScoutConfirm(_now(), "cancel", Via, Way.Count)); }

        /// <summary>Every text the sheet shows (for the wording lint and the English check).</summary>
        public IEnumerable<string> Texts() => new[] { Kicker, Title, SpendLine, SplitLine, AfterLine, PityLine, Notice, PullLabel, OddsLabel }.Where(t => t != null);

        private static string N(int n) => n.ToString("N0", CultureInfo.InvariantCulture);
    }

    /// <summary>
    /// The purchase receipt: a row per thing received (label + what it does), the wallet now, the notes, and ONE next step
    /// that uses what was bought. The game opens the screen the action names (ReceiptTarget).
    /// </summary>
    public sealed class PurchaseReceiptModel
    {
        public enum Target { None, ScoutSrTicket, SilksEditor, SeasonPass, AllowanceClaim, Scout }
        private readonly Action<AnalyticsEvent> _track;
        private readonly NowMs _now;
        private bool _viewed, _nextTaken;

        public PurchaseReceipt Receipt { get; }
        public PurchaseReceiptModel(PurchaseReceipt r, Action<AnalyticsEvent> track = null, NowMs now = null)
        { Receipt = r ?? throw new ArgumentNullException(nameof(r)); _track = track; _now = now ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()); }

        public string Kicker => "購入が完了しました";
        public string PriceLine => Receipt.PriceYen.ToString("N0", CultureInfo.InvariantCulture) + "円（税込）";
        public IEnumerable<(string label, string sub, bool coins)> Rows => Receipt.Lines.Select(l => (l.Label, l.Purpose, l.Kind == "paid_coins" || l.Kind == "free_coins" || l.Kind == "bonus_free_coins"));
        public string WalletLine => "いまの残高　◈ 有償 " + Receipt.WalletPaid.ToString("N0", CultureInfo.InvariantCulture) + "　·　◎ 無償 " + Receipt.WalletFree.ToString("N0", CultureInfo.InvariantCulture);
        public string NextLabel => Receipt.Next?.Label;
        public string Action => Receipt.Next?.Action ?? "none";
        public static Target TargetOf(string action)
        {
            switch (action)
            {
                case "use_sr_ticket": return Target.ScoutSrTicket;
                case "wear_silks": return Target.SilksEditor;
                case "open_pass": return Target.SeasonPass;
                case "claim_allowance": return Target.AllowanceClaim;
                case "scout": return Target.Scout;
                default: return Target.None;
            }
        }
        public Target NextTarget => TargetOf(Action);

        public void Shown() { if (_viewed) return; _viewed = true; _track?.Invoke(AnalyticsEvent.PurchaseReceipt(_now(), "view", Receipt.ProductId, Action)); }
        /// <summary>The player took the next step (once): the screen to open.</summary>
        public Target TakeNext()
        {
            if (Receipt.Next == null) return Target.None;
            if (!_nextTaken) { _nextTaken = true; _track?.Invoke(AnalyticsEvent.PurchaseReceipt(_now(), "next", Receipt.ProductId, Action)); }
            return NextTarget;
        }

        public IEnumerable<string> Texts() => new[] { Kicker, Receipt.Name, PriceLine, WalletLine, NextLabel }
            .Concat(Receipt.Lines.SelectMany(l => new[] { l.Label, l.Purpose })).Concat(Receipt.Notes).Where(t => t != null);
        /// <summary>The shop's wording lint applied to the receipt (no 「倍」, no reference price…).</summary>
        public List<string> WordingProblems() => Texts().Where(t => ShopModel.ForbiddenWords.Any(t.Contains)).ToList();
    }
}
