using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;

namespace Muchi.Game
{
    // REQ-ORG-001..016 (contracts/protocol.md §44, docs/handoff-codex-round16-roster-organiser.md): 厩舎の整理, the game layer.
    // Pure C#: Codex's stable list, sort / filter sheet, search field, lock and favourite toggles, bulk selection and the
    // confirmation sheet bind to the public members. Sorting runs on the device (RosterSorter = the server's rules), so the view
    // chosen on this device is kept in the key/value store (PlayerPrefs) and works offline on the last loaded list.
    // Horse names are what players typed: shown as they are in every language (never through Loc.T).

    /// <summary>One row of the list, ready to draw.</summary>
    public sealed class RosterLine
    {
        public string HorseId;
        /// <summary>As typed; never translated.</summary>
        public string Name;
        public string Rarity;
        /// <summary>「差し / 芝 1,600–2,400m」.</summary>
        public string Meta;
        /// <summary>「能力 2,880」.</summary>
        public string RatingText;
        /// <summary>◎ ○ △ × when an aptitude course is chosen, else null.</summary>
        public string AptitudeMark;
        /// <summary>「34戦11勝」.</summary>
        public string RecordText;
        public bool Partner, Locked, Favorite, Retired, Selected, Selectable;
        /// <summary>Why it cannot be selected for a bulk retire (first reason), or null.</summary>
        public string BlockText;
    }

    /// <summary>The two-step confirmation (REQ-ORG-010): every horse, the total given back, cancel and confirm the same size.</summary>
    public sealed class BulkConfirmSheet
    {
        public sealed class Line { public string HorseId, Name, Rarity, ReasonText; public bool Ok; }
        public string Title, RefundText, Warning, CancelLabel, ConfirmLabel, RemoveRefusedLabel;
        public List<Line> Lines = new List<Line>();
        public bool CanConfirm;
        /// <summary>Always true: the two buttons are drawn the same size and neither is the default (06 UX rule, protocol §44.5).</summary>
        public bool ButtonsSameSize => true;
        public bool HasDefaultButton => false;
    }

    /// <summary>
    /// 厩舎の整理: the list (sort, filters, search, favourites first), lock / favourite, bulk selection and the bulk retire.
    /// Rules the model keeps for the screens:
    ///  - a locked horse, the first partner, a horse on loan, in training, entered in a tournament or with a ceremony not yet
    ///    seen cannot be selected (the server refuses it anyway, all or nothing);
    ///  - retiring gives nothing back; the sheet says so and that it cannot be undone; cancel and confirm are the same size;
    ///  - the confirmation is keyed: a retry after a lost response never retires twice.
    /// KPI: roster_sort when the sort or the filters change (at most once a second); roster_bulk_action is a server event.
    /// </summary>
    public sealed class RosterOrganiserModel : ScreenModel
    {
        public const string KeyView = "muchi.roster.view";
        public static readonly IReadOnlyDictionary<string, string> SortLabels = new Dictionary<string, string>
        {
            ["rating"] = "能力", ["aptitude"] = "適性", ["age"] = "年齢", ["acquired"] = "入手順", ["races"] = "出走数", ["rarity"] = "レア度", ["name"] = "名前",
        };
        public static readonly IReadOnlyDictionary<string, string> BandLabels = new Dictionary<string, string>
        {
            ["sprint"] = "短距離", ["mile"] = "マイル", ["intermediate"] = "中距離", ["long"] = "長距離",
        };
        public static readonly IReadOnlyDictionary<string, string> StyleLabels = new Dictionary<string, string>
        {
            ["nige"] = "逃げ", ["senko"] = "先行", ["sashi"] = "差し", ["oikomi"] = "追込",
        };
        public static readonly IReadOnlyDictionary<string, string> SurfaceLabels = new Dictionary<string, string> { ["turf"] = "芝", ["dirt"] = "ダート", ["both"] = "芝・ダート" };
        public static readonly IReadOnlyDictionary<string, string> ReasonTexts = new Dictionary<string, string>
        {
            [BulkReason.NotFound] = "厩舎にいない馬です",
            [BulkReason.Locked] = "ロック中",
            [BulkReason.Partner] = "最初の相棒はまとめて引退できません",
            [BulkReason.NotActive] = "もう引退しています",
            [BulkReason.OnLoan] = "種牡馬として貸し出し中",
            [BulkReason.InTraining] = "調教中",
            [BulkReason.TournamentEntry] = "大会に登録中",
            [BulkReason.HallPending] = "引退式をまだ見ていません",
        };
        public const string TextNothingBack = "返ってくるもの：なし（コイン・素材は返ってきません）";
        public const string TextCannotUndo = "引退は元に戻せません。引退した馬は繁殖馬として厩舎に残ります";
        public const string TextCancel = "やめる";
        public const string TextConfirm = "まとめて引退させる";
        public const string TextRemoveRefused = "引退できない馬を外す";
        public const string TextEmpty = "条件に合う馬はいません";
        public const string TextStale = "確認の後に厩舎が変わりました。もう一度確認してください";

