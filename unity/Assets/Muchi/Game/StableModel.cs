using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;

namespace Muchi.Game
{
    /// <summary>What a stable panel shows: a spinner, the room, an "not open yet" card, an error with retry, or the offline notice.</summary>
    public enum StableLoad { Idle, Loading, Ready, Empty, Error, Offline }

    /// <summary>
    /// マイ厩舎 screen (docs/planning/06 §7.2, REQ-STABLE-*): edit my room (theme, 表札, decor slots, featured horses) with the
    /// same rules the server applies, visit friends' and recommended stables, and like them. Likes are capped per day and per
    /// stable and never give coins to anyone (<see cref="NoCoinsNote"/>). The idempotency key of a like is kept on the device
    /// until the server answers definitely, so a retry after a timeout never counts twice.
    /// </summary>
    public sealed class StableModel : ScreenModel
    {
        public const string KeyPendingLike = "muchi.stable.like";
        public const string NoCoinsNote = "いいねにコインは付きません。累計いいねで厩舎のテーマが解放されます。";
        public const string LikeLimitCode = "LIKE_LIMIT";
        public const string AlreadyLikedCode = "ALREADY_LIKED";

        // ---- my stable
        public StableLoad State { get; private set; } = StableLoad.Idle;
        public MyStable Mine { get; private set; }
        /// <summary>The layout being edited (a copy of <see cref="MyStable.Layout"/> until saved).</summary>
        public StableLayout Draft { get; private set; } = new StableLayout();
        public bool Dirty { get; private set; }

        // ---- visiting
        public StableLoad VisitsState { get; private set; } = StableLoad.Idle;
        public StableVisits Visits { get; private set; } = new StableVisits();
        public StableLoad VisitState { get; private set; } = StableLoad.Idle;
        public string VisitingId { get; private set; }
        public StableVisit Visiting { get; private set; }

        public StableModel(GameBackend backend, IKeyValueStore store) : base(backend, store) { }

        public StableTheme Theme => Mine?.Themes.FirstOrDefault(t => t.Id == Draft.Theme);
        public int SlotCount => Theme?.Slots ?? 3;
        public int FeaturedMax => Mine?.FeaturedMax ?? 3;
        public int NameMaxChars => Mine?.NameMaxChars > 0 ? Mine.NameMaxChars : 12;
        /// <summary>Owned decor not placed yet (the palette next to the room).</summary>
        public List<StableDecor> Palette => (Mine?.Decor ?? new List<StableDecor>()).Where(d => d.Owned && !Draft.Slots.Contains(d.ItemId)).ToList();
        /// <summary>Decor I do not own (links to the cosmetics shop; buying is a direct sale, no odds).</summary>
        public List<StableDecor> ShopDecor => (Mine?.Decor ?? new List<StableDecor>()).Where(d => !d.Owned).ToList();
        /// <summary>Active horses that can stand in the 馬房.</summary>
        public List<Horse> HorseChoices => (B.Player?.Horses ?? new List<Horse>()).Where(h => !h.IsRetired).ToList();
        public string PlateName => string.IsNullOrEmpty(Draft.Name) ? (B.Player?.DisplayName ?? "") + "の厩舎" : Draft.Name;
        public bool CanSave => ServerAvailable && Mine != null && Dirty && Validate().Count == 0;
        /// <summary>"いいね 12（今日あと4回）".</summary>
        public string LikesLine => Mine == null ? "" : "いいね " + Mine.Likes.Received + "（今日あと" + Math.Max(0, Mine.Likes.PerDay - Mine.Likes.GivenToday) + "回）";

        // ------------------------------------------------------------------------------- my stable

