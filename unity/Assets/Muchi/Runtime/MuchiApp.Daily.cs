using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Muchi.Game;
using Muchi.Unity;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.UI;

namespace Muchi.Client
{
    // U1-A: the daily loop (docs/quality/unity-daily.md) — home, 目標, 調教 (choose / play / result), 機能, クラスの階段 and the
    // one claim moment. Every rectangle and every sentence comes from Muchi.Game.DailyLayout (audited by GameChecks
    // DailyScreensChecks: inside 1600×900, no text overlap, body ≥ 16 px, fits, one CTA), and every figure from the models
    // (GoalLadderModel, NextActionModel.HomeLine, TrainingModel, HomeModel, ProfileModel). This file only draws the boxes with
    // the screen kit and maps their actions to screens; it holds no text of its own (a check keeps it that way).
    public sealed partial class MuchiApp
    {
        GoalLadderModel dailyGoals;
        NextActionModel dailyNext;
        TrainingModel dailyTraining;
        HomeModel dailyHome;
        float dailyHomeAt = -99, dailyGoalsAt = -99, dailyTrainingAt = -99;
        string dailyMenu;
        object dailyStageShown;
        bool dailyBusy;
        const float DailyReloadSeconds = 3f;

        static readonly Color DailyOk = new Color(.45f, .9f, .6f);
        static readonly Color DailyWarn = new Color(1f, .58f, .3f);
        static readonly Color DailyDim = new Color(.4f, .47f, .55f);

        void DailyModels()
        {
            if (dailyGoals != null) return;
            NowMs now = () => MuchiServices.NowMs;
            dailyGoals = new GoalLadderModel(backend, now);
            dailyNext = new NextActionModel(backend, MuchiServices.Track, now);
            dailyTraining = new TrainingModel(backend);
            dailyHome = new HomeModel(backend, MuchiServices.Track, now);
        }

        /// <summary>The kit's language toggle switches LocaleService; the game layer's Loc follows it here.</summary>
        void DailyLocale()
        {
            string want = LocaleService.IsJapanese ? "ja" : "en";
            if (Loc.Current != want) MuchiServices.SetLanguage(want);
        }

        static string DailyT(string ja) => Loc.T(ja);

        bool DailyStale(ref float at)
        {
            if (Time.realtimeSinceStartup - at < DailyReloadSeconds) return false;
            at = Time.realtimeSinceStartup;
            return true;
        }

        async void DailyLoad(Func<Task> load, Action redraw, Action screen)
        {
            try { await load(); } catch (Exception e) { Debug.LogWarning("daily load: " + e.Message); }
            if (!inRace && currentScreen == screen) redraw();
        }

        // ============================================================================================= drawing

        Color DailyTone(string tone)
        {
            switch (tone)
            {
                case "soft": return KitSoft;
                case "muted": return KitMuted;
                case "dim": return DailyDim;
                case "cyan": return cyan;
                case "gold": return gold;
                case "ok": return DailyOk;
                case "warn": return DailyWarn;
                case "line": return new Color(1, 1, 1, .14f);
                default: return Color.white;
            }
        }

        static TextAnchor DailyAnchor(string align) => align == "right" ? TextAnchor.UpperRight : align == "center" ? TextAnchor.UpperCenter : TextAnchor.UpperLeft;

        /// <summary>Draws a DailyLayout screen with the kit; returns the drawn objects by box id (the play screen animates some).</summary>
        Dictionary<string, GameObject> DailyDraw(ScreenLayout l, Action<string> act)
        {
            var drawn = new Dictionary<string, GameObject>();
            var chrome = l["language"];
            if (chrome != null && languageButton != null)
            {
                var rt = (RectTransform)languageButton.transform;
                rt.anchoredPosition = new Vector2(chrome.X, -chrome.Y);
                rt.sizeDelta = new Vector2(chrome.W, chrome.H);
            }
            foreach (var b in l.Boxes)
            {
                var go = DailyBox(b, act);
                if (go != null) drawn[b.Id] = go;
            }
            if (languageButton != null) languageButton.transform.SetAsLastSibling();
            return drawn;
        }

