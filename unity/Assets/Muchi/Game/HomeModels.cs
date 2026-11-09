using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;

namespace Muchi.Game
{
    /// <summary>One home feature tile: open, or locked with "あと3戦で開放" / "2日目に開放" (06 §4.3, REQ-UXU-005).</summary>
    public sealed class FeatureTile
    {
        public string Key, Title;
        public bool Unlocked;
        /// <summary>Lock caption (null when open).</summary>
        public string LockLabel;
    }

    /// <summary>
    /// REQ-UXS-014 / REQ-UXU-005: which home features are shown. The server decides (PlayerView.Unlocks); the client only
    /// draws locks. Newly opened features are reported once (<see cref="TakeNewlyUnlocked"/> → the one-screen guide and the
    /// KPI feature_unlock). Offline the last known state is used (kept on the device) plus the four day-1 features.
    /// </summary>
    public sealed class UnlockGate
    {
        public const string KeySeen = "muchi.unlocks.seen";
        /// <summary>Shown from the first launch (06 §4.3 row 1).</summary>
        public static readonly string[] Always = { "race", "partner", "scout", "stable" };

        /// <summary>Japanese names of the unlock keys (the server's UNLOCK_KEYS).</summary>
        public static readonly IReadOnlyDictionary<string, string> Titles = new Dictionary<string, string>
        {
            ["race"] = "レース", ["partner"] = "相棒", ["scout"] = "スカウト", ["stable"] = "厩舎", ["missions"] = "ミッション", ["login_bonus"] = "ログインボーナス",
            ["shop"] = "ショップ", ["season_pass"] = "シーズンパス", ["bond"] = "絆・飼い葉", ["season"] = "シーズン・ランキング", ["breeding"] = "配合",
            ["friends"] = "フレンド", ["friend_rooms"] = "フレンド部屋", ["teams"] = "支部", ["spectate"] = "観戦", ["time_attack"] = "タイムアタック",
            ["events"] = "イベント", ["tournaments"] = "大会", ["my_stable"] = "マイ厩舎", ["stud"] = "種牡馬の貸し借り", ["training"] = "調教", ["rival"] = "ライバル",
        };

        /// <summary>The one-screen guide when a feature opens (06 §4.3 third column); null = no guide.</summary>
        public static readonly IReadOnlyDictionary<string, string> Guides = new Dictionary<string, string>
        {
            ["missions"] = "毎日の目標。終わればコインや素材",
            ["shop"] = "はじめての購入は、同じ枚数の無償コインをプレゼント",
            ["bond"] = "乗るほど、世話するほど絆が深まる（能力は変わらない）",
            ["season"] = "C級から。月末に昇級",
            ["breeding"] = "繁殖牝馬のプレゼントと一緒に、配合が開きました",
            ["teams"] = "おすすめの支部を3つ選びました",
            ["events"] = "開催中のイベントにエントリーできます",
            ["my_stable"] = "飾りを1つプレゼント。厩舎を飾ってみよう",
            ["training"] = "1日3回、相棒を鍛えよう。タイミングよく押すと少しだけ伸びが良くなる",
            ["rival"] = "毎週ひとり、近い実力のライバル。同じランク戦で先着すれば1点",
        };

        private readonly GameBackend _b;
        private readonly IKeyValueStore _kv;

        public UnlockGate(GameBackend backend) { _b = backend ?? throw new ArgumentNullException(nameof(backend)); _kv = backend.Store; }

        private UnlocksView View => _b.Online ? _b.Player?.Unlocks : null;

        private HashSet<string> Seen => new HashSet<string>((_kv.Get(KeySeen) ?? "").Split(',').Where(s => s.Length > 0));

        public bool IsUnlocked(string key)
        {
            if (Always.Contains(key)) return true;
            var v = View;
            if (v != null) return v.IsUnlocked(key);
            return Seen.Contains(key); // offline: what the server last said
        }

