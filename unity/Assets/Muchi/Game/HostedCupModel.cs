using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;

namespace Muchi.Game
{
    // REQ-CUP-001..018 (contracts/protocol.md §42, docs/handoff-codex-round16-hosted-cups.md): プレイヤー主催カップ, the game layer.
    // Pure C#: Codex's four screens (create, invite / join by code, lobby, standings) bind to the public fields. The server
    // decides everything that matters (limits, codes, the last slot, the races); this model shapes the text. Cup names and
    // player names are what players typed: shown as they are in every language (never through Loc.T).

    /// <summary>One row of the lobby's entrant list.</summary>
    public sealed class CupEntrantRow
    {
        /// <summary>As typed (never translated).</summary>
        public string Name, HorseName;
        /// <summary>「主催」「あなた」「棄権」 or null.</summary>
        public string Badge;
        public bool IsHost, IsMe, Withdrawn;
    }

    /// <summary>One row of the standings table.</summary>
    public sealed class CupStandingRow
    {
        public int Rank;
        public string Name;
        /// <summary>「1-3-2」 by race (「—」 = no place); empty before any race.</summary>
        public string PlacesText;
        /// <summary>「17pt」 (best of 3) or 「1着」 (single).</summary>
        public string ScoreText;
        /// <summary>gold / silver / bronze / null.</summary>
        public string Trophy;
        public bool IsMe;
    }

    /// <summary>
    /// プレイヤー主催カップ. Rules the model keeps for the screens:
    ///  - unranked: no rating, season, rival, missions or coins — the only reward is a trophy on the profile shelf (cosmetic);
    ///  - the host has no edge: nobody picks another player's horse, the rules never change after creation, the host only
    ///    presses 出走 inside the window;
    ///  - codes are typed in any case, with or without the hyphen; a wrong code never says why (blocked players look the same);
    ///  - other players are named only by the name they chose; the result card (ShareCard) shows no names at all.
    /// </summary>
    public sealed class HostedCupModel : ScreenModel
    {
        public const string TextUnranked = "ランク外のカップです。レーティング・シーズン・ライバルの記録・報酬には関係しません";
        public const string TextHostFair = "主催者も他の人の馬は選べません。条件は作った後に変えられません";
        public const string TextHostLeave = "主催者が抜けるとカップは中止になります";
        public const string TextCodeInvalid = "このコードのカップは見つかりません";
        public const string TextCodeLimit = "コードの入力が多すぎます。しばらくしてからもう一度お試しください";
        public const string TextFull = "満員になりました";
        public const string TextClosed = "このカップは受付を終了しています";
        public const string TextLimit = "参加中のカップが上限に達しています";
        public const string TextEmpty = "参加中のカップはありません";

        public static readonly IReadOnlyDictionary<string, string> StartProblemTexts = new Dictionary<string, string>
        {
            ["not_open"] = "開催の時間になると出走できます",
            ["too_few"] = "参加者がそろうと出走できます",
            ["race_running"] = "レースの結果を待っています",
            ["all_raced"] = "全レースが終わりました",
            ["closed"] = "開催の時間が終わりました",
        };
        public static readonly IReadOnlyDictionary<string, string> CancelTexts = new Dictionary<string, string>
        {
            ["host_left"] = "主催者が抜けたため中止になりました",
            ["host_deleted"] = "主催者が退会したため中止になりました",
            ["ops_deleted"] = "運営によって中止されました",
            ["expired"] = "開催の時間内にレースが行われなかったため中止になりました",
        };
        public static readonly IReadOnlyDictionary<string, string> TrophyTexts = new Dictionary<string, string>
        {
            ["gold"] = "金のトロフィー", ["silver"] = "銀のトロフィー", ["bronze"] = "銅のトロフィー",
        };

        private readonly Func<string, string> _courseName;
        private readonly NowMs _now;

        /// <param name="courseName">trackId → display name (server tracks.json); null shows the id.</param>
        public HostedCupModel(GameBackend backend, Func<string, string> courseName = null, NowMs now = null) : base(backend, backend?.Store)
        {
            _courseName = courseName;
            _now = now ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        }

        public MyCups Mine { get; private set; }
        /// <summary>The cup on the lobby / standings screen.</summary>
        public HostedCup Cup { get; private set; }
        /// <summary>What a typed code showed (join confirmation).</summary>
        public CupPreview Preview { get; private set; }
        public string MyPlayerId { get; set; }

