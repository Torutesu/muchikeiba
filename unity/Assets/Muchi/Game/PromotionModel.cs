using System;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;

namespace Muchi.Game
{
    // REQ-PROMO-001..020 (contracts/protocol.md §68, docs/handoff-codex-round22-promotion.md): 昇級戦と降級の猶予, the game layer.
    // Pure C#: the server decides everything from verified ranked results; this model only reads GET /v1/promotion and turns it
    // into what the home, the result screen and the outcome sheet show. Codex calls RefreshAsync on the home, AfterRankedResultAsync
    // when a ranked result screen opens, and CloseOutcomeAsync when the sheet is closed. The outcome sheet goes through the
    // session's one-prompt gate (§58.11): when another prompt already showed this session, the result screen shows the outcome
    // inline only and the sheet waits for the home of a later session. No push / local notification, nothing for sale.

    public sealed class PromotionModel : ScreenModel
    {
        public const string KeyCache = "muchi.promotion.view";
        public const string StartBanner = "昇級戦 開始";
        public const string StartLead = "昇級ラインに到達。ここからが本番だ";
        public const string PassKicker = "PROMOTION";
        public const string FailKicker = "PROMOTION SERIES";
        public const string CloseLabel = "閉じる";
        public const string RulesLabel = "昇級戦のルール";

        public PromotionModel(GameBackend backend, IKeyValueStore kv = null) : base(backend, kv ?? backend?.Store) { }

        /// <summary>R22 integration (§58.11): the session's ONE prompt mechanism (the same instance every model gets); the outcome sheet is `promotion_outcome`.</summary>
        public SessionPrompts Prompts { get; set; }
        public PromotionView View { get; private set; }

        /// <summary>The result screen's banner when this race started a series (「昇級戦 開始」), else null.</summary>
        public string ResultBanner { get; private set; }
        /// <summary>The outcome sheet is up (passed / failed). Codex draws it; close with <see cref="CloseOutcomeAsync"/>.</summary>
        public bool OutcomeSheetVisible { get; private set; }
        /// <summary>The outcome as one line inside the result screen (always set when decided by this race).</summary>
        public string OutcomeInline { get; private set; }

        public string HomeLabel => PromotionPips.HomeLabel(View);
        public string GraceLabel => PromotionPips.GraceLabel(View);
        public string Marks => PromotionPips.Marks(View?.Series);
        public string RuleLine => PromotionPips.RuleLine(View?.Series);
        public string OutcomeTitle => PromotionPips.OutcomeTitle(View);
        public string OutcomeBody => PromotionPips.OutcomeBody(View);
        public bool Passed => View?.Series?.Passed == true;

        /// <summary>GET /v1/promotion (offline: the last copy, so the home still says 「昇級戦 2/3」).</summary>
        public async Task<ActionResult> RefreshAsync(CancellationToken ct = default)
        {
            if (!ServerAvailable) { LoadCache(); return Offline("promotion"); }
            try
            {
                View = await B.Api.GetPromotionAsync(ct);
                Online = true;
                SaveCache();
                return ActionResult.Success();
            }
            catch (ApiException e) { LoadCache(); return Fail(e); }
        }

        /// <summary>REQ-PROMO-017: a ranked result screen opened. Sets the start banner, the pips and the outcome (sheet or inline).</summary>
        public async Task<ActionResult> AfterRankedResultAsync(CancellationToken ct = default)
        {
            string before = View?.Series?.Id;
            ResultBanner = null; OutcomeInline = null;
            var r = await RefreshAsync(ct);
            if (!r.Ok) return r;
            var x = View?.Series;
            if (!View.Enabled || x == null) return r;
            if (x.Active && x.Results.Count == 0 && x.Id != before) ResultBanner = StartBanner;
            if (x.OutcomePending)
            {
                OutcomeInline = OutcomeTitle;
                TryShowSheet();
            }
            return r;
        }

        /// <summary>On the home: an outcome whose sheet could not show earlier (the gate was taken) shows now if it may.</summary>
        public bool TryShowSheet()
        {
            if (OutcomeSheetVisible) return true;
            if (View?.Series == null || !View.Series.OutcomePending) return false;
            if (Prompts != null && !Prompts.TryClaim(SessionPrompts.PromotionOutcome)) return false;
            OutcomeSheetVisible = true;
            return true;
        }

        /// <summary>REQ-PROMO-014: the sheet was closed — mark it seen (idempotent; offline it shows again next time).</summary>
        public async Task<ActionResult> CloseOutcomeAsync(CancellationToken ct = default)
        {
            OutcomeSheetVisible = false;
            var id = View?.Series?.Id;
            if (id == null) return ActionResult.Success();
            if (!ServerAvailable) return Offline("promotion ack");
            try
            {
                await B.Api.AckPromotionAsync(id, ct);
                View.Series.Seen = true;
                SaveCache();
                return ActionResult.Success();
            }
            catch (ApiException e) { return Fail(e); }
        }

        private void SaveCache()
        {
            var s = View?.Series;
            Kv.Set(KeyCache, View == null ? null : (View.Enabled ? "1" : "0") + "|" + (s?.Id ?? "") + "|" + (s?.Status ?? "") + "|" + (s?.Next?.ToString() ?? "") + "|" + (s?.Races ?? 0) + "|" + string.Join(",", s?.Pips ?? new System.Collections.Generic.List<string>()));
        }

        private void LoadCache()
        {
            if (View != null) return;
            var raw = Kv.Get(KeyCache);
            if (string.IsNullOrEmpty(raw)) return;
            var p = raw.Split('|');
            if (p.Length < 6) return;
            View = new PromotionView { Enabled = p[0] == "1" };
            if (p[1].Length == 0) return;
            View.Series = new PromotionSeries
            {
                Id = p[1], Status = p[2], Next = int.TryParse(p[3], out var n) ? (int?)n : null, Races = int.TryParse(p[4], out var rc) ? rc : 0,
                Pips = new System.Collections.Generic.List<string>(p[5].Length == 0 ? new string[0] : p[5].Split(',')), Seen = true,
            };
        }
    }
}