        public async Task LoadAsync(CancellationToken ct = default)
        {
            Message = null; Online = false;
            if (!ServerAvailable) { State = StableLoad.Offline; Offline("マイ厩舎はサーバーに保存されます"); return; }
            State = StableLoad.Loading;
            try
            {
                Mine = await B.Api.GetMyStableAsync(ct);
                Draft = Mine.Layout.Clone();
                while (Draft.Slots.Count < SlotCount) Draft.Slots.Add(null);
                Dirty = false; Online = true;
                // never saved: the room shows the equipped decor, but nobody can visit until the first save
                State = Mine.Saved ? StableLoad.Ready : StableLoad.Empty;
                if (!Mine.Saved) Message = "飾りを置いて保存すると、フレンドが見に来られます";
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
            catch (ApiException e) { State = StableLoad.Error; Fail(e); }
        }

        /// <summary>Switch theme; decor beyond the new theme's slot count goes back to the palette.</summary>
        public ActionResult SelectTheme(string themeId)
        {
            var t = Mine?.Themes.FirstOrDefault(x => x.Id == themeId);
            if (t == null) return ActionResult.Error("テーマが見つかりません");
            if (!t.Unlocked) return ActionResult.Error(LockedLabel(t));
            Draft.Theme = t.Id;
            if (Draft.Slots.Count > t.Slots) Draft.Slots.RemoveRange(t.Slots, Draft.Slots.Count - t.Slots);
            while (Draft.Slots.Count < t.Slots) Draft.Slots.Add(null);
            Dirty = true;
            return ActionResult.Success();
        }

        public static string LockedLabel(StableTheme t) => t.UnlockLikes.HasValue ? "いいね " + t.UnlockLikes.Value + " で解放" : t.UnlockItem != null ? "アイテムで解放" : "未解放";

        /// <summary>Put an owned decor item into a slot (dragging it from another slot moves it; the slot's previous item swaps back).</summary>
        public ActionResult Place(int slot, string itemId)
        {
            if (slot < 0 || slot >= SlotCount) return ActionResult.Error("その枠はありません");
            var d = Mine?.Decor.FirstOrDefault(x => x.ItemId == itemId);
            if (d == null) return ActionResult.Error("厩舎の飾りではありません");
            if (!d.Owned) return ActionResult.Error("持っていない飾りは置けません（ショップで購入できます）");
            while (Draft.Slots.Count < SlotCount) Draft.Slots.Add(null);
            int from = Draft.Slots.IndexOf(itemId);
            var previous = Draft.Slots[slot];
            Draft.Slots[slot] = itemId;
            if (from >= 0 && from != slot) Draft.Slots[from] = previous;
            Dirty = true;
            return ActionResult.Success();
        }

        public void ClearSlot(int slot)
        {
            if (slot < 0 || slot >= Draft.Slots.Count) return;
            Draft.Slots[slot] = null; Dirty = true;
        }

        /// <summary>表札 (null or blank = "&lt;表示名&gt;の厩舎").</summary>
        public void SetName(string name) { Draft.Name = string.IsNullOrWhiteSpace(name) ? null : name.Trim(); Dirty = true; }

        public ActionResult ToggleFeatured(string horseId)
        {
            if (Draft.FeaturedHorseIds.Remove(horseId)) { Dirty = true; return ActionResult.Success(); }
            if (Draft.FeaturedHorseIds.Count >= FeaturedMax) return ActionResult.Error("馬房に立てるのは" + FeaturedMax + "頭までです");
            if (!HorseChoices.Any(h => h.Id == horseId)) return ActionResult.Error("現役の自分の馬だけ選べます");
            Draft.FeaturedHorseIds.Add(horseId); Dirty = true;
            return ActionResult.Success();
        }

        /// <summary>The server's rules (REQ-STABLE-002), checked before sending so the screen can point at the problem.</summary>
        public List<string> Validate()
        {
            var p = new List<string>();
            if (Mine == null) { p.Add("読み込み中です"); return p; }
            var t = Theme;
            if (t == null) p.Add("テーマが見つかりません");
            else if (!t.Unlocked) p.Add("このテーマはまだ使えません（" + LockedLabel(t) + "）");
            var placed = Draft.Slots.Where(x => x != null).ToList();
            if (t != null && Draft.Slots.Count > t.Slots && Draft.Slots.Skip(t.Slots).Any(x => x != null)) p.Add("飾り枠は" + t.Slots + "つまでです");
            foreach (var id in placed)
            {
                var d = Mine.Decor.FirstOrDefault(x => x.ItemId == id);
                if (d == null) p.Add(id + " は厩舎の飾りではありません");
                else if (!d.Owned) p.Add(d.Name + " を持っていません");
            }
            if (placed.Count != placed.Distinct().Count()) p.Add("同じ飾りは1つしか置けません");
            if (Draft.FeaturedHorseIds.Count > FeaturedMax) p.Add("馬房に立てるのは" + FeaturedMax + "頭までです");
            if (Draft.FeaturedHorseIds.Count != Draft.FeaturedHorseIds.Distinct().Count()) p.Add("同じ馬を2回選んでいます");
            var active = new HashSet<string>(HorseChoices.Select(h => h.Id));
            if (Draft.FeaturedHorseIds.Any(id => !active.Contains(id))) p.Add("現役の自分の馬だけ選べます");
            if (Draft.Name != null)
            {
                int len = new System.Globalization.StringInfo(Draft.Name.Normalize(System.Text.NormalizationForm.FormKC)).LengthInTextElements;
                if (len < 1 || len > NameMaxChars) p.Add("表札は1〜" + NameMaxChars + "文字です");
                if (Draft.Name.IndexOf("http", StringComparison.OrdinalIgnoreCase) >= 0 || Draft.Name.IndexOf("www.", StringComparison.OrdinalIgnoreCase) >= 0) p.Add("表札にURLは使えません");
            }
            return p;
        }

        /// <summary>Save the draft (trailing empty slots are trimmed; the server keeps the theme's slot count).</summary>
        public async Task<ActionResult> SaveAsync(CancellationToken ct = default)
        {
            if (!ServerAvailable) return Offline("マイ厩舎はサーバーに保存されます");
            var problems = Validate();
            if (problems.Count > 0) return ActionResult.Error(Message = problems[0]);
            var body = Draft.Clone();
            while (body.Slots.Count > 0 && body.Slots[body.Slots.Count - 1] == null) body.Slots.RemoveAt(body.Slots.Count - 1);
            try
            {
                var r = await B.Api.SaveStableAsync(body, ct);
                Mine.Layout = r.Layout; Mine.Preview = r.Snapshot; Mine.Saved = true;
                Draft = r.Layout.Clone();
                while (Draft.Slots.Count < SlotCount) Draft.Slots.Add(null);
                Dirty = false; State = StableLoad.Ready;
                return ActionResult.Success(Message = "厩舎を保存しました");
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
            catch (ApiException e) { return Fail(e); }
        }

        public void DiscardChanges()
        {
            if (Mine == null) return;
            Draft = Mine.Layout.Clone();
            while (Draft.Slots.Count < SlotCount) Draft.Slots.Add(null);
            Dirty = false;
        }

        // ------------------------------------------------------------------------------- visiting

        /// <summary>Friends' stables and recommended ones. Empty = nobody to visit yet.</summary>
        public async Task LoadVisitsAsync(CancellationToken ct = default)
        {
            if (!ServerAvailable) { VisitsState = StableLoad.Offline; Offline("訪問はオンラインのときだけです"); return; }
            VisitsState = StableLoad.Loading;
            try
            {
                Visits = await B.Api.GetStableVisitsAsync(ct);
                VisitsState = Visits.Friends.Count + Visits.Recommended.Count == 0 ? StableLoad.Empty : StableLoad.Ready;
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
            catch (ApiException e) { VisitsState = StableLoad.Error; Fail(e); }
        }

        /// <summary>Open someone's stable (the public copy). Empty = not open yet (never saved, or suspended).</summary>
        public async Task VisitAsync(string playerId, CancellationToken ct = default)
        {
            VisitingId = playerId; Visiting = null;
            if (!ServerAvailable) { VisitState = StableLoad.Offline; Offline("訪問はオンラインのときだけです"); return; }
            VisitState = StableLoad.Loading;
            try
            {
                Visiting = await B.Api.GetStableAsync(playerId, ct);
                VisitState = StableLoad.Ready;
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
            catch (NotFoundException) { VisitState = StableLoad.Empty; Message = "この厩舎はまだ公開されていません"; }
            catch (ApiException e) { VisitState = StableLoad.Error; Fail(e); }
        }

        public bool CanLike => ServerAvailable && VisitState == StableLoad.Ready && Visiting?.Viewer != null && Visiting.Viewer.CanLike;

        /// <summary>Like the stable being visited (capped per day and per stable; no coins).</summary>
        public async Task<ActionResult> LikeAsync(CancellationToken ct = default)
        {
            if (!ServerAvailable) return Offline("いいねはオンラインのときだけです");
            if (Visiting?.Stable == null) return ActionResult.Error("厩舎を開いてください");
            var v = Visiting.Viewer;
            if (v.Relation == "self") return ActionResult.Error(Message = "自分の厩舎にはいいねできません");
            if (!v.CanLike) return ActionResult.Error(Message = v.LikesLeftToday <= 0 ? "今日のいいねは使い切りました" : "この厩舎には今日いいね済みです");
            string target = Visiting.Stable.PlayerId;
            string slot = KeyPendingLike + ":" + target;
            string key = Kv.Get(slot);
            if (string.IsNullOrEmpty(key)) { key = B.Api.NewIdempotencyKey(); Kv.Set(slot, key); }
            try
            {
                var r = await B.Api.LikeStableAsync(target, key, ct);
                Kv.Set(slot, null);
                Visiting.Stable.Likes = r.Likes;
                v.LikedToday += 1; v.LikesLeftToday = r.RemainingToday; v.CanLike = false;
                if (Mine != null) Mine.Likes.GivenToday = Mine.Likes.PerDay - r.RemainingToday;
                var row = Visits.Friends.Concat(Visits.Recommended).FirstOrDefault(x => x.PlayerId == target);
                if (row != null) row.Likes = r.Likes;
                return ActionResult.Success(Message = "いいねしました（今日あと" + r.RemainingToday + "回）");
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
            catch (ApiException e)
            {
                if (ItemsBackend.IsDefiniteRejection(e)) Kv.Set(slot, null);
                if (e.WireCode == LikeLimitCode) { v.LikesLeftToday = 0; v.CanLike = false; return ActionResult.Error(Message = "今日のいいねは使い切りました"); }
                if (e.WireCode == AlreadyLikedCode) { v.CanLike = false; return ActionResult.Error(Message = "この厩舎には今日いいね済みです"); }
                if (e is NotFoundException) { VisitState = StableLoad.Empty; return ActionResult.Error(Message = "この厩舎はまだ公開されていません"); }
                return Fail(e);
            }
        }
    }
}