        /// <summary>"あと3戦で開放" / "2日目に開放" / "2日目 または あと3戦で開放" (any one condition opens it); null when open.</summary>
        public string LockLabel(string key)
        {
            if (IsUnlocked(key)) return null;
            var v = View;
            var f = v?.Features.FirstOrDefault(x => x.Key == key);
            if (f == null) return "まだ開放されていません";
            var parts = new List<string>();
            if (f.Days.HasValue) parts.Add(f.Days.Value + "日目");
            if (f.Races.HasValue) parts.Add("あと" + Math.Max(1, f.Races.Value - v.Races) + "戦");
            if (f.RankedRaces.HasValue) parts.Add("初心者マッチあと" + Math.Max(1, f.RankedRaces.Value - v.RankedRaces) + "戦");
            if (f.Breedings.HasValue) parts.Add("配合あと" + Math.Max(1, f.Breedings.Value - v.Breedings) + "回");
            if (parts.Count == 0) return "まだ開放されていません";
            return string.Join(" または ", parts) + (parts.Count == 1 && f.Days.HasValue ? "に開放" : "で開放");
        }

        public FeatureTile Tile(string key) => new FeatureTile
        {
            Key = key, Title = Titles.TryGetValue(key, out var t) ? t : key, Unlocked = IsUnlocked(key), LockLabel = LockLabel(key),
        };

        /// <summary>
        /// Features the server reports open that this device has not reported before (each once, ever). Fires the KPI
        /// feature_unlock for each and remembers them (also the offline fallback). The day-1 features are not reported.
        /// </summary>
        public List<string> TakeNewlyUnlocked(Action<AnalyticsEvent> track = null, long nowMs = 0)
        {
            var v = View;
            var fresh = new List<string>();
            if (v == null) return fresh;
            var seen = Seen;
            foreach (var f in v.Features)
                if (f.Unlocked && !seen.Contains(f.Key) && !Always.Contains(f.Key)) fresh.Add(f.Key);
            if (fresh.Count == 0) return fresh;
            _kv.Set(KeySeen, string.Join(",", seen.Concat(fresh)));
            foreach (var k in fresh) track?.Invoke(AnalyticsEvent.FeatureUnlock(nowMs, k));
            return fresh;
        }
    }

    /// <summary>A banner on every screen while the account is scheduled for deletion (G6): purchases, offers, allowance and paid scouts are blocked.</summary>
    public static class DeletionGuard
    {
        public static bool Pending(GameBackend b) => b?.Player?.Deletion != null && b.Player.Deletion.Scheduled;

        /// <summary>"アカウント削除の予定があります（12月9日）。取り消すと使えます".</summary>
        public static string Banner(long? deleteAt) => "アカウント削除の予定があります" + (deleteAt.HasValue ? "（" + JstDate(deleteAt.Value) + "）" : "") + "。取り消すと使えます";

        public static string Banner(GameBackend b) => Pending(b) ? Banner(b.Player.Deletion.DeleteAt) : null;

        /// <summary>"12月9日" (JST).</summary>
        public static string JstDate(long ms)
        {
            var d = DateTimeOffset.FromUnixTimeMilliseconds(ms + 9L * 3600 * 1000).UtcDateTime;
            return d.Month.ToString(CultureInfo.InvariantCulture) + "月" + d.Day.ToString(CultureInfo.InvariantCulture) + "日";
        }
    }

    /// <summary>
    /// REQ-UXU-014: the login bonus, claimed automatically at launch once the feature is open (2戦目の後), shown as a toast
    /// ("ログインボーナス 3日目：勝負服"). Beginner track first (7 days once; day 2 = a broodmare), then the 7-day cycle; days
    /// advance even when not consecutive (no penalty). The claim's idempotency key is kept for the game day until the
    /// server answers, so a retry after a timeout never claims twice.
    /// </summary>
    public sealed class LoginBonusModel : ScreenModel
    {
        public const string KeyPending = "muchi.login.key";
        private readonly NowMs _now;

        public LoginBonusModel(GameBackend backend, NowMs now = null) : base(backend, backend?.Store) { _now = now ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()); }

        public LoginBonusResult Last { get; private set; }
        /// <summary>The toast to show once (null = nothing new).</summary>
        public string Toast { get; private set; }

        /// <summary>Already claimed this game day (the server's last claim date = today's game day).</summary>
        public bool ClaimedToday => B.Player?.LoginLastClaimDate == GameDay.Key(_now());

        public static string ToastFor(LoginBonusResult r, Func<string, string> itemName = null)
        {
            if (r == null) return null;
            string head = r.IsBeginner ? "はじめての7日間 " + r.Day + "日目" : "ログインボーナス " + r.Day + "日目";
            return head + "：" + UxText.Reward(r.Reward, itemName);
        }

