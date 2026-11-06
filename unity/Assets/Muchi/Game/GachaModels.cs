using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;

namespace Muchi.Game
{
    // ガチャの演出（めくり・スキップ・天井表示）と開催カレンダー — docs/planning/06 §6.5 / §7 item 7, REQ-GACHA-011..015.
    // Pure C# (no UnityEngine). Every number shown comes from the server (draw result, banner calendar, pity meter);
    // these models only order and word it. Legal guards (docs/planning/03, 06 §5.5): no countdown except to a real end
    // time, no 「倍」 or price comparisons, rarity never shown by color alone (06 §9.3).

    /// <summary>How a rarity is shown: color AND shape AND text (06 §9.3 — never color alone).</summary>
    public sealed class RarityStyle
    {
        public string Rarity;
        /// <summary>1 (R) … 3 (SSR).</summary>
        public int Tier;
        /// <summary>Shape drawn on the card and its frame: ◆ / ★ / ★★.</summary>
        public string Shape;
        /// <summary>Text always printed on the card ("SSR").</summary>
        public string Text;
        /// <summary>Screen-reader / caption text ("SSR（最高レア）").</summary>
        public string SpokenText;
        /// <summary>Light color of the card back before the flip and of the frame (sRGB hex).</summary>
        public string ColorHex;
        /// <summary>Frame pattern so the tiers differ in grayscale too: plain / double / burst.</summary>
        public string Frame;

        public static readonly RarityStyle R = new RarityStyle { Rarity = "R", Tier = 1, Shape = "◆", Text = "R", SpokenText = "R", ColorHex = "#8FB4CC", Frame = "plain" };
        public static readonly RarityStyle SR = new RarityStyle { Rarity = "SR", Tier = 2, Shape = "★", Text = "SR", SpokenText = "SR（高レア）", ColorHex = "#00CCF2", Frame = "double" };
        public static readonly RarityStyle SSR = new RarityStyle { Rarity = "SSR", Tier = 3, Shape = "★★", Text = "SSR", SpokenText = "SSR（最高レア）", ColorHex = "#FFD414", Frame = "burst" };

        public static RarityStyle Of(string rarity) => rarity == "SSR" ? SSR : rarity == "SR" ? SR : rarity == "R" ? R : new RarityStyle { Rarity = rarity ?? "?", Tier = 0, Shape = "●", Text = rarity ?? "?", SpokenText = rarity ?? "?", ColorHex = "#CCCCCC", Frame = "plain" };
    }

    /// <summary>One card of a scout result.</summary>
    public sealed class RevealCard
    {
        /// <summary>Slot in the server's result (0-based; slot 9 = the 10th pull).</summary>
        public int Slot;
        public string TemplateId, HorseId, Name, Rarity;
        public RarityStyle Style;
        /// <summary>A horse not in the stable before this scout (new-horse badge).</summary>
        public bool IsNew;
        public bool Duplicate;
        /// <summary>Awakening material from the duplicate (exact server amount).</summary>
        public int Material;
        /// <summary>Drawn from a guarantee table (10th-slot SR+ guarantee, or a step's own slot-10 table).</summary>
        public bool Guaranteed;
        public Appearance Appearance;
        /// <summary>"NEW" or "ダブり → 覚醒素材 +20".</summary>
        public string Badge => Duplicate ? "ダブり → 覚醒素材 +" + Material.ToString(CultureInfo.InvariantCulture) : IsNew ? "NEW" : "";
        /// <summary>Full caption for the card ("★★ SSR（最高レア） ギンガノカナタ NEW").</summary>
        public string Caption => Style.Shape + " " + Style.SpokenText + " " + Name + (Badge.Length > 0 ? " " + Badge : "");
    }