        private readonly NowMs _now;
        private readonly Action<AnalyticsEvent> _track;
        private long? _lastSortKpiAt;
        private string _pendingKey;
        private readonly List<string> _selected = new List<string>();

        public RosterOrganiserModel(GameBackend backend, Action<AnalyticsEvent> track = null, NowMs now = null) : base(backend, backend?.Store)
        {
            _track = track;
            _now = now ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            Query = RosterQuery.Decode(Kv.Get(KeyView));
        }

        public RosterView View { get; private set; }
        /// <summary>The view chosen on this device (saved on every change).</summary>
        public RosterQuery Query { get; private set; }
        public bool SelectMode { get; private set; }
        public IReadOnlyList<string> Selected => _selected;
        public int BulkMax => View?.BulkMax ?? 50;
        public BulkPreview Preview { get; private set; }
        public BulkConfirmSheet Sheet { get; private set; }
        /// <summary>Ceremonies of the last bulk retire, to show one by one (then acknowledge, §34).</summary>
        public List<HallCeremony> Ceremonies { get; } = new List<HallCeremony>();

        public List<RosterRow> Rows => View == null ? new List<RosterRow>() : RosterSorter.Apply(View.Horses, Query);
        public List<RosterLine> Lines => Rows.Select(Line).ToList();
        public bool Empty => View != null && Rows.Count == 0;
        /// <summary>「42頭（現役30・引退12）」.</summary>
        public string CountText => View == null ? null : Loc.T(N(View.Total) + "頭（現役" + N(View.Active) + "・引退" + N(View.Retired) + "）");
        /// <summary>「並び：能力（高い順）」.</summary>
        public string SortText => Loc.T("並び：" + SortLabels[Query.Sort] + (Query.Dir == "asc" ? "（低い順）" : "（高い順）"));
        public string SelectedText => Loc.T(N(_selected.Count) + "頭を選択中");

        private static string N(int n) => n.ToString("#,0", CultureInfo.InvariantCulture);
        public static string Reason(string r) => r != null && ReasonTexts.TryGetValue(r, out var t) ? Loc.T(t) : Loc.T("引退できません");

        public RosterLine Line(RosterRow r) => new RosterLine
        {
            HorseId = r.HorseId, Name = r.Name, Rarity = r.Rarity,
            Meta = Loc.T(StyleLabels.TryGetValue(r.Style ?? "", out var st) ? st : r.Style) + " / " + Loc.T(SurfaceLabels.TryGetValue(r.Surface ?? "", out var sf) ? sf : r.Surface)
                + " " + N(r.DistMinM) + "–" + N(r.DistMaxM) + "m",
            RatingText = Loc.T("能力 " + N(r.Rating)),
            AptitudeMark = Query.Course != null ? RosterSorter.Aptitude(r, Query.Course).Mark : null,
            RecordText = Loc.T(N(r.Races) + "戦" + N(r.Wins) + "勝"),
            Partner = r.Partner, Locked = r.Locked, Favorite = r.Favorite, Retired = !r.IsActive,
            Selected = _selected.Contains(r.HorseId), Selectable = r.Selectable,
            BlockText = r.Blocks.Length > 0 ? Reason(r.Blocks[0]) : null,
        };

