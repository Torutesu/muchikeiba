using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;

namespace Muchi.Game
{
    // REQ-RECAP-001..016 (contracts/protocol.md §43, docs/handoff-codex-round16-season-recap.md): シーズンの振り返り, the game layer.
    // Pure C#: Codex's full-screen step-through binds to the public fields. The server builds the recap from confirmed data and
    // writes every line; the model pages through it, reports open / complete, keeps the 「順位を隠す」 choice and builds the share
    // cards through the existing ShareCard path.

    /// <summary>One row of the profile's recap list.</summary>
    public sealed class RecapRow
    {
        public string Id, Title;
        public bool IsYear, Short, IsNew;
    }

    /// <summary>The page on screen: a small letter-spaced label, the big text (number / class / time / horse name) and notes.</summary>
    public sealed class RecapPage
    {
        public string Key, Label;
        /// <summary>The big text: the value, or the horse name on the horse page (never translated). Null on list pages / the end.</summary>
        public string BigText;
        /// <summary>"戦" / "races" next to the big number, else null.</summary>
        public string Unit;
        /// <summary>The big text is a player-typed horse name (Loc.T must not touch it).</summary>
        public bool BigTextIsName;
        public List<string> Notes = new List<string>();
        /// <summary>Hall page: the inducted horses' names (as typed).</summary>
        public List<string> HorseNames = new List<string>();
        /// <summary>Moments page: "シーズン初勝利（…）" lines with the horse name (null when none).</summary>
        public List<(string Text, string HorseName)> Moments = new List<(string, string)>();
        public bool IsEnd => Key == "end";
    }

    /// <summary>
    /// シーズンの振り返り. Rules the model keeps for the screens:
    ///  - the recap opens at page 1 and reports "open" once; reaching the last page (or 「最後まで」) reports "complete" once.
    ///    Both are idempotent on the server, so a failed report is simply sent again next time;
    ///  - a short recap (little activity) has few pages but is never empty;
    ///  - 「順位を隠す」 is remembered on the device and drops every rank card from the share set;
    ///  - reduced motion: <see cref="ReducedMotion"/> is the hook for the accessibility setting (§41, Round 15 — not on this
    ///    base yet). When it answers true, pages cut instead of sliding and numbers do not count up.
    /// KPI: recap_open / recap_complete are server events; recap_share (<see cref="Shared"/>) when a card goes to the OS share sheet.
    /// </summary>
    public sealed class SeasonRecapModel : ScreenModel
    {
        public const string KeyHideRank = "muchi.recap.hideRank";
        public const string TextTitle = "シーズンの振り返り";
        public const string TextEmpty = "振り返りは、シーズンが終わるとここに届きます";
        public const string TextNext = "次へ";
        public const string TextBack = "戻る";
        public const string TextSkip = "最後まで";
        public const string TextShare = "共有する";
        public const string TextHideRank = "順位を隠す";
        public const string TextPrivacy = "共有カードに入るのは、あなたの馬の名前と数字だけです";
        public const string TextNew = "NEW";
        public const string TextYearBadge = "1年";

        /// <summary>
        /// §41 hook: the accessibility setting "reduce motion" (Round 15). Defaults to the OS preference the Unity side passes in;
        /// false until then.
        /// </summary>
        public static Func<bool> ReducedMotion = () => false;
        /// <summary>Page transition length (0 = cut) and the big number's count-up length (0 = shown at once).</summary>
        public int TransitionMs => ReducedMotion() ? 0 : 420;
        public int CountUpMs => ReducedMotion() ? 0 : 900;

        private readonly NowMs _now;
        private readonly Action<AnalyticsEvent> _track;

        public SeasonRecapModel(GameBackend backend, Action<AnalyticsEvent> track = null, NowMs now = null) : base(backend, backend?.Store)
        {
            _track = track;
            _now = now ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        }

        public List<RecapRow> Rows { get; } = new List<RecapRow>();
        /// <summary>The profile badge: a recap nobody opened yet.</summary>
        public bool HasNew { get; private set; }
        public bool Enabled { get; private set; }
        public RecapView View { get; private set; }
        public List<RecapPage> Pages { get; } = new List<RecapPage>();
        public int Index { get; private set; }
        public RecapPage Current => Index >= 0 && Index < Pages.Count ? Pages[Index] : null;
        public bool CanBack => Index > 0;
        public bool AtEnd => Pages.Count > 0 && Index == Pages.Count - 1;
        /// <summary>"3 / 9" under the page.</summary>
        public string PositionText => Pages.Count == 0 ? "" : (Index + 1) + " / " + Pages.Count;
        public bool OpenReported { get; private set; }
        public bool CompleteReported { get; private set; }

