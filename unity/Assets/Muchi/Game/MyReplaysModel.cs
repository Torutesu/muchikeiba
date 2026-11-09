using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;

namespace Muchi.Game
{
    // REQ-MYRP-001..016 (contracts/protocol.md §37, docs/handoff-codex-round14-my-replays.md): マイリプレイ, the game layer.
    // Pure C#: Codex's list, rename sheet and player screen bind to the public fields. The server keeps the list and the
    // logs; the device re-simulates (ReplayPlayer) and never plays a different race. Titles are what the player typed:
    // shown as they are in every language (never through Loc.T).

    /// <summary>One card of the list (saved replay, best moment or recent race).</summary>
    public sealed class ReplayCard
    {
        public string RaceId;
        /// <summary>The player's title as typed, or 「きらめき 芝2000m 1着」 when there is none (then <see cref="TitleIsTyped"/> is false).</summary>
        public string Title;
        public bool TitleIsTyped;
        /// <summary>「1着 / 12頭」.</summary>
        public string ResultText;
        public string CourseText;
        /// <summary>「12/8」 (JST, the race day).</summary>
        public string DateText;
        /// <summary>「勝利」「写真判定」「自己ベスト」 or null.</summary>
        public string MomentText;
        public string Moment;
        public int Place;
        public bool Saved, Favorite, Public, Playable;
        /// <summary>Why it cannot be played (null when it can).</summary>
        public string UnplayableText;
        /// <summary>Moments / recent races: 「12/30まで保存できます」 (the real date; never a countdown pitch).</summary>
        public string KeepUntilText;
    }

    /// <summary>
    /// マイリプレイ: the list (saved first — favourites on top — then best moments and recent races that can still be saved),
    /// the rename sheet, favourite / public toggles, delete, and opening the player. Rules the model keeps for the screens:
    ///  - saving is free up to the server's limit; nothing here is sold, there is no shop link;
    ///  - a replay that cannot be played (retired ruleset, another engine build, a broken log) says 「再生できません」 and is
    ///    never played; it stays in the list and can be deleted;
    ///  - titles are moderated by the server (NG words) and never translated; other players appear only as horse names.
    /// KPI: replay_share when a replay is handed to the OS share sheet (<see cref="Shared"/>); replay_save / replay_view are server events.
    /// </summary>
    public sealed class MyReplaysModel : ScreenModel
    {
        public const string TextUnplayable = "このリプレイは再生できません";
        public static readonly IReadOnlyDictionary<string, string> UnplayableTexts = new Dictionary<string, string>
        {
            [ReplayUnplayable.RulesetRetired] = "古いルールのレースのため、再生できません",
            [ReplayUnplayable.RulesetUnknown] = "このアプリのバージョンでは再生できません。アプリを更新してください",
            [ReplayUnplayable.HashMismatch] = "このアプリのバージョンでは同じレースを再現できないため、再生できません",
            [ReplayUnplayable.Broken] = "データを読み込めないため、再生できません",
        };
        public static readonly IReadOnlyDictionary<string, string> MomentTexts = new Dictionary<string, string>
        {
            ["win"] = "勝利", ["photo"] = "写真判定", ["pb"] = "自己ベスト",
        };
        public const string TextEmpty = "保存したリプレイはまだありません。レースの名場面は自動でここに並びます";
        public const string TextFull = "保存できるのはここまでです。不要なリプレイを削除してください";
        public const string TextPublicNote = "公開にすると、フレンドがこのリプレイを見られます（ほかのプレイヤーは馬の名前だけが表示されます）";

        private readonly NowMs _now;
        private readonly Func<string, string> _courseName;
        private readonly Action<AnalyticsEvent> _track;

        /// <param name="courseName">trackId → display name (server tracks.json); null shows the id.</param>
        public MyReplaysModel(GameBackend backend, Func<string, string> courseName = null, Action<AnalyticsEvent> track = null, NowMs now = null) : base(backend, backend?.Store)
        {
            _courseName = courseName;
            _track = track;
            _now = now ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        }

        public MyReplaysView View { get; private set; }
        public bool Enabled => View != null && View.Enabled;
        /// <summary>「保存 2/20」.</summary>
        public string CountText => View == null ? null : Loc.T("保存 " + N(View.Used) + "/" + N(View.MaxSaved));
        public bool Full => View != null && View.Full;
        public int TitleMaxChars => View?.TitleMaxChars ?? 24;