        public async Task<ActionResult> LoadAsync(CancellationToken ct = default)
        {
            Message = null;
            if (!ServerAvailable) return View == null ? Offline("厩舎の整理はオンラインで表示されます") : ActionResult.Success();
            try
            {
                View = await B.Api.GetRosterAsync(null, ct); // the whole list; sorting is local (same rules as the server)
                Online = true;
                _selected.RemoveAll(id => View.Horses.All(h => h.HorseId != id || !h.Selectable));
                return ActionResult.Success();
            }
            catch (ApiException e) { return Fail(e); }
        }

        // ---------------------------------------------------------------- view (sort / filters / search)

        private void Changed()
        {
            Kv.Set(KeyView, Query.Encode());
            long now = _now();
            if (_track != null && (_lastSortKpiAt == null || now - _lastSortKpiAt.Value >= 1000))
            {
                _lastSortKpiAt = now;
                _track(AnalyticsEvent.RosterSort(now, Query.Sort, Query.FilterCount));
            }
        }

        /// <summary>Choose a sort. Choosing the current key again flips the direction. Aptitude needs a course.</summary>
        public void SetSort(string key, RosterCourse course = null)
        {
            if (!SortLabels.ContainsKey(key)) throw new ArgumentException("unknown sort " + key);
            var q = Query.Clone();
            if (key == "aptitude") { q.Course = course ?? q.Course; if (q.Course == null) throw new ArgumentException("aptitude needs a course"); }
            q.Dir = q.Sort == key && course == null ? (q.Dir == "desc" ? "asc" : "desc") : key == "name" ? "asc" : "desc";
            q.Sort = key;
            Query = q; Changed();
        }

        /// <summary>Apply a filter change (null clears that filter). Unknown values are refused.</summary>
        public void SetFilters(Action<RosterQuery> edit)
        {
            var q = Query.Clone();
            edit(q);
            q = RosterQuery.Decode(q.Encode()); // validates every value the same way a saved view is read
            Query = q; Changed();
        }

        public void SetSearch(string text) => SetFilters(q => q.Q = text ?? "");
        public void ClearFilters() => SetFilters(q => { q.Surface = q.Band = q.Style = null; q.Status = "all"; q.Skill = q.Partner = q.Locked = q.Favorite = null; q.Q = ""; });

        // ---------------------------------------------------------------- lock / favourite

        public async Task<ActionResult> ToggleLockAsync(string horseId, CancellationToken ct = default)
        {
            var r = View?.Horses.FirstOrDefault(h => h.HorseId == horseId);
            if (r == null) return ActionResult.Error("厩舎にいない馬です");
            if (!ServerAvailable) return Offline("ロックはオンラインで変えられます");
            try
            {
                r.Locked = await B.Api.SetHorseLockAsync(horseId, !r.Locked, ct);
                await LoadAsync(ct); // the blocks change with the lock
                return ActionResult.Success(r.Locked ? "ロックしました" : "ロックを外しました");
            }
            catch (ApiException e) { return Fail(e); }
        }

        public async Task<ActionResult> ToggleFavoriteAsync(string horseId, CancellationToken ct = default)
        {
            var r = View?.Horses.FirstOrDefault(h => h.HorseId == horseId);
            if (r == null) return ActionResult.Error("厩舎にいない馬です");
            if (!ServerAvailable) return Offline("お気に入りはオンラインで変えられます");
            try { r.Favorite = await B.Api.SetHorseFavoriteAsync(horseId, !r.Favorite, ct); return ActionResult.Success(); }
            catch (ApiException e) { return Fail(e); }
        }

        // ---------------------------------------------------------------- bulk selection

        public void EnterSelectMode() { SelectMode = true; _selected.Clear(); Preview = null; Sheet = null; }
        public void ExitSelectMode() { SelectMode = false; _selected.Clear(); Preview = null; Sheet = null; }

        /// <summary>Select / unselect one row. A blocked horse is never selected; at most <see cref="BulkMax"/>.</summary>
        public bool ToggleSelect(string horseId)
        {
            if (_selected.Remove(horseId)) { Preview = null; Sheet = null; return false; }
            var r = View?.Horses.FirstOrDefault(h => h.HorseId == horseId);
            if (r == null || !r.Selectable || _selected.Count >= BulkMax) return false;
            _selected.Add(horseId); Preview = null; Sheet = null;
            return true;
        }

