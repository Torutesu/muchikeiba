using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;

namespace Muchi.Game
{
    /// <summary>One button of the stamp palette (locked stamps are shown with the server's lock text, never hidden).</summary>
    public sealed class StampButton
    {
        public string Id, Label, Asset;
        public bool Unlocked;
        /// <summary>"レースに10回出走で解放" / "見た目ショップで購入（200コイン）" while locked; null when unlocked.</summary>
        public string LockText;
        /// <summary>cosmetic unlock: the item to open in the 見た目 shop (direct sale) — null otherwise.</summary>
        public string ShopItemId;
    }

    /// <summary>A feed row as the screen draws it (texts built here, never by the view).</summary>
    public sealed class FeedRow
    {
        public long Seq;
        public bool IsRace, Mine;
        public string PlayerId, Name;
        /// <summary>Stamp rows: the stamp's label and asset (stamp/&lt;id&gt;). Race rows: null asset.</summary>
        public string StampLabel, StampAsset;
        /// <summary>"アオバさんがランク戦で1着！" / "アオバ：「がんばれ！」".</summary>
        public string Line;
        /// <summary>"2分前" / "11月25日".</summary>
        public string When;
        public List<FeedReactionCount> Reactions = new List<FeedReactionCount>();
        public string MyReaction;
        /// <summary>Race rows of teammates can be cheered; own rows and stamp rows only show reactions.</summary>
        public bool CanCheer;
    }

    /// <summary>
    /// REQ-TEAMFEED-*: the 支部 feed screen (pure C#, no UnityEngine). Fixed stamps only — there is no text field anywhere.
    /// - Palette: every stamp of the set; locked ones carry the server's unlock text (play / pass / direct-sale cosmetic).
    /// - Post: one stamp per <see cref="StampCatalog.PostIntervalMs"/> (the button shows the local cooldown; the server is the
    ///   authority and its RATE_LIMITED is shown as a sentence), disabled while the account deletion is scheduled.
    /// - Cheer: one reaction per race row of a teammate (tap the same stamp again to take it back).
    /// - Mute (block): applied locally at once and kept on the device, then stored on the server; a failed server call is
    ///   retried on the next load, so a mute never "comes back".
    /// - Report: the row disappears locally at once; the server flags it for support.
    /// - Paging: newest first, <see cref="LoadOlderAsync"/> with the server's nextBefore.
    /// KPI stamp_post / team_feed_view are written by the server (no client events).
    /// </summary>
    public sealed class TeamFeedModel : ScreenModel
    {
        public const string KeyMuted = "muchi.teamfeed.muted";
        public const string KeyMutePending = "muchi.teamfeed.mute_pending";
        public const string KeyReported = "muchi.teamfeed.reported";
        public const int MaxItems = 100;

        private readonly NowMs _now;
        private long _lastPostAt = long.MinValue / 2;
        private readonly List<FeedItem> _items = new List<FeedItem>();

        public TeamFeedModel(GameBackend backend, NowMs now = null) : base(backend, backend?.Store)
        {
            _now = now ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        }

        public StampCatalog Catalog { get; private set; }
        public string TeamId { get; private set; }
        public bool InTeam => TeamId != null;
        public long? NextBefore { get; private set; }
        public bool HasOlder => NextBefore.HasValue;
        public bool Loading { get; private set; }

        public bool DeletionPending => DeletionGuard.Pending(B);
        public string DeletionBanner => DeletionGuard.Banner(B);

        // ------------------------------------------------------------------ local lists

        private HashSet<string> Read(string key) => new HashSet<string>((Kv.Get(key) ?? "").Split(',').Where(x => x.Length > 0));
        private void Write(string key, IEnumerable<string> v) => Kv.Set(key, string.Join(",", v.Distinct()));

        /// <summary>Members I muted (device copy; the server copy is merged in on load).</summary>
        public IReadOnlyCollection<string> Muted => Read(KeyMuted);
        public bool IsMuted(string playerId) => Read(KeyMuted).Contains(playerId);

        // ------------------------------------------------------------------ view data

        public List<StampButton> Palette => Catalog == null ? new List<StampButton>() : Catalog.Stamps.Select(s => new StampButton
        {
            Id = s.Id, Label = s.Label, Asset = s.Asset ?? AssetKeys.Stamp(s.Id), Unlocked = s.Unlocked,
            LockText = s.Unlocked ? null : s.UnlockText, ShopItemId = !s.Unlocked && s.UnlockKind == "cosmetic" ? s.UnlockItemId : null,
        }).ToList();

        private string LabelOf(string stampId) => Catalog?.Stamps.FirstOrDefault(s => s.Id == stampId)?.Label ?? stampId;

