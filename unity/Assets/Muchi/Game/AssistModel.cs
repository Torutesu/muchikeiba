using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;

namespace Muchi.Game
{
    // かんたん操作 (easy controls, REQ-ASSIST-001..012, contracts/protocol.md §27, docs/handoff-codex-round12-easy-controls.md).
    // Pure C# (no UnityEngine). The assist itself is Muchi.Client.InputAssistant: it only sends the normal input bytes,
    // so races, replays and results are unchanged. This model is the setting (3 levels, saved on the server, default off),
    // the one-time suggestion sheet after 3 last places in a row, the HUD indicator and attaching the assist to a race.

    /// <summary>One option of the Settings row.</summary>
    public sealed class AssistOption
    {
        public AssistLevel Level;
        public string Label, Description;
        public bool Selected;
    }

    /// <summary>The one-time suggestion sheet (no pressure: a calm offer, "not now" is as big as the others).</summary>
    public sealed class AssistPromptSheet
    {
        public string Kicker = AssistModel.TextKicker;
        public string Title = AssistModel.TextPromptTitle;
        public string Body = AssistModel.TextPromptBody;
        public string Note = AssistModel.TextPolicy;
        public List<AssistOption> Options = new List<AssistOption>();
        public string DismissLabel = AssistModel.TextNotNow;
    }

    public sealed class AssistModel : ScreenModel
    {
        /// <summary>Last known level on this device (offline races, before the first server answer).</summary>
        public const string KeyLevel = "muchi.assist.level";

        public const string TextKicker = "かんたん操作";
        public const string TextTitle = "かんたん操作";
        public const string TextDescOff = "自分で全部操作します";
        public const string TextDescWhip = "ムチのタイミングだけ自動。スタート・手綱・進路は自分で";
        public const string TextDescFull = "スタート・手綱・進路・ムチを自動で。上手な操作よりは控えめです";
        public const string TextPolicy = "ランク戦でも使えます。上手な操作より強くはなりません。相手には表示されません。";
        public const string TextTutorial = "はじめてのレースでは使えません";
        public const string TextPromptTitle = "かんたん操作を試してみませんか？";
        public const string TextPromptBody = "ムチのタイミングや手綱をおまかせできます。いつでも設定で戻せます。";
        public const string TextNotNow = "今はいい";
        public const string TextSaved = "かんたん操作を変更しました";
        public const string TextOffline = "かんたん操作の変更はオンラインで保存されます";

        public AssistModel(GameBackend backend, IKeyValueStore store = null) : base(backend, store ?? backend?.Store) { }

        public AssistSettings Settings { get; private set; }
        public AssistLevel Level => B.AssistLevel;
        /// <summary>The HUD indicator text for the current level (null when off).</summary>
        public string HudLabel => AssistLevels.HudLabel(Level);

        /// <summary>The Settings row: three options, the current one selected.</summary>
        public List<AssistOption> Options => OptionsFor(Level);

        public static List<AssistOption> OptionsFor(AssistLevel current) => new List<AssistOption>
        {
            new AssistOption { Level = AssistLevel.Off, Label = Loc.T(AssistLevels.TextOff), Description = Loc.T(TextDescOff), Selected = current == AssistLevel.Off },
            new AssistOption { Level = AssistLevel.Whip, Label = Loc.T(AssistLevels.TextWhip), Description = Loc.T(TextDescWhip), Selected = current == AssistLevel.Whip },
            new AssistOption { Level = AssistLevel.Full, Label = Loc.T(AssistLevels.TextFull), Description = Loc.T(TextDescFull), Selected = current == AssistLevel.Full },
        };

        /// <summary>
        /// REQ-ASSIST-010: show the sheet now? Only when the server says it is due (3 last places in a row, assist off, not
        /// shown before), never in the FTUE / tutorial, and only on a calm screen (the result screen's way back home).
        /// </summary>
        public bool ShouldShowPrompt(bool inFtue) => !inFtue && Settings != null && Settings.PromptDue && Level == AssistLevel.Off;

