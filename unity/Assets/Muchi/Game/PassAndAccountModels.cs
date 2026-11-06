using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;

namespace Muchi.Game
{
    /// <summary>One level of the pass with its free and premium cells.</summary>
    public sealed class PassLevelRow
    {
        public int Level;
        public Reward Free, Premium;
        public string FreeText, PremiumText;
        public bool FreeClaimed, PremiumClaimed, FreeClaimable, PremiumClaimable;
        /// <summary>Level not reached yet (both cells dim).</summary>
        public bool Locked;
    }

    /// <summary>
    /// REQ-UXU-011 / REQ-UXS-020/021: the season pass drawn only from GET /v1/season-pass — all levels of the free and the
    /// premium line (the premium contents are visible before buying), level and XP ("次まで80XP＝あと4戦"), the real season
    /// end ("11月30日 23:59まで"), no auto-renew, and the levels granted automatically at the last season's close. Claims are
    /// keyed per season/track/level with the key kept until the server answers (まとめて受け取る may be retried safely).
    /// </summary>
    public sealed class SeasonPassModel : ScreenModel
    {
        public const string KeyPendingClaim = "muchi.pass.claim";
        private readonly NowMs _now;
        public SeasonPassModel(GameBackend backend, NowMs now = null) : base(backend, backend?.Store) { _now = now ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()); }

        public SeasonPassView View { get; private set; }

        public async Task LoadAsync(CancellationToken ct = default)
        {
            Message = null; Online = false;
            if (!ServerAvailable) { Offline("シーズンパスはサーバーの値で表示します"); Message = UxText.Offline; return; }
            try { View = await B.Api.GetSeasonPassAsync(ct); Online = true; }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
            catch (ApiException e) { Message = UxText.For(e); }
        }

        /// <summary>Game days left at the device's now (counted like the server between fetches).</summary>
        public int RemainingDays => View == null ? 0 : GameDay.DaysUntil(View.SeasonEndsAt, _now());
        public bool Ended => View != null && RemainingDays <= 0;
        public string EndsLabel => View == null ? null : GameDay.UntilLabel(View.SeasonEndsAt);
        public string PeriodLine => View == null ? null : EndsLabel + (View.AutoRenew ? "" : "・自動更新なし");
        /// <summary>"Lv.11  次まで80XP（あと4戦）" / "Lv.30（最大）".</summary>
        public string XpLine => View == null ? null : View.Level >= View.MaxLevel ? "Lv." + View.Level + "（最大）" : "Lv." + View.Level + "  次まで" + View.XpToNextLevel + "XP（あと" + View.RacesToNextLevel + "戦）";
        public bool Owned => View != null && View.Active;
        /// <summary>The product the "有料ラインを開ける" button buys (null once owned / not on sale).</summary>
        public string PurchaseProductId => View == null || Owned ? null : View.Purchasable.FirstOrDefault();
        public bool CanBuy => PurchaseProductId != null && !Ended && !DeletionGuard.Pending(B) && ServerAvailable;
        /// <summary>"有料ラインを開ける" (not owned) / "まとめて受け取る" (something to claim) / null.</summary>
        public string PrimaryAction => View == null ? null : !Owned && PurchaseProductId != null ? "有料ラインを開ける" : Rows.Any(r => r.FreeClaimable || r.PremiumClaimable) ? "まとめて受け取る" : null;
        /// <summary>The last season's close granted unclaimed levels automatically (REQ-UXS-021).</summary>
        public string LastSeasonNote
        {
            get
            {
                var l = View?.LastSeason;
                if (l == null) return null;
                int n = l.AutoGrantedFree.Length + l.AutoGrantedPremium.Length;
                return n == 0 ? null : "前のシーズンで受け取っていなかった報酬（" + n + "件）を自動で受け取りました";
            }
        }

        private static Reward At(PassLine line, int level) => line != null && line.Every > 0 && level % line.Every == 0 ? line.Reward : null;

        public List<PassLevelRow> Rows
        {
            get
            {
                var rows = new List<PassLevelRow>();
                if (View == null) return rows;
                bool open = !Ended;
                for (int lv = 1; lv <= View.MaxLevel; lv++)
                {
                    var f = At(View.FreeLine, lv);
                    var p = At(View.PremiumLine, lv);
                    bool reached = lv <= View.Level;
                    var r = new PassLevelRow
                    {
                        Level = lv, Free = f, Premium = p, FreeText = f == null ? null : UxText.Reward(f), PremiumText = p == null ? null : UxText.Reward(p),
                        FreeClaimed = View.ClaimedFree.Contains(lv), PremiumClaimed = View.ClaimedPremium.Contains(lv), Locked = !reached,
                    };
                    r.FreeClaimable = open && reached && f != null && !r.FreeClaimed;
                    r.PremiumClaimable = open && reached && p != null && Owned && !r.PremiumClaimed;
                    rows.Add(r);
                }
                return rows;
            }
        }