        public bool Enabled => Mine != null && Mine.Enabled;
        public bool CanHost => Mine != null && Mine.CanHost;
        /// <summary>「主催 1/2・参加 2/4」.</summary>
        public string LimitsText => Mine == null ? null : Loc.T("主催 " + N(Mine.Hosting) + "/" + N(Mine.Limits.MaxActivePerHost) + "・参加 " + N(Mine.Active.Count) + "/" + N(Mine.Limits.MaxEntriesPerPlayer));
        /// <summary>「金 1・銀 0・銅 2」 for the trophy shelf.</summary>
        public string TrophyShelfText => Mine == null ? null : Loc.T("金 " + N(Mine.Trophies.Gold) + "・銀 " + N(Mine.Trophies.Silver) + "・銅 " + N(Mine.Trophies.Bronze));

        private static string N(int n) => n.ToString(CultureInfo.InvariantCulture);
        private string Course(string trackId) => trackId == null ? Loc.T("コースはレースごとに抽選") : _courseName?.Invoke(trackId) ?? trackId;
        public static string FormatText(string format) => format == CupFormats.BestOf3 ? Loc.T("3レースのポイント制") : Loc.T("1レース");
        /// <summary>Month/day hour:minute in JST.</summary>
        public static string When(long ms)
        {
            var d = DateTimeOffset.FromUnixTimeMilliseconds(ms).ToOffset(TimeSpan.FromHours(9));
            return N(d.Month) + "/" + N(d.Day) + " " + d.Hour.ToString("00", CultureInfo.InvariantCulture) + ":" + d.Minute.ToString("00", CultureInfo.InvariantCulture);
        }
        public static string WindowText(long opensAt, long closesAt) => When(opensAt) + "〜" + When(closesAt);

        /// <summary>「青葉 芝1600m・良・晴れ」 — course, going, weather of the rules.</summary>
        public string RulesText(CupConditions c)
        {
            if (c == null) return null;
            var parts = new List<string> { Course(c.TrackId) };
            if (c.Going != null && GoingTexts.TryGetValue(c.Going, out var g)) parts.Add(Loc.T(g));
            if (c.Night == true) parts.Add(Loc.T("ナイター"));
            return string.Join(Loc.IsEnglish ? " · " : "・", parts);
        }
        /// <summary>The same going names as the weekly challenge.</summary>
        public static IReadOnlyDictionary<string, string> GoingTexts => WeeklyChallengeModel.GoingTexts;

        // ---------------------------------------------------------------------------------------- list

        public async Task<ActionResult> LoadAsync(CancellationToken ct = default)
        {
            Message = null;
            if (!ServerAvailable) { Mine = null; return Offline("カップはオンラインで表示されます"); }
            try { Mine = await B.Api.GetCupsAsync(ct); Online = true; return ActionResult.Success(); }
            catch (ApiException e) { return Fail(e); }
        }

        // ---------------------------------------------------------------------------------------- create

        /// <summary>The create form's local checks (the server has the final word: NG words, URLs, the rules).</summary>
        public string CreateProblem(CupCreateRequest r)
        {
            var l = Mine?.Limits ?? new CupLimits();
            if (r == null) return Loc.T("入力してください");
            int len = new StringInfo((r.CupName ?? "").Normalize(System.Text.NormalizationForm.FormKC).Trim()).LengthInTextElements;
            if (len < 1 || len > l.NameMaxChars) return Loc.T("カップ名は1〜" + N(l.NameMaxChars) + "文字です");
            if (r.Capacity < l.MinCapacity || r.Capacity > l.MaxCapacity) return Loc.T("人数は" + N(l.MinCapacity) + "〜" + N(l.MaxCapacity) + "人です");
            long minutes = (r.ClosesAt - r.OpensAt) / 60_000;
            if (minutes < l.MinWindowMinutes || minutes > l.MaxWindowHours * 60L) return Loc.T("開催の時間は" + N(l.MinWindowMinutes) + "分〜" + N(l.MaxWindowHours) + "時間です");
            if (string.IsNullOrEmpty(r.HorseId)) return Loc.T("出走する馬を選んでください");
            if (r.Conditions == null && !r.UsePreset) return Loc.T("コースを選んでください");
            return null;
        }