    /// <summary>
    /// The scout reveal (06 §6.5 演出: 1枚ずつめくる・全スキップ1タップ・最後に一覧). Cards flip one at a time, rarest last
    /// (lower rarities first, server order within a rarity), so the best horse is the climax; Skip jumps to the summary, which
    /// always lists every result — skipping never hides one. Duplicates show their exact material.
    /// </summary>
    public sealed class GachaRevealModel
    {
        private readonly List<RevealCard> _order;
        private int _shown;

        public DrawResult Result { get; }
        /// <summary>Cards in flip order (rarest last).</summary>
        public IReadOnlyList<RevealCard> RevealOrder => _order;
        /// <summary>Every result for the summary screen: rarest first, then slot (count = number of pulls, always).</summary>
        public IReadOnlyList<RevealCard> Summary { get; }
        /// <summary>Cards flipped so far (all of them once skipped).</summary>
        public int Shown => _shown;
        public int Count => _order.Count;
        public bool IsSummary => _shown >= _order.Count;
        public bool Skipped { get; private set; }
        /// <summary>The card currently face up (null before the first flip and on the summary).</summary>
        public RevealCard Current => _shown > 0 && !IsSummary ? _order[_shown - 1] : null;
        /// <summary>The card about to flip: its back already glows in its rarity color + shape (the "light" before the reveal).</summary>
        public RevealCard Upcoming => IsSummary ? null : _order[_shown];
        public string Progress => Math.Min(_shown, _order.Count).ToString(CultureInfo.InvariantCulture) + " / " + _order.Count.ToString(CultureInfo.InvariantCulture);

        public int NewCount => _order.Count(c => c.IsNew);
        public int DuplicateCount => _order.Count(c => c.Duplicate);
        public int MaterialTotal => _order.Sum(c => c.Material);
        public RarityStyle Best => _order.Count == 0 ? RarityStyle.Of(null) : _order.Last().Style;

        /// <param name="result">The server's draw result.</param>
        /// <param name="nameOf">Template id → horse name (master / odds rows); falls back to the id.</param>
        public GachaRevealModel(DrawResult result, Func<string, string> nameOf = null)
        {
            Result = result ?? throw new ArgumentNullException(nameof(result));
            var cards = new List<RevealCard>();
            for (int i = 0; i < result.Results.Count; i++)
            {
                var p = result.Results[i];
                cards.Add(new RevealCard
                {
                    Slot = i, TemplateId = p.TemplateId, HorseId = p.HorseId, Name = nameOf?.Invoke(p.TemplateId) ?? p.TemplateId, Rarity = p.Rarity,
                    Style = RarityStyle.Of(p.Rarity), Duplicate = p.Duplicate, IsNew = !p.Duplicate && p.HorseId != null, Material = p.Material,
                    Guaranteed = p.Guaranteed, Appearance = p.Appearance,
                });
            }
            // stable: lower tiers first, server order within a tier
            _order = cards.Select((c, k) => (c, k)).OrderBy(x => x.c.Style.Tier).ThenBy(x => x.k).Select(x => x.c).ToList();
            Summary = cards.OrderByDescending(c => c.Style.Tier).ThenBy(c => c.Slot).ToList();
        }

        /// <summary>Flip the next card (tap). Returns the card now face up, or null when the summary is reached.</summary>
        public RevealCard Next()
        {
            if (IsSummary) return null;
            _shown++;
            return IsSummary ? null : Current;
        }

        /// <summary>All-skip, one tap: straight to the summary with every result face up.</summary>
        public void SkipAll() { Skipped = _shown < _order.Count; _shown = _order.Count; }

        /// <summary>"新規 7頭・ダブり 3頭（覚醒素材 +25）" — exact counts and the material total.</summary>
        public string SummaryLine
        {
            get
            {
                var s = "新規 " + NewCount.ToString(CultureInfo.InvariantCulture) + "頭";
                if (DuplicateCount > 0) s += "・ダブり " + DuplicateCount.ToString(CultureInfo.InvariantCulture) + "頭（覚醒素材 +" + MaterialTotal.ToString(CultureInfo.InvariantCulture) + "）";
                return s;
            }
        }