        public async Task<ActionResult> ClaimAsync(PassTrack track, int level, CancellationToken ct = default)
        {
            var r = await ClaimOneAsync(track, level, ct);
            if (r.Ok) { await LoadAsync(ct); await B.RefreshAsync(ct); }
            return r;
        }

        /// <summary>まとめて受け取る: every claimable cell in level order; stops at the first error without a definite answer (keys are kept).</summary>
        public async Task<ActionResult> ClaimAllAsync(CancellationToken ct = default)
        {
            if (View == null) return ActionResult.Error("読み込み中です");
            int got = 0;
            ActionResult fail = null;
            foreach (var row in Rows)
            {
                if (row.FreeClaimable) { var r = await ClaimOneAsync(PassTrack.Free, row.Level, ct); if (r.Ok) got++; else if (r.Message != UxText.Errors["ALREADY_CLAIMED"]) { fail = r; break; } }
                if (row.PremiumClaimable) { var r = await ClaimOneAsync(PassTrack.Premium, row.Level, ct); if (r.Ok) got++; else if (r.Message != UxText.Errors["ALREADY_CLAIMED"]) { fail = r; break; } }
            }
            await LoadAsync(ct);
            await B.RefreshAsync(ct);
            if (fail != null) return ActionResult.Error(Message = (got > 0 ? got + "件受け取りました。" : "") + fail.Message);
            return ActionResult.Success(Message = got + "件受け取りました");
        }

