using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;

namespace Muchi.Game
{
    /// <summary>A tab of the phrase picker (fixed order; the label is Japanese, the view shows Loc.T(label)).</summary>
    public sealed class QuickChatTab
    {
        public string Category, Label;
        public bool Selected;
    }

    /// <summary>One phrase button of the picker.</summary>
    public sealed class QuickChatPhraseButton
    {
        public string Id, Category;
        /// <summary>The phrase in my language with the chosen values (blanks "＿＿" until chosen). From the server: show as it is.</summary>
        public string Preview;
        public bool Mention, Selected;
        /// <summary>False when a slot has nothing to choose (e.g. no time-attack record yet); <see cref="DisabledReason"/> says why.</summary>
        public bool Available;
        public string DisabledReason;
    }

    /// <summary>A slot of the selected phrase: its label and the values the server accepts.</summary>
    public sealed class QuickChatSlotPicker
    {
        public string Name, Label;
        public List<QuickChatOption> Options = new List<QuickChatOption>();
        public string ChosenRef;
    }

    /// <summary>A chat row as the screen draws it (texts built by the server or here, never by the view).</summary>
    public sealed class QuickChatRow
    {
        public long Seq;
        public string PlayerId, Name;
        /// <summary>The phrase in my language with its values (server-built; player-sourced names are never translated).</summary>
        public string Text;
        public string When;
        public bool Mine, MentionsMe, Anon;
        public List<FeedReactionCount> Reactions = new List<FeedReactionCount>();
        public string MyReaction;
        /// <summary>Others' rows can be cheered with a stamp; own and anonymous rows only show reactions.</summary>
        public bool CanCheer;
        /// <summary>Others' rows can be reported (and their authors muted) unless the author left (anonymous rows: report only).</summary>
        public bool CanMute, CanReport;
    }

    /// <summary>
    /// REQ-QCHAT-015: 支部の定型チャット (pure C#, no UnityEngine). There is no text field anywhere: the player picks a phrase
    /// (tabs by category), fills its slots from the server's options (own horses, recent races, time-attack records, cups,
    /// branch members) and sends the phrase id + the option refs.
    /// - Texts: phrases, previews and rows arrive in the request language from the server; the model only adds its own
    ///   short Japanese labels (the view passes those through Loc.T, never the server texts).
    /// - Send: one phrase per <see cref="QuickChatPicker.PostIntervalMs"/> (local cooldown; the server is the authority and
    ///   its RATE_LIMITED is shown as a sentence), not while offline / outside a branch / while the account deletion is
    ///   scheduled / after today's limit.
    /// - Blocks: the server hides rows both ways; the device mute list of the team feed (<see cref="TeamFeedModel.KeyMuted"/>)
    ///   hides them at once too. Report uses the §18 report (the §47 report centre is a later round).
    /// KPI qchat_post / qchat_react are written by the server (no client events).
    /// </summary>
    public sealed class QuickChatModel : ScreenModel
    {
        public const string KeyLastCategory = "muchi.qchat.category";
        public const int MaxRows = 100;
        public static readonly string[] Categories = { "greet", "cheer", "team", "race", "invite" };
        public static readonly IReadOnlyDictionary<string, string> CategoryLabels = new Dictionary<string, string>
        {
            ["greet"] = "あいさつ", ["cheer"] = "応援", ["team"] = "支部", ["race"] = "レース", ["invite"] = "さそう",
        };
        public static readonly IReadOnlyDictionary<string, string> SlotLabels = new Dictionary<string, string>
        {
            [QuickChatSlots.Course] = "コース", [QuickChatSlots.Horse] = "馬", [QuickChatSlots.Race] = "レース結果",
            [QuickChatSlots.Time] = "タイムアタック", [QuickChatSlots.Cup] = "カップ", [QuickChatSlots.Player] = "支部の仲間",
        };
        public const string Title = "定型チャット";
        public const string Rule = "決まった文だけで話せます（自由入力はありません）";
        public const string NotInTeam = "支部に入ると定型チャットを使えます";
        public const string EmptyText = "まだ会話はありません。あいさつから始めよう";
        public const string RateLimitedText = "定型チャットは15秒に1回、1日30回までです。同じ文は続けて送れません";
        public const string DailyLimitText = "今日の定型チャットはここまでです";
        public const string NotEligibleText = "この内容では送れません";
        public const string ChooseSlotsText = "空欄を選んでください";
        public const string NoOptionsText = "選べるものがまだありません";
        public const string CheerRateText = "少し待ってから応援してください";
        public const string ReportedText = "報告しました。ご協力ありがとうございます";