        /// <summary>"有償 500 コインを使いました" / "有償 300・無償 700 コイン" (paid first; tutorial: null).</summary>
        public string SpentLine
        {
            get
            {
                if (Result.SpentPaid == 0 && Result.SpentFree == 0) return null;
                var parts = new List<string>();
                if (Result.SpentPaid > 0) parts.Add("有償 " + Result.SpentPaid.ToString("N0", CultureInfo.InvariantCulture));
                if (Result.SpentFree > 0) parts.Add("無償 " + Result.SpentFree.ToString("N0", CultureInfo.InvariantCulture));
                return string.Join("・", parts) + " コインを使いました";
            }
        }

        /// <summary>Step-up line under the summary: "ステップ5を引きました。次はステップ1（10連 500コイン）".</summary>
        public string StepUpLine
        {
            get
            {
                var su = Result.StepUp;
                if (su == null || su.Next == null) return null;
                var next = "次はステップ" + su.Next.Step.ToString(CultureInfo.InvariantCulture) + "（10連 " + su.Next.PriceTen.ToString("N0", CultureInfo.InvariantCulture) + "コイン"
                    + (su.Next.FinalSlotMinRarity != null ? "・10枠目は" + su.Next.FinalSlotMinRarity + "の表から" : "") + "）";
                return "ステップ" + su.DrawnStep.ToString(CultureInfo.InvariantCulture) + "を引きました。" + next;
            }
        }

        /// <summary>"交換pt 47 / 100" after this scout (the meter itself comes from GET /v1/gacha/status).</summary>
        public string PityLine(int cost) => "交換pt " + Result.PityPoints.ToString(CultureInfo.InvariantCulture) + " / " + cost.ToString(CultureInfo.InvariantCulture);
    }

    /// <summary>One banner row of the scout list.</summary>
    public sealed class BannerRow
    {
        public Banner Banner;
        public string Title;
        /// <summary>"1回 100 ・ 10回 1,000（SR以上1頭確定）" or the current step price for a step-up.</summary>
        public string PriceLine;
        /// <summary>"11月30日 23:59まで" / "常設" / "12月11日 0:00から".</summary>
        public string PeriodLine;
        /// <summary>A timer is shown only for an open banner with a real end time (06 §5.5 偽の急かし).</summary>
        public bool HasCountdown;
        public bool Upcoming => Banner.Upcoming;
        /// <summary>Pity meter of this banner once the status is applied: "交換pt 37 / 100（あと63回・6,300コイン）".</summary>
        public string PityLine;
        /// <summary>Carry-over notice of a closing pity group (verbatim from the server), null when the group never closes.</summary>
        public string CarryOverNotice;
        /// <summary>"ステップ 2 / 5 ・ 10連 1,000コイン"; null for a plain banner.</summary>
        public string StepLine;
        /// <summary>0..1 fill of the pity meter.</summary>
        public float PityFill;
    }

    /// <summary>
    /// Banner list with countdowns to the real end times only. The device clock is corrected by the server clock of the list
    /// (REQ-GACHA-011: the server decides at commit, so a pull on a banner whose timer reached 0 is answered BANNER_CLOSED and the
    /// list is reloaded).
    /// </summary>
    public sealed class BannerListModel
    {
        private const long JstOffsetMs = 9L * 3600 * 1000;
        public List<BannerRow> Rows { get; } = new List<BannerRow>();
        /// <summary>server time − device time when the list arrived.</summary>
        public long ClockOffsetMs { get; }
        public bool LocalOnly;
        public string Notice;

        public BannerListModel(BannerSchedule schedule, long deviceNowMs)
        {
            if (schedule == null) { LocalOnly = true; return; }
            ClockOffsetMs = schedule.ServerNowMs > 0 ? schedule.ServerNowMs - deviceNowMs : 0;
            foreach (var b in schedule.Banners)
            {
                Rows.Add(new BannerRow
                {
                    Banner = b, Title = b.Name, PriceLine = PriceText(b, null), PeriodLine = PeriodText(b),
                    HasCountdown = !b.Upcoming && b.EndAtMs.HasValue,
                });
            }
        }