        private async Task<ActionResult> ClaimOneAsync(PassTrack track, int level, CancellationToken ct)
        {
            if (!ServerAvailable) return Offline("受け取りにはサーバーが必要です");
            if (Ended) return ActionResult.Error("シーズンは終了しました。未受取の報酬は自動で付与されます");
            string slot = KeyPendingClaim + ":" + View?.SeasonId + ":" + (track == PassTrack.Premium ? "p" : "f") + ":" + level;
            string key = Kv.Get(slot);
            if (string.IsNullOrEmpty(key)) { key = B.Api.NewIdempotencyKey(); Kv.Set(slot, key); }
            try
            {
                var reward = await B.Api.ClaimSeasonPassAsync(track, level, key, ct);
                Kv.Set(slot, "");
                return ActionResult.Success(UxText.Reward(reward));
            }
            catch (ApiException e)
            {
                if (!GameBackend.IsTransient(e)) Kv.Set(slot, "");
                return ActionResult.Error(UxText.For(e));
            }
        }
    }

    public enum DeletionStage { None, Confirming, Scheduled, Offline }

    /// <summary>
    /// REQ-UXU-012 / REQ-UXS-040 account deletion: ① explanation → ② step 1 (what is given up + the notice, "放棄して削除を予約")
    /// → ③ step 2 with the short-lived token (expired or DELETION_CONFIRM_INVALID → back to ①) → ④ scheduled: "12月9日に削除されます"
    /// with 取り消す. Step 1 and the cancel are never retried automatically (each step-1 call issues a new token; a second cancel
    /// is NOT_FOUND). While scheduled, <see cref="DeletionGuard"/> blocks purchases everywhere.
    /// </summary>
    public sealed class AccountDeletionModel : ScreenModel
    {
        private readonly NowMs _now;
        public AccountDeletionModel(GameBackend backend, NowMs now = null) : base(backend, backend?.Store)
        {
            _now = now ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            Stage = DeletionGuard.Pending(backend) ? DeletionStage.Scheduled : DeletionStage.None;
            DeleteAt = backend?.Player?.Deletion?.DeleteAt;
        }

        public DeletionStage Stage { get; private set; }
        public DeletionRequest Request { get; private set; }
        public long? DeleteAt { get; private set; }
        public bool Busy { get; private set; }
        public const string Explanation = "アカウントを削除すると、相棒・馬・コイン・アイテムがすべて失われ、元に戻せません。削除の予約から14日間は取り消せます。";

        /// <summary>What is given up, one line each (step 2 shows these before the final button).</summary>
        public List<string> ForfeitLines
        {
            get
            {
                var f = Request?.Forfeit;
                var l = new List<string>();
                if (f == null) return l;
                l.Add("有償コイン" + f.PaidCoins.ToString("N0", CultureInfo.InvariantCulture) + "枚");
                l.Add("無償コイン" + f.FreeCoins.ToString("N0", CultureInfo.InvariantCulture) + "枚");
                l.Add("馬" + f.Horses + "頭");
                l.Add("アイテム" + f.Items + "個");
                if (f.AllowanceDays > 0) l.Add("厩舎手当の残り" + f.AllowanceDays + "日分");
                if (f.SeasonPass) l.Add("今シーズンのシーズンパス");
                return l;
            }
        }

        public string Notice => Request?.Notice;
        /// <summary>"12月9日に削除されます（それまでは取り消せます）".</summary>
        public string ScheduledLine => Stage == DeletionStage.Scheduled && DeleteAt.HasValue ? DeletionGuard.JstDate(DeleteAt.Value) + "に削除されます（それまでは取り消せます）" : null;
        /// <summary>Step 2's token is still valid at the device's now.</summary>
        public bool TokenValid => Request?.ConfirmToken != null && (!Request.ExpiresAt.HasValue || _now() < Request.ExpiresAt.Value);

        /// <summary>Step 1 (DELETE /v1/player without a token).</summary>
        public async Task<ActionResult> RequestAsync(CancellationToken ct = default)
        {
            Message = null;
            if (!ServerAvailable) { Stage = DeletionStage.Offline; return Offline("アカウント削除にはサーバーが必要です"); }
            Busy = true;
            try
            {
                Request = await B.Api.RequestAccountDeletionAsync(ct);
                if (Request.Scheduled) { Schedule(Request.RequestedAt, Request.DeleteAt); return ActionResult.Success(ScheduledLine); }
                Stage = DeletionStage.Confirming;
                return ActionResult.Success();
            }
            catch (ApiException e) { return ActionResult.Error(Message = UxText.For(e)); }
            finally { Busy = false; }
        }

        /// <summary>Step 2 (放棄して削除を予約).</summary>
        public async Task<ActionResult> ConfirmAsync(CancellationToken ct = default)
        {
            Message = null;
            if (Stage != DeletionStage.Confirming || Request == null) return ActionResult.Error("はじめからお進みください");
            if (!TokenValid) { Restart(); return ActionResult.Error(Message = UxText.Errors["DELETION_CONFIRM_INVALID"]); }
            Busy = true;
            try
            {
                var r = await B.Api.ConfirmAccountDeletionAsync(Request.ConfirmToken, ct);
                Schedule(r.RequestedAt, r.DeleteAt);
                return ActionResult.Success(ScheduledLine);
            }
            catch (ConflictException e) when (e.Code == ApiErrorCode.DeletionConfirmInvalid) { Restart(); return ActionResult.Error(Message = UxText.For(e)); }
            catch (ApiException e) { return ActionResult.Error(Message = UxText.For(e)); } // token kept: the same step 2 may be sent again
            finally { Busy = false; }
        }

        /// <summary>Back out of the flow before step 2 (nothing is scheduled; the token just expires).</summary>
        public void Restart() { Request = null; if (Stage == DeletionStage.Confirming) Stage = DeletionStage.None; }

        /// <summary>取り消す (within the window).</summary>
        public async Task<ActionResult> CancelAsync(CancellationToken ct = default)
        {
            Message = null;
            if (Stage != DeletionStage.Scheduled) return ActionResult.Error("削除の予約はありません");
            if (!ServerAvailable) return Offline("取り消しにはサーバーが必要です");
            Busy = true;
            try
            {
                var s = await B.Api.CancelAccountDeletionAsync(ct);
                Unschedule(s);
                return ActionResult.Success(Message = "アカウント削除を取り消しました");
            }
            catch (NotFoundException) { Unschedule(new DeletionStatus()); return ActionResult.Success(Message = "アカウント削除を取り消しました"); }
            catch (ConflictException) { return ActionResult.Error(Message = "削除が始まっています"); }
            catch (ApiException e) { await B.RefreshAsync(ct); if (!DeletionGuard.Pending(B)) Unschedule(new DeletionStatus()); return ActionResult.Error(Message = UxText.For(e)); }
            finally { Busy = false; }
        }

        private void Schedule(long? requestedAt, long? deleteAt)
        {
            Stage = DeletionStage.Scheduled; DeleteAt = deleteAt; Request = null;
            if (B.Player != null) B.Player.Deletion = new DeletionStatus { Status = "scheduled", RequestedAt = requestedAt, DeleteAt = deleteAt };
        }

        private void Unschedule(DeletionStatus s)
        {
            Stage = DeletionStage.None; DeleteAt = null;
            if (B.Player != null) B.Player.Deletion = s ?? new DeletionStatus();
        }
    }
}