        GameObject DailyBox(LayoutBox b, Action<string> act)
        {
            Action tap = b.Action == null ? (Action)null : () => act(b.Action);
            switch (b.Kind)
            {
                case LayoutKind.Card:
                {
                    var rt = Card(b.Id, b.X, b.Y, b.W, b.H);
                    var img = rt.GetComponent<Image>();
                    if (b.Disabled) img.color = new Color(KitPanel.r, KitPanel.g, KitPanel.b, .5f);
                    if (b.Selected) { var o = rt.gameObject.AddComponent<Outline>(); o.effectColor = cyan; o.effectDistance = new Vector2(2, -2); }
                    if (tap != null) rt.gameObject.AddComponent<Button>().onClick.AddListener(() => tap());
                    return rt.gameObject;
                }
                case LayoutKind.Hit:
                {
                    var p = Panel(b.Id, b.X, b.Y, b.W, b.H, new Color(0, 0, 0, 0));
                    if (tap != null) p.gameObject.AddComponent<Button>().onClick.AddListener(() => tap());
                    return p.gameObject;
                }
                case LayoutKind.Kicker:
                {
                    var k = Kicker(DailyT(b.Text), b.X, b.Y, b.W);
                    k.horizontalOverflow = HorizontalWrapMode.Overflow;
                    return k.gameObject;
                }
                case LayoutKind.Text:
                case LayoutKind.Link:
                {
                    var t = Body(DailyT(b.Text), b.X, b.Y, b.W, b.H, b.Size, DailyTone(b.Tone));
                    t.alignment = DailyAnchor(b.Align);
                    if (b.Size >= 22 || b.Kind == LayoutKind.Link) t.fontStyle = FontStyle.Bold;
                    if (!b.Wrap) t.horizontalOverflow = HorizontalWrapMode.Overflow; // one line: never wraps onto the row below
                    if (b.Kind == LayoutKind.Link && tap != null)
                    {
                        t.raycastTarget = true;
                        var btn = t.gameObject.AddComponent<Button>();
                        btn.targetGraphic = t;
                        btn.onClick.AddListener(() => tap());
                    }
                    return t.gameObject;
                }
                case LayoutKind.Gauge:
                {
                    var track = Panel(b.Id, b.X, b.Y, b.W, b.H, new Color(1, 1, 1, .14f));
                    if (b.Fill > 0) Panel(b.Id + " / fill", 0, 0, b.W * b.Fill, b.H, DailyTone(b.Tone), track.transform);
                    return track.gameObject;
                }
                case LayoutKind.Pips:
                {
                    var row = Rect(b.Id, safe, b.X, b.Y, b.W, b.H);
                    float pitch = b.Count > 0 ? b.W / b.Count : 0;
                    for (int i = 0; i < b.Count; i++)
                    {
                        var pip = Panel(b.Id + " / " + i, i * pitch, 0, pitch - 4, b.H, i < b.On ? gold : new Color(1, 1, 1, i == b.On ? .05f : .16f), row);
                        if (i == b.On) { var o = pip.gameObject.AddComponent<Outline>(); o.effectColor = cyan; o.effectDistance = new Vector2(1, -1); }
                    }
                    return row.gameObject;
                }
                case LayoutKind.Rule:
                    return Panel(b.Id, b.X, b.Y, b.W, b.H, DailyTone(b.Tone)).gameObject;
                case LayoutKind.Cta:
                {
                    var c = Cta(DailyT(b.Text), b.X, b.Y, b.W, () => { if (tap != null && !b.Disabled) tap(); });
                    if (b.Disabled) { c.interactable = false; c.GetComponent<Image>().color = new Color(cyan.r, cyan.g, cyan.b, .35f); }
                    return c.gameObject;
                }
                case LayoutKind.Ghost:
                    return Ghost(DailyT(b.Text), b.X, b.Y, b.W, () => tap?.Invoke()).gameObject;
                default:
                    return null; // Chrome: the app's own language button, only moved
            }
        }