        /// <summary>Rows to draw, newest first, without muted members, reported rows, or reactions of muted members.</summary>
        public List<FeedRow> Rows
        {
            get
            {
                var muted = Read(KeyMuted);
                var reported = Read(KeyReported);
                return _items.Where(x => !muted.Contains(x.PlayerId) && !reported.Contains(TeamId + ":" + x.Seq.ToString(CultureInfo.InvariantCulture)))
                    .Select(x => new FeedRow
                    {
                        Seq = x.Seq, IsRace = x.IsRace, Mine = x.Mine, PlayerId = x.PlayerId, Name = x.DisplayName,
                        StampLabel = x.StampId != null ? LabelOf(x.StampId) : null, StampAsset = x.StampAsset ?? (x.StampId != null ? AssetKeys.Stamp(x.StampId) : null),
                        Line = LineOf(x), When = WhenText(x.At, _now()),
                        Reactions = x.Reactions, MyReaction = x.MyReaction, CanCheer = x.IsRace && !x.Mine,
                    }).ToList();
            }
        }

        public string LineOf(FeedItem x)
        {
            if (x.IsRace && x.Race != null)
            {
                string where = x.Race.Mode == "tournament" ? "大会" : "ランク戦";
                string what = x.Race.Place == 1 ? "1着！" : x.Race.Place.ToString(CultureInfo.InvariantCulture) + "着";
                return x.DisplayName + "さんが" + where + "で" + what;
            }
            return x.DisplayName + "：「" + LabelOf(x.StampId) + "」";
        }

        /// <summary>"たった今" / "5分前" / "3時間前" / "11月25日" (JST).</summary>
        public static string WhenText(long at, long now)
        {
            long d = Math.Max(0, now - at);
            if (d < 60_000) return "たった今";
            if (d < 3_600_000) return (d / 60_000).ToString(CultureInfo.InvariantCulture) + "分前";
            if (d < 86_400_000) return (d / 3_600_000).ToString(CultureInfo.InvariantCulture) + "時間前";
            return DeletionGuard.JstDate(at);
        }

        /// <summary>Milliseconds until the next post is allowed (local view of the server's 10 s rule).</summary>
        public long CooldownMs => Catalog == null ? 0 : Math.Max(0, _lastPostAt + Catalog.PostIntervalMs - _now());

        /// <summary>Why the palette is disabled now (null = posting is possible).</summary>
        public string PostDisabledReason => !ServerAvailable ? UxText.Offline : !InTeam ? "支部に入ると応援スタンプを送れます" : DeletionPending ? DeletionBanner
            : CooldownMs > 0 ? "あと" + ((CooldownMs + 999) / 1000).ToString(CultureInfo.InvariantCulture) + "秒で送れます" : null;

        public bool CanPost(StampButton s) => s != null && s.Unlocked && PostDisabledReason == null;

        // ------------------------------------------------------------------ load

