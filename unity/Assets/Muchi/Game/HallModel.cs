using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;

namespace Muchi.Game
{
    // REQ-HOF-001..016 (contracts/protocol.md §34, docs/handoff-codex-round14-hall-of-fame.md): 殿堂・引退式, the game layer.
    // Pure C#: Codex's retirement ceremony, hall gallery, plaque detail and friend's hall bind to the public fields. The server
    // keeps the career, picks the highlight lines and decides 殿堂入り; the model formats, pages and acknowledges.

    /// <summary>One plaque card in the gallery (and the plaque detail).</summary>
    public sealed class PlaqueCard
    {
        public string HorseId;
        /// <summary>The horse's name as the player typed it (never translated).</summary>
        public string HorseName;
        public string Rarity, Coat;
        public Appearance Appearance;
        /// <summary>"34戦11勝・3着以内20回".</summary>
        public string CareerText;
        /// <summary>"10勝以上・大会優勝・相棒" — why the horse is in the hall.</summary>
        public string ReasonText;
        /// <summary>"2026年11月9日 殿堂入り".</summary>
        public string InductedText;
        public bool Partner, Frame;
        public List<string> Highlights = new List<string>();
    }

    /// <summary>The retirement ceremony screen (one per horse).</summary>
    public sealed class CeremonySheet
    {
        public string HorseId, HorseName;
        /// <summary>"引退式" headline; "殿堂入り" stamp shown when <see cref="Inducted"/>.</summary>
        public bool Inducted, Partner;
        public string CareerText, ReasonText, StampText;
        public List<string> Highlights = new List<string>();
        /// <summary>"殿堂の額縁を受け取りました" at the account's first induction, else null.</summary>
        public string RewardText;
        /// <summary>A line for a horse that did not qualify, else null.</summary>
        public string FarewellText;
    }

    /// <summary>
    /// 殿堂 (hall of fame): the gallery (paged, newest first), the plaque detail, a friend's / branch member's hall, a horse's
    /// career and the retirement ceremony. Rules the model keeps for the screens:
    ///  - the ceremony appears once per horse: <see cref="DismissCeremonyAsync"/> acknowledges it (idempotent); a ceremony
    ///    missed offline or by a lost response comes back from <see cref="LoadMineAsync"/> (pending ceremonies);
    ///  - names are shown as typed; visiting refusals all read "この殿堂は見られません" (the server never says why);
    ///  - there is no shop link: 殿堂入り depends only on confirmed race results (<see cref="RulesText"/>).
    /// </summary>
    public sealed class HallModel : ScreenModel
    {
        public const string RulesText = "殿堂入りは引退の時に決まります。条件は確定したレースの成績だけで、購入やアイテムでは決まりません。";
        public const string StampLabel = "殿堂入り";
        public static readonly IReadOnlyDictionary<string, string> VisibilityTexts = new Dictionary<string, string>
        {
            ["friends_team"] = "フレンドと支部の仲間", ["friends"] = "フレンドだけ", ["private"] = "自分だけ",
        };
        public static readonly IReadOnlyDictionary<string, string> RelationTexts = new Dictionary<string, string>
        {
            ["self"] = "自分の殿堂", ["friend"] = "フレンドの殿堂", ["team"] = "支部の仲間の殿堂",
        };

        public HallModel(GameBackend backend, IKeyValueStore store = null) : base(backend, store ?? backend?.Store) { }

        /// <summary>The page set being shown (mine or a visit); <see cref="Cards"/> accumulates pages.</summary>
        public HallPage Page { get; private set; }
        public List<PlaqueCard> Cards { get; } = new List<PlaqueCard>();
        public string VisitingPlayerId { get; private set; }
        public bool HasMore => Page != null && Page.NextCursor != null;
        public HallCriteria Criteria { get; private set; }
        public string Visibility => Page != null && Page.IsMine ? Page.Visibility : null;
        public HorseCareer Career { get; private set; }
        /// <summary>The ceremony to show now (null = none).</summary>
        public CeremonySheet Ceremony { get; private set; }
        private readonly Queue<HallCeremony> _pending = new Queue<HallCeremony>();
        private HallCeremony _shown;

