using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;

namespace Muchi.Game
{
    // REQ-BOX-001..014 プレゼントボックス (contracts/protocol.md §26). Pure C#: Codex's screens bind to the public fields.
    //
    // Rules the model keeps for the screens:
    //  - the expiry text 「あと3日」 is shown only for a real expiresAt from the server (no expiry = no text, never a made-up
    //    timer); whole days rounded up, never less than 「あと1日」;
    //  - claims keep their idempotency key until the server answers (a retry after a timeout never receives twice);
    //  - a gift over a hold limit stays in the box with its reason; others in the same claim-all are received;
    //  - while the account is scheduled for deletion nothing can be received (DeletionGuard banner instead of the buttons);
    //  - paid coins never appear here (the box only holds free coins and items).

    /// <summary>One row of the box or the history, ready to draw.</summary>
    public sealed class GiftRow
    {
        public string GiftId, Source, Title, Status;
        /// <summary>Content lines from the server (「無償コイン300枚」「スカウト券×1」).</summary>
        public List<string> Lines = new List<string>();
        /// <summary>「あと3日」 / null (no expiry, or a history row).</summary>
        public string ExpiryText;
        /// <summary>True within the server's expiringSoon window (3 days): the screen may tint the text, never add urgency words.</summary>
        public bool ExpiringSoon;
        /// <summary>「受け取り済み」「期限切れ」 (history) or null.</summary>
        public string StatusText;
        /// <summary>Why the last claim left it in the box (「持てる上限のため受け取れませんでした」) or null.</summary>
        public string HeldText;
        public string RankText;
        public bool CanClaim;
        public bool IsCompensation;
    }

    public sealed class GiftBoxModel : ScreenModel
    {
        public const string KeyPending = "muchi.giftbox.claim";
        public const int PageSize = 50;
        public static readonly IReadOnlyDictionary<string, string> SourceLabels = new Dictionary<string, string>
        {
            ["ops_compensation"] = "お詫び", ["ops_grant"] = "運営", ["invite"] = "招待", ["event"] = "イベント", ["tournament"] = "大会",
            ["team"] = "支部", ["league"] = "支部対抗", ["season"] = "シーズン", ["team_goal"] = "共同目標", ["exchange"] = "交換所",
        };

        private readonly NowMs _now;

        public GiftBoxModel(GameBackend backend, NowMs now = null) : base(backend, backend?.Store) { _now = now ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()); }

        /// <summary>box | history</summary>
        public string Tab { get; private set; } = "box";
        public GiftBoxPage Page { get; private set; }
        public List<GiftRow> Rows { get; private set; } = new List<GiftRow>();
        public GiftClaimResult LastResult { get; private set; }
        /// <summary>The result panel lines (「無償コイン450枚」「スカウト券×1」 and one line per held gift).</summary>
        public List<string> ResultLines { get; private set; } = new List<string>();
        public string Toast { get; private set; }

        public bool Blocked => DeletionGuard.Pending(B);
        public string BlockedText => DeletionGuard.Banner(B);
        public bool Enabled => Page == null || Page.Enabled;
        public int Badge => Page?.Badge.Unclaimed ?? B?.Player?.GiftBox?.Unclaimed ?? 0;
        public bool CanClaimAll => Tab == "box" && !Blocked && Page != null && Page.Total > 0;
        public string ClaimAllText => CanClaimAll ? "まとめて受け取る（" + Page.Total + "件）" : null;
        public string EmptyText => Tab == "box" ? "プレゼントはありません" : "直近90日の履歴はありません";
        public bool HasMore => Page?.NextOffset != null;
        /// <summary>Shown under the list (the box rule in plain words).</summary>
        public string Notice => "受け取り期限を過ぎたプレゼントは受け取れなくなります。有償コインはプレゼントボックスに入りません。";

        public async Task<ActionResult> LoadAsync(string tab = "box", CancellationToken ct = default)
        {
            Message = null;
            Tab = tab == "history" ? "history" : "box";
            if (!ServerAvailable) { Page = null; Rebuild(); return Offline("プレゼントボックスはオンラインで表示されます"); }
            try
            {
                Page = await B.Api.GetGiftBoxAsync(Tab, 0, PageSize, ct);
                Online = true;
                Rebuild();
                return ActionResult.Success();
            }
            catch (ApiException e) { Message = UxText.For(e); return ActionResult.Error(Message); }
        }

        /// <summary>The next page of the current tab (appended).</summary>
        public async Task<ActionResult> LoadMoreAsync(CancellationToken ct = default)
        {
            if (!HasMore || !ServerAvailable) return ActionResult.Success();
            try
            {
                var next = await B.Api.GetGiftBoxAsync(Tab, Page.NextOffset.Value, PageSize, ct);
                next.Entries.InsertRange(0, Page.Entries);
                Page = next;
                Rebuild();
                return ActionResult.Success();
            }
            catch (ApiException e) { Message = UxText.For(e); return ActionResult.Error(Message); }
        }