        public bool HideRank
        {
            get => Kv.Get(KeyHideRank) == "1";
            set => Kv.Set(KeyHideRank, value ? "1" : "0");
        }

        /// <summary>REQ-RECAP-010: the list (newest first).</summary>
        public async Task<ActionResult> LoadListAsync(CancellationToken ct = default)
        {
            if (!ServerAvailable) return Offline(TextTitle);
            try
            {
                var l = await B.Api.GetRecapsAsync(ct);
                Enabled = l.Enabled;
                Rows.Clear();
                foreach (var r in l.Recaps) Rows.Add(new RecapRow { Id = r.Id, Title = r.Title, IsYear = r.IsYear, Short = r.Short, IsNew = !r.Opened });
                HasNew = l.Unseen != null;
                Message = Rows.Count == 0 ? TextEmpty : null;
                Online = true;
                return ActionResult.Success();
            }
            catch (ApiException e) { Message = UxText.For(e); return ActionResult.Error(Message); }
        }

        /// <summary>Opens a recap at page 1 and reports "open".</summary>
        public async Task<ActionResult> OpenAsync(string recapId, CancellationToken ct = default)
        {
            if (!ServerAvailable) return Offline(TextTitle);
            try
            {
                View = await B.Api.GetRecapAsync(recapId, ct);
                Pages.Clear();
                Pages.AddRange(View.Steps.Select(ToPage));
                Index = 0;
                OpenReported = View.OpenedAt.HasValue;
                CompleteReported = View.CompletedAt.HasValue;
                Online = true;
            }
            catch (ApiException e) { Message = UxText.For(e); return ActionResult.Error(Message); }
            await ReportAsync("open", ct);
            if (AtEnd) await ReportAsync("complete", ct); // a one-page recap is complete when opened
            return ActionResult.Success();
        }

        public static RecapPage ToPage(RecapStep s)
        {
            var p = new RecapPage { Key = s.Key, Label = s.Label, Unit = s.Unit, Notes = new List<string>(s.Notes), HorseNames = new List<string>(s.HorseNames) };
            if (s.Value != null) p.BigText = s.Value;
            else if (s.HorseName != null) { p.BigText = s.HorseName; p.BigTextIsName = true; }
            foreach (var mo in s.Moments) p.Moments.Add((mo.Text, mo.HorseName));
            // a time attack page has both: the time is big, the horse goes in the notes as typed
            if (s.Value != null && s.HorseName != null) p.Notes.Insert(0, s.HorseName);
            return p;
        }

        public async Task NextAsync(CancellationToken ct = default)
        {
            if (Index < Pages.Count - 1) Index++;
            if (AtEnd) await ReportAsync("complete", ct);
        }

        public void Back() { if (Index > 0) Index--; }

        /// <summary>「最後まで」: jump to the last page (counts as complete).</summary>
        public async Task SkipToEndAsync(CancellationToken ct = default)
        {
            if (Pages.Count == 0) return;
            Index = Pages.Count - 1;
            await ReportAsync("complete", ct);
        }

        private async Task ReportAsync(string step, CancellationToken ct)
        {
            if (View == null || (step == "open" ? OpenReported : CompleteReported)) return;
            try
            {
                var p = await B.Api.RecapProgressAsync(View.Id, step, ct);
                OpenReported = p.OpenedAt.HasValue;
                CompleteReported = p.CompletedAt.HasValue;
            }
            catch (ApiException) { /* idempotent on the server: reported again the next time the recap is opened */ }
        }

        /// <summary>REQ-RECAP-011: the share set (the ShareCard path), without rank cards when <see cref="HideRank"/> is on.</summary>
        public List<ShareCard> ShareCards() => View == null ? new List<ShareCard>() : RecapShare.Build(View, HideRank);

        /// <summary>recap_share: the card ("recap_summary" … from <see cref="ShareCard.Kind"/>) went to the OS share sheet.</summary>
        public void Shared(ShareCard card)
        {
            if (View == null || card == null || !card.Kind.StartsWith("recap_", StringComparison.Ordinal)) return;
            _track?.Invoke(AnalyticsEvent.RecapShare(_now(), View.Kind, card.Kind.Substring("recap_".Length), HideRank));
        }
    }
}