        public AssistPromptSheet Prompt()
        {
            var s = new AssistPromptSheet { Kicker = Loc.T(TextKicker), Title = Loc.T(TextPromptTitle), Body = Loc.T(TextPromptBody), Note = Loc.T(TextPolicy), DismissLabel = Loc.T(TextNotNow) };
            s.Options.AddRange(OptionsFor(AssistLevel.Off).FindAll(o => o.Level != AssistLevel.Off));
            return s;
        }

        /// <summary>Loads the setting (GET /v1/player/assist). Offline keeps the device's last level.</summary>
        public async Task<ActionResult> LoadAsync(CancellationToken ct = default)
        {
            Message = null;
            if (!ServerAvailable) { Settings = new AssistSettings { Level = Level }; return ActionResult.Success(); }
            try
            {
                Settings = await B.Api.GetAssistAsync(ct);
                Online = true;
                B.AssistLevel = Settings.Level;
                return ActionResult.Success();
            }
            catch (ApiException e) { Message = UxText.For(e); return ActionResult.Error(Message); }
        }

        /// <summary>
        /// Saves a level (Settings row or the sheet). The next race uses it at once; a race in progress keeps the level it
        /// started with. Offline the choice is kept on the device and is saved with the next successful call.
        /// </summary>
        public async Task<ActionResult> SetAsync(AssistLevel level, AssistSource source = AssistSource.Settings, CancellationToken ct = default)
        {
            B.AssistLevel = level;
            if (!ServerAvailable) { Settings = new AssistSettings { Level = level }; return ActionResult.Success(TextOffline); }
            try
            {
                Settings = await B.Api.SetAssistAsync(level, source, ct);
                Online = true;
                B.AssistLevel = Settings.Level;
                return ActionResult.Success(TextSaved);
            }
            catch (ApiException e) { Message = UxText.For(e); return ActionResult.Error(Message); }
        }

        /// <summary>Call when the sheet is put on screen (once). Then either <see cref="SetAsync"/> with Prompt, or nothing for 「今はいい」.</summary>
        public async Task<ActionResult> MarkPromptShownAsync(CancellationToken ct = default)
        {
            if (Settings != null) Settings.PromptDue = false; // never twice on this device, even if the call fails
            if (!ServerAvailable) return ActionResult.Success();
            try { Settings = await B.Api.MarkAssistPromptSeenAsync(ct); return ActionResult.Success(); }
            catch (ApiException e) { Message = UxText.For(e); return ActionResult.Error(Message); }
        }

        /// <summary>
        /// Attaches the assist to a race driver (practice / ranked / friend / event). Off attaches nothing. The tutorial
        /// is refused by the client itself (REQ-ASSIST-006). Online the slot is known only after "start", so the
        /// assistant is created then.
        /// </summary>
        public static IRaceDriver Attach(IRaceDriver d, AssistLevel level)
        {
            if (d == null || level == AssistLevel.Off) return d;
            if (d is OfflineRaceDriver o)
            {
                if (o.PlayerSlot >= 0 && AssistLevels.AllowedIn(o.Config.Mode)) o.Race.Assistant = new InputAssistant(level, o.PlayerSlot);
            }
            else if (d is OnlineRaceDriver on)
            {
                var s = on.Session;
                if (s.Client.Config != null && s.Slot >= 0) s.Assistant = new InputAssistant(level, s.Slot);
                else s.RaceStarted += started => { if (started.Slot >= 0 && !started.Client.IsSpectator) started.Assistant = new InputAssistant(level, started.Slot); };
            }
            return d;
        }

        /// <summary>The level that rides this race (Off in the tutorial, for spectators or without an assist).</summary>
        public static AssistLevel RidingLevel(IRaceDriver d)
        {
            if (d is OfflineRaceDriver o) return o.Race.EffectiveAssist;
            if (d is OnlineRaceDriver on) return on.Session.EffectiveAssist;
            return AssistLevel.Off;
        }
    }
}