        /// <summary>"フレンドの殿堂" / "ミドリカワの殿堂" title line.</summary>
        public string TitleText => Page == null ? null : Page.IsMine ? RelationTexts["self"] : (Page.Owner?.DisplayName ?? "") + "の殿堂";
        /// <summary>"殿堂入り 12頭".</summary>
        public string CountText => Page == null ? null : "殿堂入り " + N(Page.Total) + "頭";
        /// <summary>"10勝以上・大会優勝・相棒で30戦以上 のどれかで殿堂入り".</summary>
        public string CriteriaText
        {
            get
            {
                if (Criteria == null) return null;
                var parts = new List<string>();
                if (Criteria.WinsMin > 0) parts.Add(N(Criteria.WinsMin) + "勝以上");
                if (Criteria.TournamentWin) parts.Add("大会優勝");
                if (Criteria.PartnerRacesMin > 0) parts.Add("相棒で" + N(Criteria.PartnerRacesMin) + "戦以上");
                return string.Join("・", parts) + " のどれかで殿堂入り";
            }
        }
        public string EmptyText => Page != null && Page.Total == 0 ? "まだ殿堂入りした馬はいません" : null;

        public async Task<ActionResult> LoadMineAsync(CancellationToken ct = default)
        {
            Message = null;
            if (!ServerAvailable) return Offline("殿堂はオンラインで表示されます");
            try
            {
                var p = await B.Api.GetMyHallAsync(null, null, ct);
                SetPage(p, null);
                Criteria = p.Criteria;
                _pending.Clear();
                foreach (var c in p.PendingCeremonies) if (_shown == null || c.HorseId != _shown.HorseId) _pending.Enqueue(c);
                if (Ceremony == null) ShowNextCeremony();
                Online = true;
                return ActionResult.Success();
            }
            catch (ApiException e) { Message = UxText.For(e); return ActionResult.Error(Message); }
        }

        /// <summary>A friend's or branch member's hall (same NOT_FOUND line for every refusal).</summary>
        public async Task<ActionResult> VisitAsync(string playerId, CancellationToken ct = default)
        {
            Message = null;
            if (!ServerAvailable) return Offline("殿堂はオンラインで表示されます");
            try
            {
                SetPage(await B.Api.GetHallAsync(playerId, null, null, ct), playerId);
                Online = true;
                return ActionResult.Success();
            }
            catch (ApiException e) when (e.WireCode == "NOT_FOUND") { Page = null; Cards.Clear(); Message = "この殿堂は見られません"; return ActionResult.Error(Message); }
            catch (ApiException e) { Message = UxText.For(e); return ActionResult.Error(Message); }
        }

        /// <summary>Appends the next page (keyset cursor: a new induction never shifts it).</summary>
        public async Task<ActionResult> LoadMoreAsync(CancellationToken ct = default)
        {
            if (!HasMore) return ActionResult.Success();
            try
            {
                var p = VisitingPlayerId == null ? await B.Api.GetMyHallAsync(Page.NextCursor, null, ct) : await B.Api.GetHallAsync(VisitingPlayerId, Page.NextCursor, null, ct);
                foreach (var e in p.Entries) if (!Cards.Any(c => c.HorseId == e.HorseId)) Cards.Add(Card(e));
                Page = p;
                return ActionResult.Success();
            }
            catch (ApiException e) { Message = UxText.For(e); return ActionResult.Error(Message); }
        }

        private void SetPage(HallPage p, string visiting)
        {
            Page = p;
            VisitingPlayerId = visiting;
            Cards.Clear();
            foreach (var e in p.Entries) Cards.Add(Card(e));
        }

        /// <summary>A horse's career and progress toward 殿堂入り (horse detail).</summary>
        public async Task<ActionResult> LoadCareerAsync(string horseId, CancellationToken ct = default)
        {
            if (!ServerAvailable) return Offline("戦績はオンラインで表示されます");
            try { Career = await B.Api.GetHorseCareerAsync(horseId, ct); return ActionResult.Success(); }
            catch (ApiException e) { Message = UxText.For(e); return ActionResult.Error(Message); }
        }

        /// <summary>"殿堂入りまで：10勝のうち7勝・大会優勝 まだ" (null when retired or no rule applies).</summary>
        public string ProgressText
        {
            get
            {
                if (Career == null || Career.Status != "active") return null;
                var parts = new List<string>();
                if (Career.WinsProgress != null) parts.Add(N(Career.WinsProgress.Need) + "勝のうち" + N(Career.WinsProgress.Have) + "勝");
                if (Career.TournamentWin.HasValue) parts.Add(Career.TournamentWin.Value ? "大会優勝 達成" : "大会優勝 まだ");
                if (Career.PartnerRacesProgress != null) parts.Add("相棒で" + N(Career.PartnerRacesProgress.Need) + "戦のうち" + N(Career.PartnerRacesProgress.Have) + "戦");
                return parts.Count == 0 ? null : "殿堂入りまで：" + string.Join("・", parts);
            }
        }

        /// <summary>The confirmation before retiring (retiring is permanent; the horse can still be bred).</summary>
        public static string RetireConfirmText(string horseName) => horseName + "を引退させます。引退した馬はレースに出られませんが、配合には使えます";