        /// <summary>A short note at the top centre that leaves by itself (errors, a locked row).</summary>
        void DailyToast(string text)
        {
            if (string.IsNullOrEmpty(text)) return;
            var c = Card("Daily toast", 450, 36, 700, 64);
            var t = Body(DailyT(text), 24, 18, 652, 30, 18, Color.white, c);
            t.alignment = TextAnchor.UpperCenter;
            Destroy(c.gameObject, 2.6f);
        }

        /// <summary>Where a step / 次にやること / menu action leads (DailyLayout.ScreenFor names the Unity screen).</summary>
        void DailyOpen(string target)
        {
            switch (target)
            {
                case "home": Home(); break;
                case "goals": DailyGoals(); break;
                case "training": DailyTraining(); break;
                case "features": DailyFeatures(); break;
                case "class_ladder": DailyClassLadder(); break;
                case "race": Entry(); break;
                case "stable": Stable(); break;
                case "scout": Scout(); break;
                case "wardrobe": Wardrobe(); break;
                case "course": CourseThemes(); break;
                case "conditions": Conditions(); break;
                case "care": Care(); break;
                case "pass": SeasonPass(); break;
                case "shop": storeTab = 0; Store(); break;
                // TODO(U1 merge): stream C's horse card (MuchiApp.Raising.cs) — the cap link and the partner plate open it
                case "partner_card": case "cap_card": Stable(); break;
                default: DailyToast(DailyLayout.NotYet); break;
            }
        }

        // ============================================================================================= home

        void Home()
        {
            currentScreen = Home;
            DailyLocale();
            DailyModels();
            if (DailyStale(ref dailyHomeAt)) DailyLoadHome();
            DailyHomeDraw();
        }

        async void DailyLoadHome()
        {
            string toast = null;
            try
            {
                await dailyHome.LoadAsync(GoalLadderModel.ItemName); // the day's login bonus is received automatically (a toast)
                toast = dailyHome.Toast;
                await dailyGoals.LoadAsync();
                await dailyNext.LoadAsync();
                if (dailyHome.Unlocks.IsUnlocked("training") && dailyTraining.Phase == TrainingPhase.Choose) await dailyTraining.LoadAsync();
            }
            catch (Exception e) { Debug.LogWarning("home load: " + e.Message); }
            if (inRace || currentScreen != (Action)Home) return;
            DailyHomeDraw();
            dailyNext.ReportViews();
            DailyToast(toast);
        }

        void DailyHomeDraw()
        {
            Clear();
            SetArt("Art/home-paddock");
            var p = backend.Profile();
            if (p.Online) horseName = p.PartnerName;
            var unlocks = dailyHome.Unlocks;
            var layout = DailyLayout.Home(new DailyHomeInput
            {
                Goals = dailyGoals, Next = dailyNext.Home, Profile = p, Online = backend.Online,
                TrainingSlotsLeft = dailyTraining.Enabled ? dailyTraining.SlotsLeft : (int?)null,
                TrainingLock = unlocks.IsUnlocked("training") ? null : unlocks.LockLabel("training"),
                Horses = p.HorseCount, Features = DailyLayout.FeatureRows.Length, ModeLabel = ModeLabel,
            });
            DailyDraw(layout, DailyHomeAct);
        }

        void DailyHomeAct(string a)
        {
            switch (a)
            {
                case "training_locked": DailyToast(dailyHome.Unlocks.LockLabel("training")); break;
                case "next":
                {
                    var row = dailyNext.Home;
                    var screen = dailyNext.Tap(row);
                    DailyOpen(screen == "feature" ? DailyLayout.ScreenFor(row?.FeatureKey) : DailyLayout.ScreenFor(screen));
                    break;
                }
                case "next_dismiss":
                {
                    var row = dailyNext.Home;
                    if (row == null || dailyBusy) return;
                    dailyBusy = true;
                    RunDaily(() => dailyNext.DismissAsync(row.Kind), DailyHomeDraw, Home);
                    break;
                }
                default: DailyOpen(a); break;
            }
        }

