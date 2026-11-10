using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;

namespace Muchi.Game
{
    // REQ-NEXT-001..014 次にやること (contracts/protocol.md §45). Pure C#: Codex's home binds to the public fields.
    //
    // Rules the model keeps for the home:
    //  - the server chooses the cards; offline the last list is reused (NextActionFallback: past deadlines and kinds closed
    //    today drop out, another game day = only the race card). The model never invents a card;
    //  - deadlines are real times from the server, shown as a date and time (「12月9日 03:59まで」), never a countdown, and no
    //    urgency words (「今だけ」「残りわずか」 are banned by the legal guard);
    //  - no card leads to the shop; scout_ticket (owned tickets) is a chip only;
    //  - closing a card holds for the game day (04:00 JST): kept on the device too, so it stays closed offline;
    //  - KPI next_card_view once per kind and game day, next_card_tap on every tap (dismiss is the server's event).

    /// <summary>One card ready to draw (the primary card uses every field, a chip only <see cref="ChipText"/>).</summary>
    public sealed class NextCardRow
    {
        public string Kind, Screen, FeatureKey, RefId;
        /// <summary>primary | chip (the KPI slot).</summary>
        public string Slot;
        public string Kicker, Title, Detail;
        /// <summary>「12月9日 03:59まで」 from a real deadline, or null.</summary>
        public string DeadlineText;
        /// <summary>The CTA label of the primary card (「受け取りにいく」…).</summary>
        public string CtaText;
        /// <summary>The short label of a chip (「プレゼント 2件」…).</summary>
        public string ChipText;
        public bool Dismissible;
    }

    public sealed class NextActionModel : ScreenModel
    {
        public const string KeyCache = "muchi.next.cache";
        public const string KeyClosed = "muchi.next.closed";
        public const string KeyViewed = "muchi.next.viewed";

        private readonly NowMs _now;
        private readonly Action<AnalyticsEvent> _track;

        public NextActionModel(GameBackend backend, Action<AnalyticsEvent> track = null, NowMs now = null) : base(backend, backend?.Store)
        {
            _track = track;
            _now = now ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        }

        public NextActionsView View { get; private set; }
        public NextCardRow Primary { get; private set; }
        public List<NextCardRow> Chips { get; private set; } = new List<NextCardRow>();
        /// <summary>The guide is off on the server (draw nothing).</summary>
        public bool Hidden => View != null && !View.Enabled;

        /// <summary>GET /v1/home/next; offline (or on an error) the last list through the fallback, else the bootstrap's list.</summary>
        public async Task<ActionResult> LoadAsync(CancellationToken ct = default)
        {
            Message = null;
            if (ServerAvailable)
            {
                try
                {
                    Use(await B.Api.GetNextActionsAsync(ct));
                    Online = true;
                    return ActionResult.Success();
                }
                catch (ApiException e) { Message = UxText.For(e); }
            }
            Online = false;
            var cached = NextActionsView.FromJson(Kv.Get(KeyCache)) ?? B.Player?.NextActions;
            View = NextActionFallback.Offline(cached, _now(), GameDay.Rule, ClosedToday());
            Rebuild();
            return Message == null ? ActionResult.Success() : ActionResult.Error(Message);
        }

        /// <summary>Use a list the caller already has (bootstrap's PlayerView.NextActions or a dismiss answer) and keep it for offline.</summary>
        public void Use(NextActionsView v)
        {
            if (v == null) return;
            View = v;
            Kv.Set(KeyCache, v.ToJson());
            Rebuild();
        }

        /// <summary>REQ-NEXT-005: close a card for today. Online the server answers with the next list; offline it is kept on the device.</summary>
        public async Task<ActionResult> DismissAsync(string kind, CancellationToken ct = default)
        {
            if (!NextKinds.Known(kind) || !NextKinds.Dismissible(kind)) return ActionResult.Error(UxText.Errors["NOT_ELIGIBLE"]);
            RememberClosed(kind);
            if (ServerAvailable)
            {
                try { Use(await B.Api.DismissNextActionAsync(kind, ct)); return ActionResult.Success(); }
                catch (ApiException e) { if (!GameBackend.IsTransient(e)) { Message = UxText.For(e); return ActionResult.Error(Message); } }
            }
            View = NextActionFallback.Offline(View, _now(), GameDay.Rule, ClosedToday());
            Rebuild();
            return ActionResult.Success();
        }

        /// <summary>The player tapped a card: the KPI, then the screen to open (the screen ids of §45.1).</summary>
        public string Tap(NextCardRow row)
        {
            if (row == null) return null;
            _track?.Invoke(AnalyticsEvent.NextCardTap(_now(), row.Kind, row.Slot));
            return row.Screen;
        }

        /// <summary>Call when the cards are on screen: next_card_view once per kind and game day.</summary>
        public int ReportViews()
        {
            if (_track == null) return 0;
            string day = GameDay.Key(_now());
            var stored = (Kv.Get(KeyViewed) ?? "").Split('|');
            var seen = stored.Length == 2 && stored[0] == day ? stored[1].Split(',').Where(x => x.Length > 0).ToList() : new List<string>();
            int sent = 0;
            foreach (var r in Rows())
            {
                if (seen.Contains(r.Kind)) continue;
                seen.Add(r.Kind);
                _track(AnalyticsEvent.NextCardView(_now(), r.Kind, r.Slot));
                sent++;
            }
            Kv.Set(KeyViewed, day + "|" + string.Join(",", seen));
            return sent;
        }

