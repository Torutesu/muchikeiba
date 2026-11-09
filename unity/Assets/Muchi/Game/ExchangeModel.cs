using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;

namespace Muchi.Game
{
    // REQ-EXCH-001..012 (contracts/protocol.md §30, docs/handoff-codex-round13-event-exchange.md): イベント交換所, the game layer.
    // Pure C#: Codex's event top binds to the point counter, the exchange grid to Cards, the confirm sheet to Pending*.
    // The model never decides an outcome: the server checks the window, stock and points in one transaction.

    /// <summary>One exchange line on the grid.</summary>
    public sealed class ExchangeCard
    {
        public string Id, Name, Kind;
        /// <summary>Item art key (null for coins: the coin icon).</summary>
        public string Icon;
        /// <summary>"120 ポイント".</summary>
        public string PriceText;
        /// <summary>"残り 2 / 3" (the player's own stock for this event: a fact, never urgency).</summary>
        public string StockText;
        /// <summary>"無償コイン50枚" / "配合素材" (+ "（2個）" for more than one) / the horse's name.</summary>
        public string RewardText;
        public bool Enabled;
        /// <summary>Why it cannot be exchanged now (one sentence), null when enabled.</summary>
        public string BlockedText;
        public bool SoldOut, Owned;
        public int MaxQty;
    }

    /// <summary>
    /// The event exchange. Rules the model keeps for the screen:
    ///  - points come only from racing the event; <see cref="RulesText"/> says so (no purchase, nothing random);
    ///  - every time shown comes from the server's instants (closesAtMs, resetsAtMs) — no countdown theatre;
    ///  - the confirm keeps its idempotency key until the server answers, so a retry after a timeout never pays twice;
    ///  - after the event (grace) the notice says until when and what the leftover points become;
    ///  - no link to the shop: points cannot be bought.
    /// </summary>
    public sealed class ExchangeModel : ScreenModel
    {
        public const string KeyPendingBuy = "muchi.exchange.buy";
        const long JstOffsetMs = 9L * 3600 * 1000;

        public const string RulesText = "イベントポイントはこのイベントのレースでだけ貯まります（購入はできません）。交換の中身はすべて固定で、ランダムなものはありません。";
        public const string NoUndoText = "交換は取り消せません";

        public ExchangeModel(GameBackend backend, IKeyValueStore store = null) : base(backend, store ?? backend?.Store) { }

        public string EventId { get; private set; }
        public ExchangeView View { get; private set; }
        public ExchangeResult LastResult { get; private set; }

        public int Points => View?.Points ?? 0;
        /// <summary>The event top's counter: "イベントポイント 120".</summary>
        public string PointsText => View == null ? null : "イベントポイント " + N(View.Points);
        /// <summary>"今日あと 30 ポイントまで" while the event is on; the cap sentence once reached; null otherwise.</summary>
        public string EarnTodayText
        {
            get
            {
                if (View == null || View.Status != "open") return null;
                return View.Earn.RemainingToday > 0 ? "今日あと " + N(View.Earn.RemainingToday) + " ポイントまで" : "今日のポイントは上限です。4:00に戻ります";
            }
        }
        /// <summary>"1着 40 ポイント" — what a win earns (byPlace[0] + participation).</summary>
        public string WinPointsText => View == null ? null : "1着 " + N(View.Earn.PointsFor(1)) + " ポイント";

        /// <summary>The period line from the real instants.</summary>
        public string PeriodText
        {
            get
            {
                if (View == null) return null;
                switch (View.Status)
                {
                    case "upcoming": return JstDateTime(View.StartAtMs) + "から";
                    case "open": return "イベントは " + JstDateTime(View.EndAtMs - 60_000) + "まで";
                    case "grace": return "イベントは終了しました。交換は " + JstDateTime(View.ClosesAtMs - 60_000) + "まで";
                    default: return "交換は終了しました";
                }
            }
        }

        /// <summary>The post-event notice (grace / closed), null while the event runs.</summary>
        public string GraceNotice
        {
            get
            {
                if (View == null) return null;
                if (View.Status == "grace") return PeriodText;
                if (View.Status == "closed") return "交換は終了しました";
                return null;
            }
        }

        /// <summary>What the leftover points become, shown before the close (rate and rounding stated); after the close, what they became.</summary>
        public string LeftoverText
        {
            get
            {
                var l = View?.Leftover;
                if (l == null) return null;
                if (l.Converted != null) return "残りの " + N(l.Converted.Points) + " ポイントは配合素材 " + N(l.Converted.Qty) + "個になりました";
                return "残りのポイントは交換の終了時に配合素材 " + N(l.QtyFor(View.Points)) + "個になります（" + N(l.PointsPerUnit) + "ポイントごとに1個・切り上げ）";
            }
        }