        async void RunDaily(Func<Task<ActionResult>> action, Action redraw, Action screen)
        {
            ActionResult r = null;
            try { r = await action(); } catch (Exception e) { Debug.LogWarning("daily action: " + e.Message); }
            dailyBusy = false;
            if (inRace || currentScreen != screen) return;
            redraw();
            if (r != null && !r.Ok) DailyToast(r.Message);
        }

        // ============================================================================================= 目標 and the claim moment

        void DailyGoals()
        {
            currentScreen = DailyGoals;
            DailyLocale();
            DailyModels();
            if (DailyStale(ref dailyGoalsAt)) DailyLoad(() => dailyGoals.LoadAsync(), DailyGoalsDraw, DailyGoals);
            DailyGoalsDraw();
        }

        void DailyGoalsDraw()
        {
            Clear();
            SetArt("Art/home-paddock");
            Panel("Goals veil", 0, 0, 1600, 900, new Color(.01f, .035f, .07f, .35f));
            DailyDraw(DailyLayout.Goals(dailyGoals, backend.Profile(), MuchiServices.NowMs), DailyGoalsAct);
        }

        void DailyGoalsAct(string a)
        {
            if (a == "claim") { DailyClaim(DailyGoalsDraw, DailyGoals); return; }
            if (a.StartsWith("step:", StringComparison.Ordinal)) { DailyOpen(DailyLayout.ScreenFor(a.Substring(5))); return; }
            DailyOpen(a);
        }

        /// <summary>The one claim: every claimable goal at once, then the Moment — what arrived and tomorrow's reason.</summary>
        async void DailyClaim(Action redraw, Action screen)
        {
            if (dailyBusy) return;
            dailyBusy = true;
            ActionResult r = null;
            try { r = await dailyGoals.ClaimAllAsync(); } catch (Exception e) { Debug.LogWarning("goals claim: " + e.Message); }
            dailyBusy = false;
            if (inRace || currentScreen != screen) return;
            redraw();
            if (r == null || !r.Ok) { DailyToast(r?.Message); return; }
            Moment(DailyT(dailyGoals.ClaimMomentKicker), DailyT(dailyGoals.ClaimMomentHeadline), DailyT(dailyGoals.ClaimMomentLine), null, "OK", null);
        }

        void DailyClassLadder()
        {
            currentScreen = DailyClassLadder;
            DailyModels();
            Clear();
            SetArt("Art/home-paddock");
            Panel("Ladder veil", 0, 0, 1600, 900, new Color(.01f, .035f, .07f, .35f));
            DailyDraw(DailyLayout.ClassLadder(dailyGoals, backend.Profile()), DailyOpen);
        }

        void DailyFeatures()
        {
            currentScreen = DailyFeatures;
            Clear();
            SetArt("Art/home-paddock");
            DailyDraw(DailyLayout.Features(backend.Profile()), DailyOpen);
        }

        // ============================================================================================= 調教

        /// <summary>Opens 調教 with this horse selected (the horse card's 「調教する」).</summary>
        void DailyTrainingFor(string horseId)
        {
            DailyModels();
            if (!string.IsNullOrEmpty(horseId)) MuchiServices.Store.Set(TrainingModel.KeyHorse, horseId);
            dailyTraining.SelectHorse(horseId);
            dailyMenu = null;
            dailyTrainingAt = -99;
            DailyTraining();
        }

        // U1 merge with unity/raising: MuchiApp.Raising.cs holds the defining declaration
        // `partial void RaisingOpenTraining(string horseId, ref bool opened);`. A partial implementation cannot compile on this
        // branch without it, so after the merge add here:
        //   partial void RaisingOpenTraining(string horseId, ref bool opened) { DailyTrainingFor(horseId); opened = true; }

        void DailyTraining()
        {
            currentScreen = DailyTraining;
            DailyLocale();
            DailyModels();
            if (DailyStale(ref dailyTrainingAt) && dailyTraining.Phase != TrainingPhase.Result)
                DailyLoad(() => dailyTraining.LoadAsync(), DailyTrainingRoute, DailyTraining);
            DailyTrainingRoute();
        }