        private readonly NowMs _now;
        private long _lastPostAt = long.MinValue / 2;
        private readonly List<FeedItem> _items = new List<FeedItem>();
        private readonly Dictionary<string, string> _chosen = new Dictionary<string, string>();

        public QuickChatModel(GameBackend backend, NowMs now = null) : base(backend, backend?.Store)
        {
            _now = now ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            Category = Kv.Get(KeyLastCategory) ?? "greet";
            if (!Categories.Contains(Category)) Category = "greet";
        }

        public QuickChatPicker Picker { get; private set; }
        public string TeamId => Picker?.TeamId;
        public bool InTeam => TeamId != null;
        public string Category { get; private set; }
        public string SelectedPhraseId { get; private set; }
        public bool DeletionPending => DeletionGuard.Pending(B) || (Picker?.Deleting ?? false);

        // ------------------------------------------------------------------ picker

        public List<QuickChatTab> Tabs => Categories.Select(c => new QuickChatTab { Category = c, Label = CategoryLabels[c], Selected = c == Category }).ToList();

        public void SelectCategory(string category)
        {
            if (!Categories.Contains(category)) return;
            Category = category;
            Kv.Set(KeyLastCategory, category);
        }

        private QuickChatPhrase PhraseOf(string id) => Picker?.Phrases.FirstOrDefault(p => p.Id == id);

        /// <summary>The phrase is usable: every slot has at least one value to choose.</summary>
        public bool Available(QuickChatPhrase p) => p != null && p.Slots.All(s => Picker.OptionsFor(s).Count > 0);

        public List<QuickChatPhraseButton> Phrases => Picker == null ? new List<QuickChatPhraseButton>() : Picker.Phrases.Where(p => p.Category == Category).Select(p => new QuickChatPhraseButton
        {
            Id = p.Id, Category = p.Category, Mention = p.Mention, Selected = p.Id == SelectedPhraseId,
            Preview = p.Id == SelectedPhraseId ? Preview : p.Fill(null), Available = Available(p),
            DisabledReason = Available(p) ? null : NoOptionsText + "（" + string.Join("・", p.Slots.Where(s => Picker.OptionsFor(s).Count == 0).Select(s => SlotLabels[s])) + "）",
        }).ToList();

        public void SelectPhrase(string phraseId)
        {
            var p = PhraseOf(phraseId);
            if (p == null) return;
            if (SelectedPhraseId != phraseId) _chosen.Clear();
            SelectedPhraseId = phraseId;
            // one option only → chosen already (a single horse, the only time-attack course)
            foreach (var s in p.Slots) { var o = Picker.OptionsFor(s); if (o.Count == 1) _chosen[s] = o[0].Ref; }
        }

        public List<QuickChatSlotPicker> Slots
        {
            get
            {
                var p = PhraseOf(SelectedPhraseId);
                if (p == null) return new List<QuickChatSlotPicker>();
                return p.Slots.Select(s => new QuickChatSlotPicker { Name = s, Label = SlotLabels[s], Options = Picker.OptionsFor(s), ChosenRef = _chosen.TryGetValue(s, out var r) ? r : null }).ToList();
            }
        }

        public bool Choose(string slot, string optionRef)
        {
            var p = PhraseOf(SelectedPhraseId);
            if (p == null || !p.Slots.Contains(slot) || Picker.OptionsFor(slot).All(o => o.Ref != optionRef)) return false;
            _chosen[slot] = optionRef;
            return true;
        }