        /// <summary>Claim if open and not claimed today. Returns true when a reward was granted now (show <see cref="Toast"/>).</summary>
        public async Task<bool> AutoClaimAsync(Func<string, string> itemName = null, CancellationToken ct = default)
        {
            Toast = null; Message = null;
            if (!ServerAvailable || B.Player == null) return false;
            if (!new UnlockGate(B).IsUnlocked("login_bonus") || ClaimedToday) return false;
            string day = GameDay.Key(_now());
            var stored = (Kv.Get(KeyPending) ?? "").Split('|');
            string key = stored.Length == 2 && stored[0] == day ? stored[1] : null;
            if (key == null) { key = B.Api.NewIdempotencyKey(); Kv.Set(KeyPending, day + "|" + key); }
            try
            {
                Last = await B.Api.ClaimLoginBonusAsync(key, ct);
                Kv.Set(KeyPending, "");
                Toast = ToastFor(Last, itemName);
                Online = true;
                await B.RefreshAsync(ct);
                return true;
            }
            catch (ConflictException e) when (e.Code == ApiErrorCode.AlreadyClaimed)
            {
                Kv.Set(KeyPending, "");
                await B.RefreshAsync(ct);
                return false;
            }
            catch (ApiException e)
            {
                if (!GameBackend.IsTransient(e)) Kv.Set(KeyPending, "");
                Message = UxText.For(e);
                return false;
            }
        }
    }

    public enum MissionTable { Daily, Beginner, Season }

    /// <summary>One row of the mission board (any table; claims go through the same endpoint).</summary>
    public sealed class MissionRow
    {
        public MissionTable Table;
        public string Id, Kind, Title, RewardText;
        public int Progress, Target;
        public bool Claimed, Claimable, Locked;
        public string ProgressText => Target > 0 ? Math.Min(Progress, Target) + "/" + Target : Progress.ToString(CultureInfo.InvariantCulture);
    }

    /// <summary>
    /// REQ-UXU-014 / REQ-UXS-010/015/016: the mission board — daily 3, the 10-step beginner list (claimed in order; the
    /// next locked step shows no claim button, which prevents NOT_ELIGIBLE), season missions (pass XP) and today's
    /// first-win bonus — plus the home panel summary. Claims are keyed per mission and the key is kept until the server
    /// answers, so a retry after a timeout never pays twice. No "揃えたら" (collect-them-all) wording is built here.
    /// </summary>
    public sealed class MissionBoardModel : ScreenModel
    {
        public const string KeyPendingClaim = "muchi.mission.claim";

        public static readonly IReadOnlyDictionary<string, string> KindTitles = new Dictionary<string, string>
        {
            ["races"] = "レースに出る", ["wins"] = "1着になる", ["top3"] = "3着以内に入る", ["gacha"] = "スカウトを1回", ["silks"] = "勝負服を変える",
            ["care"] = "飼い葉をあげる", ["ranked_top3"] = "ランク戦で3着以内", ["breed"] = "配合を1回", ["friends"] = "フレンドを追加", ["team"] = "支部に入る",
            ["ta_finish"] = "タイムアタックを完走", ["ranked_races"] = "ランク戦に出る", ["points"] = "シーズンptを集める", ["promotion_line"] = "昇級ラインに届く", ["collect"] = "図鑑の馬を迎える", ["training"] = "調教を1回",
        };

        private readonly NowMs _now;
        public MissionBoardModel(GameBackend backend, NowMs now = null) : base(backend, backend?.Store) { _now = now ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()); }

        public MissionBoard Board { get; private set; }
        public bool Loading { get; private set; }

        public List<MissionRow> Daily => Board == null ? new List<MissionRow>() : Board.Missions.Select(m => new MissionRow
        {
            Table = MissionTable.Daily, Id = m.Id, Kind = m.Kind, Title = Title(m.Kind), RewardText = UxText.Reward(m.Reward),
            Progress = m.Progress, Target = m.Target, Claimed = m.Claimed, Claimable = m.Claimable,
        }).ToList();

        public List<MissionRow> Beginner => Board == null ? new List<MissionRow>() : Board.Beginner.Steps.OrderBy(s => s.Step).Select(s => new MissionRow
        {
            Table = MissionTable.Beginner, Id = s.Id, Kind = s.Kind, Title = s.Step + ". " + Title(s.Kind), RewardText = UxText.Reward(s.Reward),
            Progress = s.Progress, Target = s.Target, Claimed = s.Claimed, Claimable = s.Claimable && !s.Locked, Locked = s.Locked,
        }).ToList();

        public List<MissionRow> Season => Board == null ? new List<MissionRow>() : Board.Season.Missions.Where(m => m.Available).Select(m => new MissionRow
        {
            Table = MissionTable.Season, Id = m.Id, Kind = m.Kind, Title = Title(m.Kind), RewardText = UxText.Reward(m.Reward),
            Progress = m.Progress, Target = m.Target ?? 0, Claimed = m.Claimed, Claimable = m.Claimable,
        }).ToList();

        /// <summary>The next beginner step (first one not claimed), null once the list is done.</summary>
        public MissionRow NextBeginner => Board == null || Board.Beginner.Completed ? null : Beginner.FirstOrDefault(r => !r.Claimed);

        public int DailyDone => Board?.Missions.Count(m => m.Claimed || m.Progress >= m.Target) ?? 0;
        public int DailyTotal => Board?.Missions.Count ?? 0;
        /// <summary>"ミッション 2/3" or, when all are done, the reset note.</summary>
        public string DailyLine => Board == null ? null : DailyDone >= DailyTotal && DailyTotal > 0 ? "今日の分は完了。" + GameDay.NextResetLabel(_now()) + " に更新" : "ミッション " + DailyDone + "/" + DailyTotal;
        /// <summary>"初勝利ボーナス 残り2回（次は20コイン）" / "初勝利ボーナスは今日の分を受け取りました" / null when hidden by the A/B value.</summary>
        public string FirstWinLine
        {
            get
            {
                if (Board == null || B.Player?.Experiments?.FirstWinBonus == false) return null;
                var f = Board.FirstWinBonus;
                if (f.ByWin.Length == 0) return null;
                return f.Next.HasValue ? "初勝利ボーナス 残り" + f.Remaining + "回（次は" + f.Next.Value + "コイン）" : "初勝利ボーナスは今日の分を受け取りました";
            }
        }
        public int ClaimableCount => Daily.Count(r => r.Claimable) + Beginner.Count(r => r.Claimable) + Season.Count(r => r.Claimable);

        private static string Title(string kind) => kind != null && KindTitles.TryGetValue(kind, out var t) ? t : kind ?? "";

        public async Task LoadAsync(CancellationToken ct = default)
        {
            Message = null; Online = false;
            if (!ServerAvailable) { Offline("ミッションはサーバーで集計されます"); Message = UxText.Offline; return; }
            Loading = true;
            try { Board = await B.Api.GetMissionBoardAsync(ct); Online = true; }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
            catch (ApiException e) { Message = UxText.For(e); }
            finally { Loading = false; }
        }

        private MissionRow Find(string id) => Daily.Concat(Beginner).Concat(Season).FirstOrDefault(r => r.Id == id);

        /// <summary>Claim one mission (only when the row says claimable). The reward is returned in the result message.</summary>
        public async Task<ActionResult> ClaimAsync(string missionId, CancellationToken ct = default)
        {
            Message = null;
            if (!ServerAvailable) return Offline("ミッションの受け取りにはサーバーが必要です");
            var row = Find(missionId);
            if (row == null) return ActionResult.Error("ミッションが見つかりません");
            if (row.Claimed) return ActionResult.Error(UxText.Errors["ALREADY_CLAIMED"]);
            if (!row.Claimable) return ActionResult.Error(row.Locked ? "前の段を先に受け取ってください" : UxText.Errors["NOT_ELIGIBLE"]);
            string slot = KeyPendingClaim + ":" + missionId + ":" + GameDay.Key(_now());
            string key = Kv.Get(slot);
            if (string.IsNullOrEmpty(key)) { key = B.Api.NewIdempotencyKey(); Kv.Set(slot, key); }
            try
            {
                var reward = await B.Api.ClaimMissionAsync(missionId, key, ct);
                Kv.Set(slot, "");
                await LoadAsync(ct);
                await B.RefreshAsync(ct);
                Message = "受け取りました：" + UxText.Reward(reward);
                return ActionResult.Success(Message);
            }
            catch (ConflictException e) when (e.Code == ApiErrorCode.AlreadyClaimed || e.Code == ApiErrorCode.NotEligible)
            {
                Kv.Set(slot, "");
                await LoadAsync(ct);
                Message = UxText.For(e);
                return ActionResult.Error(Message);
            }
            catch (ApiException e)
            {
                if (!GameBackend.IsTransient(e)) Kv.Set(slot, "");
                Message = UxText.For(e);
                return ActionResult.Error(Message);
            }
        }
    }

    /// <summary>
    /// REQ-UXU-005: the home screen in the spec's order — partner, the big race button, today's list (login bonus, missions,
    /// first-win bonus, next beginner step), the season line — with locked tiles for features not open yet. Errors never
    /// block the race button (offline practice).
    /// </summary>
    public sealed class HomeModel
    {
        /// <summary>Tabs / tiles in display order (06 §6.1 ⑤ and the unlock table).</summary>
        public static readonly string[] TileKeys = { "stable", "scout", "shop", "season_pass", "missions", "bond", "training", "season", "rival", "breeding", "friends", "teams", "time_attack", "events", "my_stable" };

        private readonly GameBackend _b;
        public UnlockGate Unlocks { get; }
        public MissionBoardModel Missions { get; }
        public LoginBonusModel LoginBonus { get; }
        private readonly Action<AnalyticsEvent> _track;
        private readonly NowMs _now;

        public HomeModel(GameBackend backend, Action<AnalyticsEvent> track = null, NowMs now = null)
        {
            _b = backend ?? throw new ArgumentNullException(nameof(backend));
            _track = track;
            _now = now ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            Unlocks = new UnlockGate(backend);
            Missions = new MissionBoardModel(backend, _now);
            LoginBonus = new LoginBonusModel(backend, _now);
        }

        public ProfileModel Profile => _b.Profile();
        /// <summary>The race button always works (online: ranked / beginner match; offline: practice).</summary>
        public bool RaceEnabled => true;
        /// <summary>"race" (default) | "ranked_promotion" (A/B, REQ-UXS-032).</summary>
        public string PrimaryButton => _b.Player?.Experiments?.HomePrimaryButton ?? "race";
        public string PrimaryLabel => PrimaryButton == "ranked_promotion" ? "ランク戦へ（昇級をめざす）" : "レースへ";
        public List<FeatureTile> Tiles => TileKeys.Select(Unlocks.Tile).ToList();
        public string DeletionBanner => DeletionGuard.Banner(_b);
        /// <summary>REQ-BOX-004: the envelope badge on the home screen (0 = no badge; open GiftBoxModel).</summary>
        public int GiftBadge => _b.Player?.GiftBox?.Unclaimed ?? 0;
        /// <summary>Opened since the last visit (show the guide one screen at a time).</summary>
        public List<string> NewlyUnlocked { get; private set; } = new List<string>();
        public string Toast => LoginBonus.Toast;

        /// <summary>"今日やること": login bonus state, missions, first-win bonus, the next beginner step (only lines whose feature is open).</summary>
        public List<string> TodayLines
        {
            get
            {
                var l = new List<string>();
                if (Unlocks.IsUnlocked("login_bonus") && _b.Online) l.Add(LoginBonus.ClaimedToday ? "ログインボーナス 受取済み" : "ログインボーナス 未受取");
                if (Unlocks.IsUnlocked("missions") && Missions.DailyLine != null) l.Add(Missions.DailyLine);
                if (Missions.FirstWinLine != null) l.Add(Missions.FirstWinLine);
                var next = Missions.NextBeginner;
                if (next != null) l.Add("初心者ミッション " + next.Title + "（" + next.ProgressText + "）");
                return l;
            }
        }

        /// <summary>"C級 · 昇級まで…" from the profile (the season screen has the details).</summary>
        public string SeasonLine => _b.Online && _b.Player != null && Unlocks.IsUnlocked("season") ? _b.Player.ClassId + "級  " + _b.Player.SeasonPoints + "pt" : null;

        /// <summary>Home appeared: auto-claim the login bonus, load the board, collect newly opened features. Never throws for server errors.</summary>
        public async Task LoadAsync(Func<string, string> itemName = null, CancellationToken ct = default)
        {
            await LoginBonus.AutoClaimAsync(itemName, ct);
            if (Unlocks.IsUnlocked("missions") || _b.Online) await Missions.LoadAsync(ct);
            NewlyUnlocked = Unlocks.TakeNewlyUnlocked(_track, _now());
        }
    }
}