        public static BannerListModel Offline(string notice) => new BannerListModel(null, 0) { Notice = notice };

        public long ServerNow(long deviceNowMs) => deviceNowMs + ClockOffsetMs;

        /// <summary>Time left until the banner's real end; null without a countdown. Never negative.</summary>
        public TimeSpan? Remaining(BannerRow row, long deviceNowMs)
        {
            if (!row.HasCountdown) return null;
            var ms = Math.Max(0, row.Banner.EndAtMs.Value - ServerNow(deviceNowMs));
            return TimeSpan.FromMilliseconds(ms);
        }

        /// <summary>"残り 3日 4時間" (more than a day) or "残り 05:12:09"; "終了しました" at 0; null without a countdown.</summary>
        public string CountdownText(BannerRow row, long deviceNowMs)
        {
            var r = Remaining(row, deviceNowMs);
            if (!r.HasValue) return null;
            var t = r.Value;
            if (t.TotalMilliseconds <= 0) return "終了しました";
            if (t.TotalHours >= 24) return "残り " + ((int)t.TotalDays).ToString(CultureInfo.InvariantCulture) + "日 " + t.Hours.ToString(CultureInfo.InvariantCulture) + "時間";
            return "残り " + ((int)t.TotalHours).ToString("00", CultureInfo.InvariantCulture) + ":" + t.Minutes.ToString("00", CultureInfo.InvariantCulture) + ":" + t.Seconds.ToString("00", CultureInfo.InvariantCulture);
        }

        /// <summary>Reload the list when a banner has ended or an upcoming one has opened (by the corrected clock).</summary>
        public bool NeedsRefresh(long deviceNowMs)
        {
            var now = ServerNow(deviceNowMs);
            return Rows.Any(r => (r.Banner.EndAtMs.HasValue && now >= r.Banner.EndAtMs.Value) || (r.Upcoming && r.Banner.StartAtMs.HasValue && now >= r.Banner.StartAtMs.Value));
        }

        /// <summary>Fills each row's pity meter, carry-over notice and step line from GET /v1/gacha/status.</summary>
        public void ApplyStatus(GachaStatus status)
        {
            if (status == null) return;
            foreach (var row in Rows)
            {
                var bs = status.ForBanner(row.Banner.Id);
                var g = status.ForGroup(row.Banner.PityGroup);
                if (bs != null)
                {
                    row.PityLine = "交換pt " + bs.Points.ToString(CultureInfo.InvariantCulture) + " / " + bs.Cost.ToString(CultureInfo.InvariantCulture)
                        + (bs.Remaining > 0 ? "（あと" + bs.Remaining.ToString(CultureInfo.InvariantCulture) + "回・" + bs.CoinsToExchange.ToString("N0", CultureInfo.InvariantCulture) + "コイン）" : "（交換できます）");
                    row.PityFill = bs.Cost > 0 ? Math.Min(1f, bs.Points / (float)bs.Cost) : 0f;
                    if (bs.StepUp != null)
                    {
                        row.StepLine = "ステップ " + bs.StepUp.Step.ToString(CultureInfo.InvariantCulture) + " / " + bs.StepUp.Steps.ToString(CultureInfo.InvariantCulture)
                            + " ・ 10連 " + bs.StepUp.PriceTen.ToString("N0", CultureInfo.InvariantCulture) + "コイン" + (bs.StepUp.FinalSlotMinRarity != null ? "（10枠目は" + bs.StepUp.FinalSlotMinRarity + "の表から）" : "");
                        row.PriceLine = PriceText(row.Banner, bs.StepUp);
                    }
                }
                row.CarryOverNotice = g?.CarryOver?.Notice;
            }
        }