        /// <summary>Select every selectable row of the current view (up to the limit).</summary>
        public void SelectAllShown()
        {
            foreach (var r in Rows) if (r.Selectable && !_selected.Contains(r.HorseId) && _selected.Count < BulkMax) _selected.Add(r.HorseId);
            Preview = null; Sheet = null;
        }

        /// <summary>Step 1 → 2: ask the server what would happen (changes nothing) and build the confirmation sheet.</summary>
        public async Task<ActionResult> PreviewAsync(CancellationToken ct = default)
        {
            if (_selected.Count == 0) return ActionResult.Error("引退させる馬を選んでください");
            if (!ServerAvailable) return Offline("まとめて引退はオンラインでできます");
            try
            {
                Preview = await B.Api.PreviewBulkAsync("retire", _selected.ToList(), ct);
                _pendingKey = B.Api.NewIdempotencyKey(); // one key per confirmation: a retry never retires twice
                Sheet = BuildSheet(Preview);
                return ActionResult.Success();
            }
            catch (ApiException e) { return Fail(e); }
        }

        private BulkConfirmSheet BuildSheet(BulkPreview p)
        {
            var rows = View?.Horses.ToDictionary(h => h.HorseId) ?? new Dictionary<string, RosterRow>();
            return new BulkConfirmSheet
            {
                Title = Loc.T(N(p.Count) + "頭をまとめて引退させますか？"),
                RefundText = p.Refund.IsNothing ? Loc.T(TextNothingBack) : Loc.T("返ってくるもの：無償コイン" + N(p.Refund.FreeCoins) + "枚"),
                Warning = Loc.T(TextCannotUndo), CancelLabel = Loc.T(TextCancel), ConfirmLabel = Loc.T(TextConfirm), RemoveRefusedLabel = Loc.T(TextRemoveRefused),
                CanConfirm = p.CanConfirm,
                Lines = p.Horses.Select(h => new BulkConfirmSheet.Line
                {
                    HorseId = h.HorseId, Name = h.Name, Ok = h.Ok, Rarity = rows.TryGetValue(h.HorseId, out var r) ? r.Rarity : null,
                    ReasonText = h.Ok ? null : string.Join("・", h.Reasons.Select(Reason)),
                }).ToList(),
            };
        }

        /// <summary>Drop every refused horse from the selection and preview again.</summary>
        public async Task<ActionResult> RemoveRefusedAsync(CancellationToken ct = default)
        {
            if (Preview != null) foreach (var h in Preview.Horses.Where(x => !x.Ok)) _selected.Remove(h.HorseId);
            return _selected.Count == 0 ? ActionResult.Error("引退させる馬を選んでください") : await PreviewAsync(ct);
        }

        /// <summary>Step 2 → done: retire every selected horse (all or nothing).</summary>
        public async Task<ActionResult> ConfirmAsync(CancellationToken ct = default)
        {
            if (Preview == null || Sheet == null || !Sheet.CanConfirm) return ActionResult.Error("引退できない馬が含まれています");
            if (!ServerAvailable) return Offline("まとめて引退はオンラインでできます");
            try
            {
                var r = await B.Api.RunBulkAsync(Preview, _selected.ToList(), _pendingKey, ct);
                Ceremonies.Clear();
                Ceremonies.AddRange(r.Horses.Where(h => h.Ceremony != null).Select(h => h.Ceremony));
                ExitSelectMode();
                await LoadAsync(ct);
                return ActionResult.Success(N(r.Count) + "頭を引退させました");
            }
            catch (BulkRefusedException e)
            {
                // nothing changed: show who was refused and why
                var refused = e.Horses.ToDictionary(h => h.HorseId);
                Preview.CanConfirm = false;
                foreach (var h in Preview.Horses) if (refused.TryGetValue(h.HorseId, out var x)) { h.Ok = false; h.Reasons = x.Reasons; }
                Sheet = BuildSheet(Preview);
                return ActionResult.Error("引退できない馬が含まれています");
            }
            catch (ApiException e) when (e.Code == ApiErrorCode.RosterBulkStale)
            {
                Preview = null; Sheet = null;
                return ActionResult.Error(TextStale);
            }
            catch (ApiException e) { return Fail(e); }
        }

        public void CancelSheet() { Preview = null; Sheet = null; }
    }
}