        private IEnumerable<NextCardRow> Rows()
        {
            if (Primary != null) yield return Primary;
            foreach (var c in Chips) yield return c;
        }

        private List<string> ClosedToday()
        {
            var stored = (Kv.Get(KeyClosed) ?? "").Split('|');
            return stored.Length == 2 && stored[0] == GameDay.Key(_now()) ? stored[1].Split(',').Where(x => x.Length > 0).ToList() : new List<string>();
        }

        private void RememberClosed(string kind)
        {
            var list = ClosedToday();
            if (!list.Contains(kind)) list.Add(kind);
            Kv.Set(KeyClosed, GameDay.Key(_now()) + "|" + string.Join(",", list));
        }

        private void Rebuild()
        {
            Primary = View?.Primary == null ? null : Row(View.Primary, "primary");
            Chips = (View?.Chips ?? new List<NextItem>()).Select(c => Row(c, "chip")).ToList();
        }

        // ------------------------------------------------------------------------------------- texts (English: ui-en.json)

        public static NextCardRow Row(NextItem i, string slot)
        {
            string n = i.Count.HasValue ? i.Count.Value.ToString("N0", CultureInfo.InvariantCulture) : "";
            var r = new NextCardRow
            {
                Kind = i.Kind, Screen = i.Screen, FeatureKey = i.FeatureKey, RefId = i.RefId, Slot = slot, Dismissible = i.Dismissible,
                Kicker = "次にやること", DeadlineText = i.DeadlineAt.HasValue ? GameDay.UntilLabel(i.DeadlineAt.Value) : null,
            };
            switch (i.Kind)
            {
                case "first_race": r.Title = "相棒で、本番のコースへ"; r.Detail = "初心者マッチに出走しよう"; r.CtaText = "出走する"; r.ChipText = "レースへ"; break;
                case "login_bonus": r.Title = "ログインボーナスを受け取れます"; r.Detail = "今日の分がまだです"; r.CtaText = "受け取りにいく"; r.ChipText = "ログインボーナス"; break;
                case "missions_claim": r.Title = "ミッションの報酬を受け取れます"; r.Detail = "達成したミッション " + n + "件"; r.CtaText = "受け取りにいく"; r.ChipText = "ミッション報酬 " + n + "件"; break;
                case "pass_claim": r.Title = "シーズンパスの報酬を受け取れます"; r.Detail = "受け取れる報酬 " + n + "段"; r.CtaText = "受け取りにいく"; r.ChipText = "パス報酬 " + n + "段"; break;
                case "gift_expiring": r.Title = "受け取り期限が近いプレゼントがあります"; r.Detail = "プレゼント " + n + "件"; r.CtaText = "プレゼントを見る"; r.ChipText = "プレゼント " + n + "件"; break;
                case "training_open": r.Title = "調教の途中です"; r.Detail = "続きから再開できます"; r.CtaText = "調教を続ける"; r.ChipText = "調教の続き"; break;
                case "missions_close": r.Title = "デイリーミッションまで あと" + n; r.Detail = "レースや調教で進みます"; r.CtaText = "ミッションを見る"; r.ChipText = "ミッション あと" + n; break;
                case "exchange_closing": r.Title = "交換所のポイントが " + n + "pt あります"; r.Detail = "残ったポイントは、閉まる時に素材になります"; r.CtaText = "交換所へ"; r.ChipText = "交換所 " + n + "pt"; break;
                case "feature_unlocked":
                    string name = i.FeatureKey != null && UnlockGate.Titles.TryGetValue(i.FeatureKey, out var t) ? t : i.FeatureKey;
                    r.Title = "新しく開きました"; r.Detail = name; r.CtaText = "開いてみる"; r.ChipText = name; break;
                case "rival_week": r.Title = "今週のライバルと、まだ走っていません"; r.Detail = "同じランク戦で先着すれば1点"; r.CtaText = "ライバルを見る"; r.ChipText = "ライバル"; break;
                case "weekly_challenge": r.Title = "週替わりチャレンジ"; r.Detail = "未クリア " + n + "つ"; r.CtaText = "挑戦する"; r.ChipText = "チャレンジ 未クリア" + n; break;
                case "team_goal_near": r.Title = "支部の共同目標、次の段まで あと" + n; r.Detail = "確定したレース結果で進みます"; r.CtaText = "共同目標を見る"; r.ChipText = "共同目標 あと" + n; break;
                case "training_slots": r.Title = "今日の調教 あと" + n + "回"; r.Detail = "タイミングよく押すと、伸びが少しだけ良くなります"; r.CtaText = "調教する"; r.ChipText = "調教 あと" + n + "回"; break;
                case "first_win": r.Title = "今日の初勝利ボーナスがあります"; r.Detail = "ランク戦の1着で受け取れます"; r.CtaText = "レースへ"; r.ChipText = "初勝利ボーナス"; break;
                case "scout_ticket": r.Title = "スカウト券 " + n + "枚"; r.Detail = "持っている券で引けます"; r.CtaText = "スカウトへ"; r.ChipText = "スカウト券 " + n + "枚"; break;
                default: r.Title = "次の1レースへ"; r.Detail = "ランク戦・約90秒"; r.CtaText = "レースへ"; r.ChipText = "レースへ"; break;
            }
            return r;
        }
    }
}