        public static string PriceText(Banner b, StepUpProgress step)
        {
            var paid = b.PaidOnly ? "有償コインのみ ・ " : "";
            if (b.StepUp != null)
            {
                var price = step?.PriceTen ?? (b.StepUp.Prices.Length > 0 ? b.StepUp.Prices[0] : b.PriceTen);
                return paid + "10回 " + price.ToString("N0", CultureInfo.InvariantCulture) + "（10連のみ・SR以上1頭確定）";
            }
            return paid + "1回 " + b.PriceSingle.ToString("N0", CultureInfo.InvariantCulture) + " ・ 10回 " + b.PriceTen.ToString("N0", CultureInfo.InvariantCulture) + "（SR以上1頭確定）";
        }

        /// <summary>The real period: the last open minute of the end ("11月30日 23:59まで"), the start of an upcoming banner, or 常設.</summary>
        public static string PeriodText(Banner b)
        {
            if (b.Upcoming && b.StartAtMs.HasValue) return Jst(b.StartAtMs.Value) + "から";
            if (b.EndAtMs.HasValue) return Jst(b.EndAtMs.Value - 60_000) + "まで";
            return "常設";
        }

        public static string Jst(long ms)
        {
            var d = DateTimeOffset.FromUnixTimeMilliseconds(ms + JstOffsetMs).UtcDateTime;
            return d.Month.ToString(CultureInfo.InvariantCulture) + "月" + d.Day.ToString(CultureInfo.InvariantCulture) + "日 " + d.Hour.ToString(CultureInfo.InvariantCulture) + ":" + d.Minute.ToString("00", CultureInfo.InvariantCulture);
        }

        /// <summary>Message for a refused pull (the reload of the list is the caller's next step for BANNER_CLOSED).</summary>
        public static string ErrorText(ApiErrorCode code) =>
            code == ApiErrorCode.BannerClosed ? "このスカウトは終了しました（または開始前です）。一覧を更新します。"
            : code == ApiErrorCode.InsufficientCoins ? "コインが足りません"
            : code == ApiErrorCode.UnsettledDebt ? "未精算の返金があるため、スカウトできません。お問い合わせください。"
            : "スカウトできませんでした";
    }

    /// <summary>Scout screens against the server (online only; paid scouting does not exist offline).</summary>
    public sealed class GachaBackend
    {
        private readonly GameBackend _b;
        private readonly Func<long> _deviceNow;
        public GachaBackend(GameBackend backend, Func<long> deviceNowMs = null)
        {
            _b = backend ?? throw new ArgumentNullException(nameof(backend));
            _deviceNow = deviceNowMs ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        }

        public const string OfflineNotice = "OFFLINE  /  スカウトはオンラインのみ";

        /// <summary>Banner calendar with the player's pity meter applied.</summary>
        public async Task<BannerListModel> BannersAsync(CancellationToken ct = default)
        {
            if (!_b.Online) return BannerListModel.Offline(OfflineNotice);
            try
            {
                var m = new BannerListModel(await _b.Api.GetBannerScheduleAsync(ct), _deviceNow());
                try { m.ApplyStatus(await _b.Api.GetGachaStatusAsync(ct)); } catch (ApiException) { /* list without the meter */ }
                return m;
            }
            catch (ApiException e) { return BannerListModel.Offline(e.WireCode + "  /  " + e.Message); }
        }

        /// <summary>One scout; the reveal model on success, or the message (BANNER_CLOSED → reload the list).</summary>
        public async Task<(GachaRevealModel reveal, ApiErrorCode? error, string message)> DrawAsync(string bannerId, int count, Func<string, string> nameOf = null, CancellationToken ct = default)
        {
            if (!_b.Online) return (null, null, OfflineNotice);
            try
            {
                var r = await _b.Api.DrawAsync(bannerId, count, null, ct);
                await _b.RefreshAsync(ct);
                return (new GachaRevealModel(r, nameOf), null, null);
            }
            catch (ApiException e) { return (null, e.Code, BannerListModel.ErrorText(e.Code)); }
        }
    }
}