        /// <summary>The choose screen, or the result when a session left open was just settled on load.</summary>
        void DailyTrainingRoute()
        {
            if (dailyTraining.Phase == TrainingPhase.Result) { DailyTrainingResult(); return; }
            Clear();
            SetArt("Art/home-paddock");
            Panel("Training veil", 0, 0, 1600, 900, new Color(.01f, .035f, .07f, .35f));
            DailyDraw(DailyLayout.Training(dailyTraining, backend.Profile(), dailyMenu, MuchiServices.NowMs), DailyTrainingAct);
        }

        void DailyTrainingAct(string a)
        {
            var t = dailyTraining;
            if (a.StartsWith("menu:", StringComparison.Ordinal)) { dailyMenu = a.Substring(5); DailyTrainingRoute(); return; }
            if (a.StartsWith("menu_blocked:", StringComparison.Ordinal)) { DailyToast(t.Cards.FirstOrDefault(c => c.Id == a.Substring(13))?.BlockedText); return; }
            switch (a)
            {
                case "next_horse":
                {
                    var hs = t.View.Horses;
                    int i = hs.FindIndex(h => h.HorseId == t.HorseId);
                    t.SelectHorse(hs[(i + 1) % hs.Count].HorseId);
                    dailyMenu = null;
                    DailyTrainingRoute();
                    break;
                }
                case "start": DailyTrainingStart(); break;
                case "treat": DailyTreat(); break;
                case "item": RunDaily(() => t.UseItemAsync(), DailyTrainingRoute, DailyTraining); break;
                default: DailyOpen(a); break;
            }
        }

        async void DailyTrainingStart()
        {
            if (dailyBusy || dailyMenu == null) return;
            dailyBusy = true;
            ActionResult r = null;
            try { r = await dailyTraining.StartAsync(dailyMenu); } catch (Exception e) { Debug.LogWarning("training start: " + e.Message); }
            dailyBusy = false;
            if (inRace || currentScreen != (Action)DailyTraining) return;
            if (r != null && r.Ok) DailyTrainingPlay();
            else { DailyTrainingRoute(); DailyToast(r?.Message); }
        }

        /// <summary>REQ-ITEM-010: the treat when it matters — given here, then its Moment with the numbers it changed.</summary>
        async void DailyTreat()
        {
            var t = dailyTraining;
            if (dailyBusy || t.Horse?.Treat == null) return;
            string name = t.Horse.Treat.Name, line = t.TreatLine;
            dailyBusy = true;
            ActionResult r = null;
            try { r = await t.UseItemAsync(); } catch (Exception e) { Debug.LogWarning("treat: " + e.Message); }
            dailyBusy = false;
            if (inRace || currentScreen != (Action)DailyTraining) return;
            DailyTrainingRoute();
            if (r == null || !r.Ok) { DailyToast(r?.Message); return; }
            Moment(DailyT(name), DailyT(line), r.Message, "Art/Food/oats-apple", "OK", null);
        }

        // ---- the timing mini-game: the server's beats slide onto the line; 「追う」 (or Space) as each one arrives

        static long DailyClockMs => (long)(Time.realtimeSinceStartupAsDouble * 1000);
        void DailyNoScreen() { } // the language toggle mid-game changes the text from the next screen on