        public List<ReplayCard> SavedCards => View == null ? new List<ReplayCard>() : View.Saved.Select(Card).ToList();
        public List<ReplayCard> MomentCards => View == null ? new List<ReplayCard>() : View.Moments.Select(r => RaceCard(r)).ToList();
        public List<ReplayCard> RecentCards => View == null ? new List<ReplayCard>() : View.Recent.Select(r => RaceCard(r)).ToList();
        public bool Empty => View != null && View.Saved.Count == 0 && View.Moments.Count == 0 && View.Recent.Count == 0;

        private string Course(string trackId) => _courseName?.Invoke(trackId) ?? trackId;
        private static string N(int n) => n.ToString(CultureInfo.InvariantCulture);
        /// <summary>Month/day in JST.</summary>
        public static string Date(long ms)
        {
            var d = DateTimeOffset.FromUnixTimeMilliseconds(ms).ToOffset(TimeSpan.FromHours(9));
            return N(d.Month) + "/" + N(d.Day);
        }
        public static string ResultLine(int place, int field) => place <= 0 ? Loc.T("完走ならず") : Loc.T(N(place) + "着 / " + N(field) + "頭");
        public static string Unplayable(string reason) => reason != null && UnplayableTexts.TryGetValue(reason, out var t) ? Loc.T(t) : Loc.T(TextUnplayable);

        private ReplayCard RaceCard(ReplayRace r)
        {
            return new ReplayCard
            {
                RaceId = r.RaceId, Title = Course(r.TrackId) + " " + Loc.T(N(r.Place) + "着"), TitleIsTyped = false, ResultText = ResultLine(r.Place, r.FieldSize),
                CourseText = Course(r.TrackId), DateText = Date(r.At), Moment = r.Moment, MomentText = r.Moment != null && MomentTexts.TryGetValue(r.Moment, out var m) ? Loc.T(m) : null,
                Place = r.Place, Saved = r.Saved, Playable = true,
                KeepUntilText = r.ExpiresAt.HasValue && !r.Saved ? Loc.T(Date(r.ExpiresAt.Value - 1) + "まで保存できます") : null,
            };
        }

        public ReplayCard Card(SavedReplay r)
        {
            var c = RaceCard(r);
            c.Saved = true; c.KeepUntilText = null;
            c.Favorite = r.Favorite; c.Public = r.Public; c.Playable = r.Playable;
            c.UnplayableText = r.Playable ? null : Unplayable(r.Reason);
            if (!string.IsNullOrEmpty(r.ReplayTitle)) { c.Title = r.ReplayTitle; c.TitleIsTyped = true; } // as typed, never Loc.T
            return c;
        }

        public async Task<ActionResult> LoadAsync(CancellationToken ct = default)
        {
            Message = null;
            if (!ServerAvailable) { View = null; return Offline("マイリプレイはオンラインで表示されます"); }
            try { View = await B.Api.GetMyReplaysAsync(ct); Online = true; return ActionResult.Success(); }
            catch (ApiException e) { return Fail(e); }
        }

        /// <summary>The rename sheet's local check (the server has the final word: NG words, URLs).</summary>
        public string TitleProblem(string title)
        {
            if (title == null) return null;
            int len = new StringInfo(title.Normalize(System.Text.NormalizationForm.FormKC).Trim()).LengthInTextElements;
            return len < 1 || len > TitleMaxChars ? Loc.T("タイトルは1〜" + N(TitleMaxChars) + "文字です") : null;
        }

        /// <summary>残す: save a best moment / recent race (keyed, so a retry never saves twice).</summary>
        public async Task<ActionResult> SaveAsync(string raceId, string title = null, CancellationToken ct = default)
        {
            if (!ServerAvailable) return Offline("保存はオンラインでできます");
            if (Full) return ActionResult.Error(TextFull);
            var p = TitleProblem(title);
            if (p != null) return ActionResult.Error(p);
            try
            {
                var r = await B.Api.SaveReplayAsync(raceId, title, null, ct);
                View = r.View;
                return ActionResult.Success("リプレイを保存しました");
            }
            catch (ConflictException e) when (e.Code == ApiErrorCode.ReplayLimit) { Message = Loc.T(TextFull); return ActionResult.Error(TextFull); }
            catch (ConflictException e) when (e.Code == ApiErrorCode.ReplayExpired) { await LoadAsync(ct); return ActionResult.Error("このレースのリプレイはもう保存できません"); }
            catch (ApiException e) { return Fail(e); }
        }

        private void Replace(SavedReplay s)
        {
            if (View == null || s == null) return;
            int i = View.Saved.FindIndex(x => x.RaceId == s.RaceId);
            if (i >= 0) View.Saved[i] = s;
            View.Saved = View.Saved.OrderByDescending(x => x.Favorite).ThenByDescending(x => x.SavedAt).ToList();
        }