        public async Task LoadAsync(CancellationToken ct = default)
        {
            Message = null; Online = false;
            if (!ServerAvailable) { Message = UxText.Offline; return; }
            Loading = true;
            try
            {
                Catalog = await B.Api.GetStampsAsync(ct);
                await FlushMutesAsync(ct);
                FeedPage page;
                try { page = await B.Api.GetTeamFeedAsync(null, null, ct); }
                catch (NotFoundException e) when (e.Code == ApiErrorCode.NotInTeam) { TeamId = null; _items.Clear(); NextBefore = null; Online = true; return; }
                TeamId = page.TeamId;
                _items.Clear();
                _items.AddRange(page.Items);
                NextBefore = page.NextBefore;
                // the server copy of the mute list joins the device copy (a mute made on another device applies here too)
                Write(KeyMuted, Read(KeyMuted).Union(page.Muted));
                Online = true;
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
            catch (ApiException e) { Message = UxText.For(e); }
            finally { Loading = false; }
        }

        public async Task<ActionResult> LoadOlderAsync(CancellationToken ct = default)
        {
            if (!ServerAvailable) return Offline("feed");
            if (!NextBefore.HasValue) return ActionResult.Success();
            try
            {
                var page = await B.Api.GetTeamFeedAsync(NextBefore, null, ct);
                foreach (var x in page.Items) if (_items.All(y => y.Seq != x.Seq)) _items.Add(x);
                _items.Sort((a, b) => b.Seq.CompareTo(a.Seq));
                if (_items.Count > MaxItems) _items.RemoveRange(MaxItems, _items.Count - MaxItems);
                NextBefore = page.NextBefore;
                return ActionResult.Success();
            }
            catch (ApiException e) { Message = UxText.For(e); return ActionResult.Error(Message); }
        }

        // ------------------------------------------------------------------ actions

        public async Task<ActionResult> PostAsync(string stampId, CancellationToken ct = default)
        {
            var s = Palette.FirstOrDefault(x => x.Id == stampId);
            if (s == null) return ActionResult.Error("unknown stamp");
            if (!s.Unlocked) return ActionResult.Error(Message = s.LockText);
            var why = PostDisabledReason;
            if (why != null) return ActionResult.Error(Message = why);
            _lastPostAt = _now(); // the cooldown starts now even if the call fails (no double taps)
            try
            {
                var r = await B.Api.PostStampAsync(stampId, ct);
                _items.Insert(0, new FeedItem { Seq = r.Seq, At = r.At, Kind = "stamp", PlayerId = B.Player?.Id, DisplayName = B.Player?.DisplayName ?? "", Mine = true, StampId = stampId, StampAsset = AssetKeys.Stamp(stampId) });
                if (_items.Count > MaxItems) _items.RemoveAt(_items.Count - 1);
                Message = null;
                return ActionResult.Success();
            }
            catch (RateLimitedException) { Message = "スタンプは10秒に1回、1日50回までです。"; return ActionResult.Error(Message); }
            catch (ApiException e) when (e.Code == ApiErrorCode.StampLocked) { Message = s.LockText ?? e.Message; return ActionResult.Error(Message); }
            catch (ApiException e) { Message = UxText.For(e); return ActionResult.Error(Message); }
        }

        /// <summary>Cheer a teammate's race row with a stamp; the same stamp again takes it back.</summary>
        public async Task<ActionResult> CheerAsync(long seq, string stampId, CancellationToken ct = default)
        {
            var it = _items.FirstOrDefault(x => x.Seq == seq);
            if (it == null || !it.IsRace || it.Mine) return ActionResult.Error("not a teammate's race result");
            if (!ServerAvailable) return Offline("feed");
            if (DeletionPending) return ActionResult.Error(Message = DeletionBanner);
            var s = Palette.FirstOrDefault(x => x.Id == stampId);
            if (s == null || !s.Unlocked) return ActionResult.Error(Message = s?.LockText ?? "unknown stamp");
            string next = it.MyReaction == stampId ? null : stampId;
            try
            {
                var mine = await B.Api.ReactToFeedItemAsync(seq, next, ct);
                Apply(it, mine);
                return ActionResult.Success();
            }
            catch (RateLimitedException) { Message = "少し待ってから応援してください。"; return ActionResult.Error(Message); }
            catch (ApiException e) { Message = UxText.For(e); return ActionResult.Error(Message); }
        }

        private static void Apply(FeedItem it, string mine)
        {
            if (it.MyReaction != null)
            {
                var old = it.Reactions.FirstOrDefault(r => r.StampId == it.MyReaction);
                if (old != null) { old.Count--; old.Mine = false; if (old.Count <= 0) it.Reactions.Remove(old); }
            }
            if (mine != null)
            {
                var c = it.Reactions.FirstOrDefault(r => r.StampId == mine);
                if (c == null) it.Reactions.Add(c = new FeedReactionCount { StampId = mine });
                c.Count++; c.Mine = true;
            }
            it.MyReaction = mine;
        }

        /// <summary>Mute (block) or unmute a member: local at once, then the server (retried on the next load if it fails).</summary>
        public async Task<ActionResult> SetMutedAsync(string playerId, bool muted, CancellationToken ct = default)
        {
            if (string.IsNullOrEmpty(playerId) || playerId == B.Player?.Id) return ActionResult.Error("cannot mute yourself");
            var set = Read(KeyMuted);
            if (muted) set.Add(playerId); else set.Remove(playerId);
            Write(KeyMuted, set);
            var pending = Read(KeyMutePending);
            pending.RemoveWhere(x => x.Substring(1) == playerId);
            pending.Add((muted ? "+" : "-") + playerId);
            Write(KeyMutePending, pending);
            await FlushMutesAsync(ct);
            return ActionResult.Success(muted ? "この支部員のスタンプを表示しません" : "表示を戻しました");
        }

        private async Task FlushMutesAsync(CancellationToken ct)
        {
            if (!ServerAvailable) return;
            foreach (var p in Read(KeyMutePending).ToList())
            {
                try
                {
                    await B.Api.SetFeedMuteAsync(p.Substring(1), p[0] == '+', ct);
                    var left = Read(KeyMutePending); left.Remove(p); Write(KeyMutePending, left);
                }
                catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
                catch (ApiException) { /* kept for the next load; the local mute already applies */ }
            }
        }

        /// <summary>Report a row: hidden locally at once, flagged for support on the server.</summary>
        public async Task<ActionResult> ReportAsync(long seq, FeedReportReason reason, CancellationToken ct = default)
        {
            var it = _items.FirstOrDefault(x => x.Seq == seq);
            if (it == null || it.Mine) return ActionResult.Error("cannot report this row");
            var rep = Read(KeyReported);
            rep.Add(TeamId + ":" + seq.ToString(CultureInfo.InvariantCulture));
            Write(KeyReported, rep.Skip(Math.Max(0, rep.Count - 200)));
            if (!ServerAvailable) return Offline("report");
            try { await B.Api.ReportFeedItemAsync(seq, reason, ct); return ActionResult.Success("報告しました。ご協力ありがとうございます"); }
            catch (ApiException e) { Message = UxText.For(e); return ActionResult.Error(Message); }
        }
    }
}