        void DailyTrainingPlay()
        {
            var t = dailyTraining;
            currentScreen = DailyNoScreen;
            Clear();
            SetArt("Art/first-ride");
            bool finishing = false;
            var drawn = DailyDraw(DailyLayout.TrainingPlay(t), a =>
            {
                if (a == "skip" && !finishing) { finishing = true; t.Skip(); DailyTrainingFinish(); }
            });
            var judge = drawn["judge"].GetComponent<Text>();
            var score = drawn["score"].GetComponent<Text>();
            var beats = t.Session?.Beats ?? new int[0];
            var marks = beats.Select((b, i) => Panel("Beat " + i, -100, DailyLayout.LaneY + 36, DailyLayout.BeatSize, DailyLayout.BeatSize, cyan)).ToArray();
            void Tap()
            {
                var j = t.Tap(DailyClockMs);
                if (j == null) return;
                judge.text = DailyLayout.JudgeText(j);
                score.text = DailyLayout.ScoreText(t.LiveScore);
            }
            drawn["whip"].AddComponent<DailyPress>().Pressed = Tap;
            float readyAt = Time.realtimeSinceStartup + .9f;
            var tick = new GameObject("Daily ticker", typeof(RectTransform)).AddComponent<DailyTicker>();
            tick.transform.SetParent(safe, false);
            tick.Tick = () =>
            {
                if (finishing) return;
                long now = DailyClockMs;
                if (t.Phase == TrainingPhase.Ready && Time.realtimeSinceStartup >= readyAt) { t.BeginMiniGame(now); judge.text = ""; }
                if (t.Phase != TrainingPhase.Playing) return;
                if (Input.GetKeyDown(KeyCode.Space)) Tap();
                int e = t.Elapsed(now);
                for (int i = 0; i < marks.Length; i++)
                {
                    float x = DailyLayout.LaneX + DailyLayout.HitLineX - DailyLayout.BeatSize / 2 + (beats[i] - e) * .22f;
                    bool inLane = x > DailyLayout.LaneX && x < DailyLayout.LaneX + DailyLayout.LaneW - DailyLayout.BeatSize;
                    marks[i].rectTransform.anchoredPosition = new Vector2(x, -(DailyLayout.LaneY + 36));
                    marks[i].enabled = inLane;
                    marks[i].color = Math.Abs(beats[i] - e) <= t.View.Timing.GoodMs ? gold : cyan;
                }
                if (t.MiniGameOver(now)) { finishing = true; DailyTrainingFinish(); }
            };
        }

        async void DailyTrainingFinish()
        {
            ActionResult r = null;
            try { r = await dailyTraining.FinishAsync(); } catch (Exception e) { Debug.LogWarning("training finish: " + e.Message); }
            if (inRace) return;
            currentScreen = DailyTraining;
            if (dailyTraining.Phase == TrainingPhase.Result) DailyTrainingResult();
            else { dailyTrainingAt = -99; DailyTraining(); DailyToast(r?.Message); }
        }

        void DailyTrainingResult()
        {
            currentScreen = DailyTraining;
            DailyTrainingResultDraw();
            // the training goal may be done now: the claim button appears once the ladder says so
            DailyLoad(() => dailyGoals.LoadAsync(), DailyTrainingResultDraw, DailyTraining);
        }

        void DailyTrainingResultDraw()
        {
            var t = dailyTraining;
            if (t.Phase != TrainingPhase.Result) { DailyTrainingRoute(); return; }
            Clear();
            SetArt("Art/home-paddock");
            DailyDraw(DailyLayout.TrainingResult(t, dailyGoals.View != null && dailyGoals.View.Claimable > 0), DailyResultAct);
            if (t.StageUp && !ReferenceEquals(dailyStageShown, t.Result))
            {
                dailyStageShown = t.Result;
                Moment(DailyT(DailyLayout.StageMomentKicker), DailyT(t.StageText), DailyT(t.StageMomentLine), PartnerPreview(EquippedPartner), "OK", null);
            }
        }

        void DailyResultAct(string a)
        {
            switch (a)
            {
                case "continue": dailyTraining.Continue(); dailyMenu = null; dailyTrainingAt = -99; DailyTraining(); break;
                case "claim": DailyClaim(DailyTrainingResultDraw, DailyTraining); break;
                default: DailyOpen(a); break;
            }
        }
    }

    /// <summary>Calls <see cref="Tick"/> every frame while its screen is up (destroyed with the screen by Clear).</summary>
    public sealed class DailyTicker : MonoBehaviour
    {
        public Action Tick;
        void Update() => Tick?.Invoke();
    }

    /// <summary>Fires on touch-down (not release): the timing mini-game measures the press.</summary>
    public sealed class DailyPress : MonoBehaviour, IPointerDownHandler
    {
        public Action Pressed;
        public void OnPointerDown(PointerEventData e) => Pressed?.Invoke();
    }
}