        public List<ExchangeCard> Cards
        {
            get
            {
                var list = new List<ExchangeCard>();
                if (View == null) return list;
                foreach (var l in View.Items)
                {
                    string blocked = !View.CanExchange ? (View.Status == "upcoming" ? "交換所はまだ開いていません" : "交換は終了しました")
                        : l.Owned ? "所持しています"
                        : l.Remaining <= 0 ? "交換済み"
                        : View.Points < l.Price ? "ポイントが足りません"
                        : null;
                    list.Add(new ExchangeCard
                    {
                        Id = l.Id, Name = l.Name, Kind = l.Kind, Icon = l.Icon, PriceText = N(l.Price) + " ポイント",
                        StockText = "残り " + N(l.Remaining) + " / " + N(l.Stock), RewardText = RewardText(l),
                        Enabled = blocked == null, BlockedText = blocked, SoldOut = l.Remaining <= 0, Owned = l.Owned, MaxQty = l.MaxQty,
                    });
                }
                return list;
            }
        }

        public static string RewardText(ExchangeLine l)
        {
            if (l.RewardFreeCoins > 0) return "無償コイン" + N(l.RewardFreeCoins) + "枚";
            if (l.RewardHorse != null) return l.Name;
            var it = l.RewardItems.FirstOrDefault();
            return it == null || it.Qty <= 1 ? l.Name : l.Name + "（" + N(it.Qty) + "個）";
        }

        // ---- confirm sheet

        public ExchangeLine Pending { get; private set; }
        public int PendingQty { get; private set; }
        /// <summary>"交換に使うポイント 240".</summary>
        public string PendingCostText => Pending == null ? null : "交換に使うポイント " + N(Pending.Price * PendingQty);
        /// <summary>"交換後のポイント 0".</summary>
        public string PendingAfterText => Pending == null ? null : "交換後のポイント " + N(View.Points - Pending.Price * PendingQty);
        /// <summary>"残り 2 / 3 → 1 / 3".</summary>
        public string PendingStockText => Pending == null ? null : "残り " + N(Pending.Remaining) + " / " + N(Pending.Stock) + " → " + N(Pending.Remaining - PendingQty) + " / " + N(Pending.Stock);

        /// <summary>Opens the confirm sheet for one line (qty clamped to what the points and stock allow).</summary>
        public ActionResult Select(string itemId, int qty = 1)
        {
            var card = Cards.FirstOrDefault(c => c.Id == itemId);
            if (card == null || !card.Enabled) return ActionResult.Error(card?.BlockedText ?? "選べません");
            Pending = View.Find(itemId);
            PendingQty = Math.Max(1, Math.Min(qty, Pending.MaxQty));
            return ActionResult.Success();
        }

        public void CancelSelection() { Pending = null; PendingQty = 0; }

        /// <summary>Loads the exchange of one event.</summary>
        public async Task<ActionResult> LoadAsync(string eventId, CancellationToken ct = default)
        {
            Message = null; EventId = eventId; Pending = null;
            if (!ServerAvailable) { View = null; return Offline("交換所はオンラインで使えます"); }
            try
            {
                View = await B.Api.GetExchangeAsync(eventId, ct);
                Online = true;
                return ActionResult.Success();
            }
            catch (ApiException e) { Message = UxText.For(e); return ActionResult.Error(Message); }
        }

        /// <summary>Confirms the pending exchange. A transient failure keeps the key for the retry (never paid twice).</summary>
        public async Task<ActionResult> ConfirmAsync(CancellationToken ct = default)
        {
            if (Pending == null) return ActionResult.Error("交換するものを選んでください");
            string key = PendingKey(EventId + ":" + Pending.Id + ":" + PendingQty + ":" + Pending.Bought);
            try
            {
                LastResult = await B.Api.ExchangeAsync(EventId, Pending.Id, PendingQty, key, ct);
                Kv.Set(KeyPendingBuy, "");
                if (LastResult.Exchange != null) View = LastResult.Exchange;
                Pending = null; PendingQty = 0;
                return ActionResult.Success("交換しました");
            }
            catch (ApiException e)
            {
                if (!GameBackend.IsTransient(e)) { Kv.Set(KeyPendingBuy, ""); Pending = null; }
                Message = UxText.For(e);
                return ActionResult.Error(Message);
            }
        }

        private string PendingKey(string scope)
        {
            var stored = (Kv.Get(KeyPendingBuy) ?? "").Split('|');
            if (stored.Length == 2 && stored[0] == scope) return stored[1];
            string key = B.Api.NewIdempotencyKey();
            Kv.Set(KeyPendingBuy, scope + "|" + key);
            return key;
        }

        static string N(int n) => n.ToString(CultureInfo.InvariantCulture);

        /// <summary>"1月15日 3:59" (JST), the same form as the scout calendar.</summary>
        public static string JstDateTime(long ms)
        {
            var d = DateTimeOffset.FromUnixTimeMilliseconds(ms + JstOffsetMs).UtcDateTime;
            return d.Month.ToString(CultureInfo.InvariantCulture) + "月" + d.Day.ToString(CultureInfo.InvariantCulture) + "日 " + d.Hour.ToString(CultureInfo.InvariantCulture) + ":" + d.Minute.ToString("00", CultureInfo.InvariantCulture);
        }
    }
}