        /// <summary>作成 (keyed: a retry with the same key never makes a second cup).</summary>
        public async Task<ActionResult> CreateAsync(CupCreateRequest r, string idempotencyKey = null, CancellationToken ct = default)
        {
            if (!ServerAvailable) return Offline("カップはオンラインで作れます");
            if (Mine != null && !Mine.CanHost) return ActionResult.Error(TextLimit);
            var p = CreateProblem(r);
            if (p != null) return ActionResult.Error(p);
            try
            {
                var res = await B.Api.CreateCupAsync(r, idempotencyKey, ct);
                Cup = res.Cup;
                return ActionResult.Success("カップを作りました。参加コードを共有しましょう");
            }
            catch (ConflictException e) when (e.Code == ApiErrorCode.CupLimit) { Message = Loc.T(TextLimit); return ActionResult.Error(TextLimit); }
            catch (ApiException e) { return Fail(e); }
        }

        // ---------------------------------------------------------------------------------------- join

        /// <summary>The code field: typed text → 「K7PM-Q2XD」 when it is a complete code, else null (the 参加 button stays off).</summary>
        public static string CodeForButton(string typed) { var n = CupCode.Normalize(typed); return n == null ? null : CupCode.Display(n); }

        /// <summary>Shows what a code leads to before joining (counts toward the hourly limit).</summary>
        public async Task<ActionResult> LookupAsync(string typed, CancellationToken ct = default)
        {
            Preview = null;
            if (!ServerAvailable) return Offline("参加はオンラインでできます");
            if (CupCode.Normalize(typed) == null) return ActionResult.Error(TextCodeInvalid);
            try { Preview = await B.Api.LookupCupCodeAsync(typed, ct); return ActionResult.Success(); }
            catch (ApiException e) { return JoinFail(e); }
        }

        private ActionResult JoinFail(ApiException e)
        {
            string t = e is NotFoundException ? TextCodeInvalid : e is RateLimitedException ? TextCodeLimit
                : e.Code == ApiErrorCode.CupFull ? TextFull : e.Code == ApiErrorCode.CupClosed ? TextClosed : e.Code == ApiErrorCode.CupLimit ? TextLimit : null;
            if (t == null) return Fail(e);
            Message = Loc.T(t);
            return ActionResult.Error(t);
        }

        /// <summary>参加: by code, or by an invitation (cup id). The horse is always the player's own choice.</summary>
        public async Task<ActionResult> JoinAsync(string horseId, string code = null, string cupId = null, CancellationToken ct = default)
        {
            if (!ServerAvailable) return Offline("参加はオンラインでできます");
            if (string.IsNullOrEmpty(horseId)) return ActionResult.Error("出走する馬を選んでください");
            try
            {
                var r = await B.Api.JoinCupAsync(horseId, code, cupId, null, ct);
                Cup = r.Cup;
                return ActionResult.Success(r.Joined ? "カップに参加しました" : "このカップには参加済みです");
            }
            catch (ApiException e) { return JoinFail(e); }
        }

        /// <summary>招待: friends and/or the whole branch (host only, before the first race).</summary>
        public async Task<ActionResult> InviteAsync(IList<string> friendIds, bool team, CancellationToken ct = default)
        {
            if (Cup == null) return ActionResult.Error("カップを開いてください");
            if (!ServerAvailable) return Offline("招待はオンラインでできます");
            try
            {
                var r = await B.Api.InviteToCupAsync(Cup.CupId, friendIds, team, ct);
                return ActionResult.Success(Loc.T(N(r.Invited) + "人を招待しました"));
            }
            catch (ConflictException e) when (e.Code == ApiErrorCode.CupClosed) { return ActionResult.Error("最初のレースの後は招待できません"); }
            catch (ApiException e) { return Fail(e); }
        }

        // ---------------------------------------------------------------------------------------- lobby

        public async Task<ActionResult> OpenAsync(string cupId, CancellationToken ct = default)
        {
            if (!ServerAvailable) return Offline("カップはオンラインで表示されます");
            try { Cup = await B.Api.GetCupAsync(cupId, ct); return ActionResult.Success(); }
            catch (ApiException e) { return Fail(e); }
        }

        public List<CupEntrantRow> EntrantRows => Cup == null ? new List<CupEntrantRow>() : Cup.Entrants.Select(e => new CupEntrantRow
        {
            Name = e.DisplayName, HorseName = e.HorseName, IsHost = e.PlayerId == Cup.HostId, IsMe = e.PlayerId == MyPlayerId, Withdrawn = e.Withdrawn,
            Badge = e.Withdrawn ? Loc.T("棄権") : e.PlayerId == Cup.HostId ? Loc.T("主催") : e.PlayerId == MyPlayerId ? Loc.T("あなた") : null,
        }).ToList();