        public Task<ActionResult> ClaimAsync(string giftId, CancellationToken ct = default)
        {
            var row = Rows.Find(r => r.GiftId == giftId);
            if (row == null || !row.CanClaim) return Task.FromResult(ActionResult.Error(Blocked ? BlockedText : UxText.Errors["NOT_ELIGIBLE"]));
            return Claim("one:" + giftId, key => B.Api.ClaimGiftAsync(giftId, key, ct), ct);
        }

        public Task<ActionResult> ClaimAllAsync(CancellationToken ct = default)
        {
            if (!CanClaimAll) return Task.FromResult(ActionResult.Error(Blocked ? BlockedText : UxText.Errors["NOT_ELIGIBLE"]));
            return Claim("all", key => B.Api.ClaimAllGiftsAsync(key, ct), ct);
        }

        private async Task<ActionResult> Claim(string scope, Func<string, Task<GiftClaimResult>> call, CancellationToken ct)
        {
            Toast = null;
            string key = PendingKey(scope);
            try
            {
                var r = await call(key);
                Kv.Set(KeyPending, "");
                LastResult = r;
                ResultLines = ResultTexts(r);
                Toast = r.Claimed.Count > 0 ? r.Claimed.Count + "件のプレゼントを受け取りました" : "受け取れるプレゼントはありませんでした";
                try { Page = await B.Api.GetGiftBoxAsync(Tab, 0, PageSize, ct); } catch (ApiException) { /* the result panel is enough */ }
                Rebuild();
                await B.RefreshAsync(ct);
                return ActionResult.Success(Toast);
            }
            catch (ApiException e)
            {
                if (!GameBackend.IsTransient(e)) Kv.Set(KeyPending, "");
                Message = UxText.For(e);
                return ActionResult.Error(Message);
            }
        }

        /// <summary>「無償コイン450枚」 + items + one line per gift that stayed in the box.</summary>
        public static List<string> ResultTexts(GiftClaimResult r, Func<string, string> itemName = null)
        {
            var lines = new List<string>();
            if (r.TotalFreeCoins > 0) lines.Add("無償コイン" + r.TotalFreeCoins.ToString("N0", CultureInfo.InvariantCulture) + "枚");
            foreach (var kv in r.TotalItems) lines.Add((itemName?.Invoke(kv.Key) ?? kv.Key) + "×" + kv.Value);
            foreach (var h in r.Held) lines.Add(HeldReasonText(h.Reason));
            return lines;
        }

        public static string HeldReasonText(string reason) => reason == "coin_cap" ? "無償コインの持てる上限のため、1件はボックスに残しました" : "アイテムの持てる上限のため、1件はボックスに残しました";

        /// <summary>「あと3日」 (whole days, rounded up) from a real expiry; null when the gift never expires.</summary>
        public static string ExpiryText(GiftEntry e, long nowMs)
        {
            var d = e.DaysLeft(nowMs);
            if (d == null) return null;
            return "あと" + Math.Max(1, d.Value) + "日";
        }

        private string PendingKey(string scope)
        {
            var stored = (Kv.Get(KeyPending) ?? "").Split('|');
            if (stored.Length == 2 && stored[0] == scope) return stored[1];
            string key = B.Api.NewIdempotencyKey();
            Kv.Set(KeyPending, scope + "|" + key);
            return key;
        }

        private void Rebuild()
        {
            Rows = new List<GiftRow>();
            if (Page == null) return;
            long now = _now();
            foreach (var e in Page.Entries)
            {
                bool box = e.Unclaimed;
                Rows.Add(new GiftRow
                {
                    GiftId = e.GiftId, Source = e.Source, Title = e.Title, Status = e.Status, Lines = e.Lines, IsCompensation = e.IsCompensation,
                    ExpiryText = box ? ExpiryText(e, now) : null,
                    ExpiringSoon = box && e.ExpiresAt.HasValue && e.ExpiresAt.Value - now <= 3 * 86_400_000L,
                    StatusText = box ? null : e.Expired ? "期限切れ" : "受け取り済み",
                    HeldText = box && e.HeldReason != null ? (e.HeldReason == "coin_cap" ? "無償コインの持てる上限のため受け取れませんでした" : "アイテムの持てる上限のため受け取れませんでした") : null,
                    RankText = e.Rank.HasValue ? e.Rank.Value + "位" : null,
                    CanClaim = box && !Blocked,
                });
            }
        }
    }
}