        /// <summary>The selected phrase with the chosen values (what will be posted, in my language).</summary>
        public string Preview
        {
            get
            {
                var p = PhraseOf(SelectedPhraseId);
                if (p == null) return null;
                var texts = _chosen.ToDictionary(kv => kv.Key, kv => Picker.OptionsFor(kv.Key).FirstOrDefault(o => o.Ref == kv.Value)?.Text);
                return p.Fill(texts);
            }
        }

        public long CooldownMs => Picker == null ? 0 : Math.Max(0, Math.Max(_lastPostAt + Picker.PostIntervalMs, Picker.NextPostAt) - _now());

        /// <summary>Why the send button is disabled now (null = it can be sent).</summary>
        public string SendDisabledReason
        {
            get
            {
                if (!ServerAvailable) return UxText.Offline;
                if (!InTeam) return NotInTeam;
                if (DeletionPending) return DeletionGuard.Banner(B);
                if (Picker.PostsToday >= Picker.PostsPerDay) return DailyLimitText;
                var p = PhraseOf(SelectedPhraseId);
                if (p == null) return ChooseSlotsText;
                if (!Available(p)) return NoOptionsText;
                if (p.Slots.Any(s => !_chosen.ContainsKey(s))) return ChooseSlotsText;
                if (CooldownMs > 0) return "あと" + ((CooldownMs + 999) / 1000).ToString(CultureInfo.InvariantCulture) + "秒で送れます";
                return null;
            }
        }

        // ------------------------------------------------------------------ rows

        private HashSet<string> ReadSet(string key) => new HashSet<string>((Kv.Get(key) ?? "").Split(',').Where(x => x.Length > 0));

        public List<QuickChatRow> Rows
        {
            get
            {
                var muted = ReadSet(TeamFeedModel.KeyMuted);
                var reported = ReadSet(TeamFeedModel.KeyReported);
                return _items.Where(x => x.IsQuickChat && x.QuickChat != null && (x.QuickChat.Anon || !muted.Contains(x.PlayerId)) && !reported.Contains(TeamId + ":" + x.Seq.ToString(CultureInfo.InvariantCulture)))
                    .Select(x => new QuickChatRow
                    {
                        Seq = x.Seq, PlayerId = x.PlayerId, Name = x.Mine ? "あなた" : x.DisplayName, Text = x.QuickChat.Text, When = TeamFeedModel.WhenText(x.At, _now()),
                        Mine = x.Mine, MentionsMe = x.QuickChat.MentionsMe, Anon = x.QuickChat.Anon, Reactions = x.Reactions, MyReaction = x.MyReaction,
                        CanCheer = !x.Mine, CanMute = !x.Mine && !x.QuickChat.Anon, CanReport = !x.Mine,
                    }).ToList();
            }
        }

        // ------------------------------------------------------------------ load / actions