        /// <summary>Retire and show the ceremony. A lost response is recovered by <see cref="LoadMineAsync"/>.</summary>
        public async Task<ActionResult> RetireAsync(string horseId, CancellationToken ct = default)
        {
            if (!ServerAvailable) return Offline("引退はオンラインで行います");
            try
            {
                var r = await B.Api.RetireHorseAsync(horseId, ct);
                if (r.Ceremony != null) { _shown = r.Ceremony; Ceremony = Sheet(r.Ceremony); }
                return ActionResult.Success();
            }
            catch (ApiException e) { Message = UxText.For(e); return ActionResult.Error(Message); }
        }

        private void ShowNextCeremony()
        {
            _shown = _pending.Count > 0 ? _pending.Dequeue() : null;
            Ceremony = _shown == null ? null : Sheet(_shown);
        }

        /// <summary>The ceremony was closed: acknowledged (idempotent) and the next pending one, if any, is shown.</summary>
        public async Task<ActionResult> DismissCeremonyAsync(CancellationToken ct = default)
        {
            var c = _shown;
            if (c == null) return ActionResult.Success();
            ShowNextCeremony(); // closed on screen even if the request fails (it comes back on the next load)
            try { await B.Api.AcknowledgeCeremonyAsync(c.HorseId, ct); return ActionResult.Success(); }
            catch (ApiException e) { Message = UxText.For(e); return ActionResult.Error(Message); }
        }

        public async Task<ActionResult> SetVisibilityAsync(string visibility, CancellationToken ct = default)
        {
            if (!VisibilityTexts.ContainsKey(visibility ?? "")) return ActionResult.Error("公開範囲を選んでください");
            try
            {
                var v = await B.Api.SetHallVisibilityAsync(visibility, ct);
                if (Page != null && Page.IsMine) Page.Visibility = v;
                return ActionResult.Success("公開範囲を「" + VisibilityTexts[v] + "」にしました");
            }
            catch (ApiException e) { Message = UxText.For(e); return ActionResult.Error(Message); }
        }

        // ------------------------------------------------------------------------------------- formatting

        public static PlaqueCard Card(HallPlaque p) => new PlaqueCard
        {
            HorseId = p.HorseId, HorseName = p.HorseName, Rarity = p.Rarity, Appearance = p.Appearance, Coat = p.Appearance?.Coat,
            CareerText = CareerText(p.Career), ReasonText = ReasonText(p.Reasons, p.Career), InductedText = DateText(p.InductedAt) + " 殿堂入り",
            Partner = p.Partner, Frame = p.Frame, Highlights = p.Highlights.Select(h => h.Text).ToList(),
        };

        public static CeremonySheet Sheet(HallCeremony c) => new CeremonySheet
        {
            HorseId = c.HorseId, HorseName = c.HorseName, Inducted = c.Inducted, Partner = c.Partner,
            CareerText = CareerText(c.Career), ReasonText = c.Inducted ? ReasonText(c.Reasons, c.Career) : null, StampText = c.Inducted ? StampLabel : null,
            Highlights = c.Highlights.Select(h => h.Text).ToList(),
            RewardText = c.RewardItemId != null ? "殿堂の額縁を受け取りました（マイ厩舎に飾れます）" : null,
            FarewellText = c.Inducted ? null : "おつかれさま。これからは配合で血をつなぎます",
        };

        /// <summary>"34戦11勝・3着以内20回" ("まだレースに出ていません" with no race).</summary>
        public static string CareerText(CareerLine c)
        {
            if (c == null || c.Races == 0) return "まだレースに出ていません";
            return N(c.Races) + "戦" + N(c.Wins) + "勝・3着以内" + N(c.Places) + "回";
        }

        public static string ReasonText(string[] reasons, CareerLine c)
        {
            var parts = new List<string>();
            foreach (var r in reasons ?? new string[0])
            {
                if (r == "wins") parts.Add(N(c?.Wins ?? 0) + "勝");
                else if (r == "tournament") parts.Add("大会優勝");
                else if (r == "partner") parts.Add("最初の相棒");
            }
            return parts.Count == 0 ? null : string.Join("・", parts);
        }

        /// <summary>JST calendar date: "2026年11月9日".</summary>
        public static string DateText(long ms)
        {
            var d = DateTimeOffset.FromUnixTimeMilliseconds(ms).ToOffset(TimeSpan.FromHours(9));
            return N(d.Year) + "年" + N(d.Month) + "月" + N(d.Day) + "日";
        }

        private static string N(int n) => n.ToString(CultureInfo.InvariantCulture);
    }
}