        /// <summary>「4/6人」.</summary>
        public string SeatsText => Cup == null ? null : Loc.T(N(Cup.Entrants.Count) + "/" + N(Cup.Capacity) + "人");
        /// <summary>「第2レース / 全3レース」 or the result line.</summary>
        public string ProgressText => Cup == null ? null : Cup.Closed ? (Cup.Status == "cancelled" ? CancelText(Cup.CancelReason) : Cup.Partial ? Loc.T("開催の時間が終わったため、ここまでの順位で決着しました") : Loc.T("全レースが終わりました"))
            : Loc.T("第" + N(Math.Min(Cup.RacesDone + 1, Cup.RacesTotal)) + "レース / 全" + N(Cup.RacesTotal) + "レース");
        public static string CancelText(string reason) => reason != null && CancelTexts.TryGetValue(reason, out var t) ? Loc.T(t) : Loc.T("中止になりました");
        /// <summary>Why 出走 is off (host), null when it can start.</summary>
        public string StartHint => Cup == null || !Cup.IsHost || Cup.CanStart ? null : Cup.StartProblem != null && StartProblemTexts.TryGetValue(Cup.StartProblem, out var t) ? Loc.T(t) : null;

        /// <summary>出走 (host): every entrant then gets the seat from the match status, like a friend room.</summary>
        public async Task<ActionResult> StartAsync(CancellationToken ct = default)
        {
            if (Cup == null || !Cup.IsHost) return ActionResult.Error("主催者だけが出走できます");
            if (!ServerAvailable) return Offline("出走はオンラインでできます");
            try
            {
                await B.Api.StartCupRaceAsync(Cup.CupId, ct);
                Cup = await B.Api.GetCupAsync(Cup.CupId, ct);
                return ActionResult.Success("出走します。ゲートへ向かいましょう");
            }
            catch (ConflictException e) when (e.Code == ApiErrorCode.AlreadyInRace) { return ActionResult.Error("参加者の誰かが別のレース中です。少し待ってから出走してください"); }
            catch (ConflictException e) when (e.Code == ApiErrorCode.CupNotReady) { await OpenAsync(Cup.CupId, ct); return ActionResult.Error(StartHint ?? "まだ出走できません"); }
            catch (ApiException e) { return Fail(e); }
        }

        /// <summary>The leave confirmation: the host's says the cup is cancelled.</summary>
        public string LeaveConfirmText => Cup == null ? null : Cup.IsHost ? Loc.T(TextHostLeave) : Cup.RacesDone > 0 ? Loc.T("抜けると以降のレースは棄権になります") : Loc.T("カップから抜けますか？");

        public async Task<ActionResult> LeaveAsync(CancellationToken ct = default)
        {
            if (Cup == null) return ActionResult.Error("カップを開いてください");
            if (!ServerAvailable) return Offline("オンラインで操作できます");
            try
            {
                var r = await B.Api.LeaveCupAsync(Cup.CupId, null, ct);
                Cup = r.Cup;
                return ActionResult.Success(r.Cancelled ? "カップを中止しました" : "カップから抜けました");
            }
            catch (ApiException e) { return Fail(e); }
        }

        // ---------------------------------------------------------------------------------------- standings

        public List<CupStandingRow> StandingRows => Cup == null ? new List<CupStandingRow>() : Cup.Standings.Select(s => new CupStandingRow
        {
            Rank = s.Rank, Name = s.DisplayName, IsMe = s.PlayerId == MyPlayerId, Trophy = s.Trophy,
            PlacesText = string.Join("-", s.Places.Select(p => p.HasValue ? N(p.Value) : "—")),
            ScoreText = Cup.Format == CupFormats.BestOf3 ? Loc.T(N(s.Points) + "pt") : s.Places.Count > 0 && s.Places[s.Places.Count - 1].HasValue ? Loc.T(N(s.Places[s.Places.Count - 1].Value) + "着") : "—",
        }).ToList();

        public static string TrophyText(string trophy) => trophy != null && TrophyTexts.TryGetValue(trophy, out var t) ? Loc.T(t) : null;

        /// <summary>The cup result card (REQ-CUP-014) on the shared ShareCard; null before the cup finished or when not in it.</summary>
        public ShareCard ResultCard(string horseName)
        {
            if (Cup == null || Cup.Status != "finished" || Cup.Standings.All(s => s.PlayerId != MyPlayerId)) return null;
            return CupResultCard.Build(Cup, MyPlayerId, horseName, Course(Cup.Conditions?.TrackId));
        }
    }
}