        public async Task<ActionResult> LoadAsync(CancellationToken ct = default)
        {
            Message = null; Online = false;
            if (!ServerAvailable) { Message = UxText.Offline; return ActionResult.Error(Message); }
            try
            {
                Picker = await B.Api.GetQuickChatAsync(ct);
                _items.Clear();
                if (Picker.TeamId != null)
                {
                    var page = await B.Api.GetTeamFeedAsync(null, null, ct);
                    _items.AddRange(page.Items);
                }
                if (SelectedPhraseId != null && PhraseOf(SelectedPhraseId) == null) { SelectedPhraseId = null; _chosen.Clear(); }
                Online = true;
                return ActionResult.Success();
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
            catch (NotFoundException e) when (e.Code == ApiErrorCode.NotInTeam) { _items.Clear(); Online = true; return ActionResult.Success(); }
            catch (ApiException e) { Message = UxText.For(e); return ActionResult.Error(Message); }
        }

        public async Task<ActionResult> SendAsync(CancellationToken ct = default)
        {
            var why = SendDisabledReason;
            if (why != null) return ActionResult.Error(Message = why);
            var p = PhraseOf(SelectedPhraseId);
            var slots = p.Slots.ToDictionary(s => s, s => _chosen[s]);
            _lastPostAt = _now(); // the cooldown starts now even if the call fails (no double taps)
            try
            {
                var r = await B.Api.PostQuickChatAsync(p.Id, slots, ct);
                _items.Insert(0, new FeedItem
                {
                    Seq = r.Seq, At = r.At, Kind = "qchat", PlayerId = B.Player?.Id, DisplayName = B.Player?.DisplayName ?? "", Mine = true,
                    QuickChat = new FeedQuickChat { PhraseId = p.Id, Category = p.Category, Text = Preview, Mention = p.Mention },
                });
                if (_items.Count > MaxRows) _items.RemoveAt(_items.Count - 1);
                Picker.PostsToday++;
                if (p.Mention) Picker.MentionsToday++;
                _chosen.Clear();
                SelectedPhraseId = null;
                Message = null;
                return ActionResult.Success();
            }
            catch (RateLimitedException) { Message = RateLimitedText; return ActionResult.Error(Message); }
            catch (ApiException e) when (e.Code == ApiErrorCode.NotEligible) { Message = NotEligibleText; return ActionResult.Error(Message); }
            catch (ApiException e) { Message = UxText.For(e); return ActionResult.Error(Message); }
        }

        /// <summary>Cheer a phrase with a stamp (one per row; the same stamp again takes it back).</summary>
        public async Task<ActionResult> CheerAsync(long seq, string stampId, CancellationToken ct = default)
        {
            var it = _items.FirstOrDefault(x => x.Seq == seq);
            if (it == null || !it.IsQuickChat || it.Mine) return ActionResult.Error("not a teammate's phrase");
            if (!ServerAvailable) return Offline("chat");
            if (DeletionPending) return ActionResult.Error(Message = DeletionGuard.Banner(B));
            string next = it.MyReaction == stampId ? null : stampId;
            try
            {
                var mine = await B.Api.ReactToFeedItemAsync(seq, next, ct);
                var old = it.MyReaction == null ? null : it.Reactions.FirstOrDefault(r => r.StampId == it.MyReaction);
                if (old != null) { old.Count--; old.Mine = false; if (old.Count <= 0) it.Reactions.Remove(old); }
                if (mine != null)
                {
                    var c = it.Reactions.FirstOrDefault(r => r.StampId == mine);
                    if (c == null) it.Reactions.Add(c = new FeedReactionCount { StampId = mine });
                    c.Count++; c.Mine = true;
                }
                it.MyReaction = mine;
                return ActionResult.Success();
            }
            catch (RateLimitedException) { Message = CheerRateText; return ActionResult.Error(Message); }
            catch (ApiException e) { Message = UxText.For(e); return ActionResult.Error(Message); }
        }

        /// <summary>Report a phrase (§18 report; hidden locally at once). The §47 report centre takes the same target later.</summary>
        public async Task<ActionResult> ReportAsync(long seq, FeedReportReason reason, CancellationToken ct = default)
        {
            var it = _items.FirstOrDefault(x => x.Seq == seq);
            if (it == null || it.Mine || !it.IsQuickChat) return ActionResult.Error("cannot report this row");
            var rep = ReadSet(TeamFeedModel.KeyReported);
            rep.Add(TeamId + ":" + seq.ToString(CultureInfo.InvariantCulture));
            Kv.Set(TeamFeedModel.KeyReported, string.Join(",", rep.Skip(Math.Max(0, rep.Count - 200))));
            if (!ServerAvailable) return Offline("report");
            try { await B.Api.ReportFeedItemAsync(seq, reason, ct); return ActionResult.Success(ReportedText); }
            catch (ApiException e) { Message = UxText.For(e); return ActionResult.Error(Message); }
        }
    }
}