        /// <summary>The rename sheet: null / empty clears the title.</summary>
        public async Task<ActionResult> RenameAsync(string raceId, string title, CancellationToken ct = default)
        {
            if (!ServerAvailable) return Offline("名前の変更はオンラインでできます");
            bool clear = string.IsNullOrWhiteSpace(title);
            if (!clear) { var p = TitleProblem(title); if (p != null) return ActionResult.Error(p); }
            try { Replace(await B.Api.UpdateReplayAsync(raceId, clear ? null : title, clear, null, null, ct)); return ActionResult.Success(); }
            catch (ApiException e) { return Fail(e); }
        }

        public async Task<ActionResult> SetFavoriteAsync(string raceId, bool favorite, CancellationToken ct = default)
        {
            if (!ServerAvailable) return Offline("お気に入りはオンラインで変更できます");
            try { Replace(await B.Api.UpdateReplayAsync(raceId, null, false, favorite, null, ct)); return ActionResult.Success(); }
            catch (ApiException e) { return Fail(e); }
        }

        /// <summary>公開: friends can watch it (<see cref="TextPublicNote"/> is shown beside the switch).</summary>
        public async Task<ActionResult> SetPublicAsync(string raceId, bool isPublic, CancellationToken ct = default)
        {
            if (!ServerAvailable) return Offline("公開の設定はオンラインで変更できます");
            try { Replace(await B.Api.UpdateReplayAsync(raceId, null, false, null, isPublic, ct)); return ActionResult.Success(); }
            catch (ApiException e) { return Fail(e); }
        }

        public async Task<ActionResult> DeleteAsync(string raceId, CancellationToken ct = default)
        {
            if (!ServerAvailable) return Offline("削除はオンラインでできます");
            try { View = (await B.Api.DeleteReplayAsync(raceId, ct)).View; return ActionResult.Success("リプレイを削除しました"); }
            catch (ApiException e) { return Fail(e); }
        }

        /// <summary>The player for one of my replays (own, moment or recent). Null + Message when it cannot be played.</summary>
        public async Task<ReplayPlayer> OpenAsync(string raceId, CancellationToken ct = default)
        {
            Message = null;
            if (!ServerAvailable) { Message = Loc.T("リプレイはオンラインで再生できます"); return null; }
            try { return Opened(await B.Api.GetReplayDataAsync(raceId, ct)); }
            catch (ConflictException e) when (e.Code == ApiErrorCode.ReplayExpired) { Message = Loc.T("このレースのリプレイはもう残っていません"); return null; }
            catch (ApiException e) { Message = e.Message; return null; }
        }

        /// <summary>A friend's public replay.</summary>
        public async Task<ReplayPlayer> OpenFriendAsync(string playerId, string raceId, CancellationToken ct = default)
        {
            Message = null;
            if (!ServerAvailable) { Message = Loc.T("リプレイはオンラインで再生できます"); return null; }
            try { return Opened(await B.Api.GetFriendReplayDataAsync(playerId, raceId, ct)); }
            catch (NotFoundException) { Message = Loc.T("このリプレイは見られません"); return null; }
            catch (ApiException e) { Message = e.Message; return null; }
        }

        private ReplayPlayer Opened(ReplayData d)
        {
            var p = ReplayPlayer.Open(d);
            if (!p.Playable) Message = Unplayable(p.Reason);
            return p;
        }

        /// <summary>The camera picker: 「アイボウ（あなた）」, 「ハヤテ」 — horse names only, never other players' names.</summary>
        public static List<string> CameraLabels(ReplayData d)
        {
            var list = new List<string>();
            foreach (var e in d.Entrants.OrderBy(x => x.Slot))
                list.Add(e.Owner == "you" ? Loc.T(e.HorseName + "（あなた）") : e.Owner == "owner_player" ? Loc.T(e.HorseName + "（フレンド）") : e.HorseName);
            return list;
        }

        /// <summary>「1×」 for the speed button (0.5× / 1× / 2×).</summary>
        public static string SpeedLabel(double speed) => speed.ToString("0.#", CultureInfo.InvariantCulture) + "×";

        /// <summary>REQ-MYRP-014: the replay was handed to the OS share sheet (cancelled shares are not sent).</summary>
        public void Shared(bool friendReplay) => _track?.Invoke(AnalyticsEvent.ReplayShare(_now(), friendReplay ? "friend_replay" : "my_replays"));
    }
}
