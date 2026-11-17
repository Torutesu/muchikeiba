using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Muchi.Client;
using Muchi.Game;
using Muchi.Unity;
using UnityEngine;
using UnityEngine.UI;

namespace Muchi.Client
{
    // U1 raising screens (docs/quality/unity-raising.md): 馬カード, 配合, 仔馬のお披露目, 血統 (minimal) and the race result on the
    // ruleset 1.4 rules. Every rectangle comes from Muchi.Game.RaisingLayout (audited by GameChecks RaisingScreenChecks); every
    // line comes from a game-layer model (HorseProfileModel, BreedingModel, PedigreeModel, RaceResultModel, PromotionModel,
    // ResultRewards / ResultLines / ResultPromotionPlan). Nothing here computes a reward, a chance or a rule.
    // Japanese is the source text: RaisingTr gives the English from ui-en.json when the player switched to English.
    public sealed partial class MuchiApp
    {
        // ---- state of the raising screens (prefixed: the other U1 streams add their own partial files)
        HorseProfileModel raisingProfile;
        string raisingHorseId;
        Action raisingBack;
        BreedingModel raisingBreeding;
        string raisingSireKey, raisingDamId;
        PedigreeModel raisingPedigree;
        string raisingPedigreeHorse;
        Action raisingPedigreeBack;
        ResultRewards raisingRewardsBefore = new ResultRewards();
        PromotionModel raisingPromotion;
        // TODO(U1 merge): one session prompt gate for the whole app (§58.11) once a shared one exists; the promotion sheet uses this.
        readonly SessionPrompts raisingPrompts = new SessionPrompts();
        bool raisingSettling, raisingSettled, raisingPromoPopupDone;

        static readonly Color RaisingDim = new Color(.38f, .46f, .55f);
        static readonly Color RaisingTrack = new Color(1, 1, 1, .12f);

        /// <summary>
        /// Stream A (Training) implements this to open its training screen for <paramref name="horseId"/> and sets
        /// <paramref name="opened"/>; until then the horse card's 「調教する」 opens Care.
        /// </summary>
        partial void RaisingOpenTraining(string horseId, ref bool opened);

        // ------------------------------------------------------------------------------------------- drawing helpers

        /// <summary>The text in the player's language (Japanese source; English from ui-en.json through Loc's catalog).</summary>
        static string RaisingTr(string ja) => ja == null || LocaleService.IsJapanese ? ja : Loc.English.Translate(ja) ?? ja;

        RectTransform RaisingCard(RaisingLayout.Screen l, string id)
        { var b = l[id]; return Card(l.Name + " / " + id, b.X, b.Y, b.W, b.H); }

        Image RaisingBar(RaisingLayout.Box b, Color color, float fraction = 1f)
        { return Panel(b.Id, b.X, b.Y, Mathf.Max(0, b.W * Mathf.Clamp01(fraction)), b.H, color); }

        Text RaisingLine(RaisingLayout.Screen l, string id, string ja, Color? color = null, TextAnchor align = TextAnchor.UpperLeft)
        {
            if (string.IsNullOrEmpty(ja)) return null;
            var b = l[id];
            var t = b.Size >= 22 ? Label(RaisingTr(ja), b.X, b.Y, b.W, b.H, b.Size, color ?? Color.white) : Body(RaisingTr(ja), b.X, b.Y, b.W, b.H, b.Size, color);
            t.alignment = align;
            return t;
        }

        Text RaisingKicker(RaisingLayout.Screen l, string id, string ja) { var b = l[id]; return Kicker(RaisingTr(ja), b.X, b.Y, b.W); }
        Button RaisingCta(RaisingLayout.Screen l, string ja, Action go) { var b = l["cta"]; return Cta(RaisingTr(ja), b.X, b.Y, b.W, go); }
        Button RaisingGhost(RaisingLayout.Screen l, string id, string ja, Action go) { var b = l[id]; return Ghost(RaisingTr(ja), b.X, b.Y, b.W, go); }
        void RaisingNote(RaisingLayout.Screen l) { if (!string.IsNullOrEmpty(screenNote) && l.Has("note")) RaisingLine(l, "note", screenNote, KitMuted); }

        // ------------------------------------------------------------------------------------------- 馬カード

        /// <summary>Opens the horse card of <paramref name="horseId"/> (null: the partner); BACK returns to <paramref name="back"/>.</summary>
        void OpenHorseCard(string horseId, Action back)
        {
            raisingHorseId = horseId ?? backend.Profile().PartnerId;
            raisingBack = back ?? Stable;
            currentScreen = null;
            HorseCard();
        }

        void HorseCard()
        {
            if (currentScreen != (Action)HorseCard)
            {
                screenNote = null; raisingProfile = new HorseProfileModel(backend);
                currentScreen = HorseCard;
                var id = raisingHorseId;
                if (id != null) LoadScreenModel(async () => { var r = await raisingProfile.LoadAsync(id); if (!r.Ok) screenNote = r.Message; }, HorseCard);
            }
            Clear(); SetArt("Art/partner-naming");
            var l = RaisingLayout.HorseCard();
            var m = raisingProfile; var p = m?.Profile;
            RaisingCard(l, "growthCard"); RaisingCard(l, "storyCard");
            RaisingGhost(l, "back", RaisingText.Back, () => (raisingBack ?? Stable)());
            if (p == null)
            {
                RaisingKicker(l, "kicker", HorseProfileModel.Title);
                RaisingLine(l, "rules", raisingHorseId == null || !backend.Online ? HorseProfileModel.OfflineText : screenNote ?? "…", KitSoft);
                return;
            }
            // ① growth
            RaisingKicker(l, "kicker", HorseProfileModel.Title + "　/　" + m.GenerationText);
            RaisingLine(l, "name", p.Name);
            RaisingLine(l, "rarity", p.Rarity + "　·　" + PedigreeModel.StyleText(p.Style) + "　·　" + (p.Surface == "dirt" ? "ダート" : p.Surface == "turf" ? "芝" : "芝・ダート") + " " + p.DistMinM.ToString("N0") + "〜" + p.DistMaxM.ToString("N0") + "m", gold);
            if (m.StageText != null)
            {
                RaisingLine(l, "stageLabel", RaisingText.StageLabel, KitMuted, TextAnchor.UpperRight);
                RaisingLine(l, "stage", m.StageText, Color.white, TextAnchor.UpperRight);
                RaisingBar(l["stageBar"], RaisingTrack); RaisingBar(l["stageBar"], cyan, m.StageProgress);
                RaisingLine(l, "next", m.NextStageText, KitSoft, TextAnchor.UpperRight);
            }
            RaisingBar(l["rule"], KitLine);
            RaisingLine(l, "statsLabel", RaisingText.Stats, KitMuted);
            int cap = p.Growth?.PerStatCap ?? 0;
            if (cap > 0) RaisingLine(l, "trainedLabel", RaisingText.Trained, KitMuted, TextAnchor.UpperRight);
            for (int i = 0; i < m.Bars.Count && i < 5; i++)
            {
                var s = m.Bars[i]; string k = "stat" + i;
                RaisingLine(l, k + ".name", s.Name + (s.Leaning ? "　·　得意" : ""), s.Leaning ? cyan : Color.white);
                RaisingLine(l, k + ".value", s.ValueText, Color.white, TextAnchor.UpperRight);
                var bar = l[k + ".bar"];
                Panel(k + " track", bar.X, bar.Y, bar.W, bar.H, RaisingTrack);
                Panel(k + " base", bar.X, bar.Y, bar.W * s.BaseRatio, bar.H, KitSoft);
                Panel(k + " awakening", bar.X + bar.W * s.BaseRatio, bar.Y, bar.W * s.AwakeningRatio, bar.H, new Color(0, .55f, .7f));
                Panel(k + " trained", bar.X + bar.W * (s.BaseRatio + s.AwakeningRatio), bar.Y, bar.W * s.TrainedRatio, bar.H, cyan);
                if (cap > 0)
                {
                    RaisingBar(l[k + ".meter"], RaisingTrack); RaisingBar(l[k + ".meter"], cyan, s.Trained / (float)cap);
                    RaisingLine(l, k + ".trained", s.TrainedText ?? "+0", s.TrainedText != null ? cyan : RaisingDim, TextAnchor.UpperRight);
                }
            }
            RaisingLine(l, "total", m.TotalText);
            RaisingLine(l, "potential", m.PotentialText, Color.white, TextAnchor.UpperRight);
            RaisingLine(l, "ranked", m.RankedText, KitMuted);
            RaisingLine(l, "leaning", m.LeaningText, cyan);
            RaisingLine(l, "rules", HorseProfileModel.RulesText, KitSoft);
            // ② the story
            RaisingKicker(l, "careerKicker", RaisingText.Career);
            var career = (m.CareerText ?? "").Split('・');
            RaisingLine(l, "career", career[0]);
            if (career.Length > 1) RaisingLine(l, "extra", string.Join("・", career.Skip(1)), KitSoft);
            RaisingKicker(l, "lineageKicker", RaisingText.Lineage);
            RaisingGhost(l, "pedigree", RaisingText.PedigreeLink, () => OpenPedigree(p.HorseId, HorseCard));
            var lin = p.Lineage;
            RaisingLine(l, "generation", m.GenerationText + (lin.Bred ? "" : RaisingText.Scouted));
            RaisingLine(l, "parents", "父 " + (lin.SireName ?? "—") + (lin.StudSire ? RaisingText.StudSire : "") + "　·　母 " + (lin.DamName ?? "—"), KitMuted);
            RaisingLine(l, "skill", m.SkillOriginText, cyan);
            RaisingLine(l, "atavism", m.AtavismText, KitSoft);
            RaisingKicker(l, "trainingKicker", RaisingText.RecentTraining);
            if (p.RecentTraining.Count == 0) RaisingLine(l, "log0.grade", RaisingText.NoTraining, RaisingDim);
            for (int i = 0; i < p.RecentTraining.Count && i < 3; i++)
            {
                var e = p.RecentTraining[i];
                RaisingLine(l, "log" + i + ".grade", TrainingModel.GradeTexts.TryGetValue(e.Grade ?? "", out var g) ? g : e.Grade, KitSoft);
                RaisingLine(l, "log" + i + ".gain", e.Gain > 0 ? "+" + e.Gain : "±0", e.Gain > 0 ? cyan : RaisingDim, TextAnchor.UpperRight);
            }
            if (p.Status == "active")
                RaisingCta(l, RaisingText.Train, () => { bool opened = false; RaisingOpenTraining(p.HorseId, ref opened); if (!opened) Care(); });
            else RaisingCta(l, RaisingText.ToBreeding, () => { currentScreen = null; Breeding(); });
            RaisingNote(l);
        }

        // ------------------------------------------------------------------------------------------- 配合

        void Breeding()
        {
            if (currentScreen != (Action)Breeding)
            {
                screenNote = null; raisingBreeding = new BreedingModel(backend, backend.Store);
                currentScreen = Breeding;
                LoadScreenModel(RaisingLoadBreeding, Breeding);
            }
            Clear(); SetArt("Art/home-paddock");
            var l = RaisingLayout.Breeding();
            var m = raisingBreeding;
            RaisingLine(l, "title", m?.Preview?.Today != null ? RaisingText.BreedingTitle + "　/　" + m.TodayLine : RaisingText.BreedingTitle);
            RaisingLine(l, "steps", RaisingText.BreedingSteps, KitSoft);
            RaisingCard(l, "parentsCard"); RaisingCard(l, "outlookCard"); RaisingCard(l, "giftsCard");
            RaisingGhost(l, "back", RaisingText.Back, Stable);
            // ① parents: three of each, the selected one framed, each with its aim against the other chosen parent
            var sires = m?.Sires.Take(3).Select(c => (key: c.Key, name: c.Name, rarity: c.Rarity, style: c.Style)).ToList() ?? new List<(string, string, string, string)>();
            var dams = m?.Dams.Take(3).Select(h => (key: h.Id, name: h.Name, rarity: h.Rarity, style: h.Style)).ToList() ?? new List<(string, string, string, string)>();
            RaisingParents(l, "sire", RaisingText.SireTitle, sires, m?.Sire?.Key, key => { raisingSireKey = key; RaisingReselect(); });
            RaisingParents(l, "dam", RaisingText.DamTitle, dams, m?.Dam?.Id, key => { raisingDamId = key; RaisingReselect(); });
            if (m != null && (m.Sires.Count == 0 || m.Dams.Count == 0)) RaisingLine(l, "noPair", RaisingText.NoPair, KitMuted);
            // ② the outlook
            RaisingKicker(l, "outlookKicker", RaisingText.Outlook);
            var v = m?.Preview;
            if (v == null) RaisingLine(l, "compat", RaisingText.ChooseParents, KitMuted);
            else
            {
                RaisingLine(l, "compat", m.CompatibilityText, v.Nick ? cyan : Color.white);
                for (int i = 0; i < HorseProfile.StatOrder.Length; i++)
                {
                    var k = HorseProfile.StatOrder[i];
                    if (!v.Stats.TryGetValue(k, out var r)) continue;
                    RaisingLine(l, "range" + i + ".name", TrainingModel.StatNames.TryGetValue(k, out var n) ? n : k);
                    var t = l["range" + i + ".track"];
                    Panel(t.Id, t.X, t.Y, t.W, t.H, RaisingTrack);
                    float a = Mathf.InverseLerp(400, 1000, r.Min), z = Mathf.InverseLerp(400, 1000, r.Max);
                    Panel(t.Id + " band", t.X + t.W * a, t.Y - 3, Mathf.Max(4, t.W * (z - a)), t.H + 6, cyan);
                    RaisingLine(l, "range" + i + ".value", r.Min + "〜" + r.Max, KitMuted);
                }
                RaisingLine(l, "rangeNote", RaisingText.RangeNote, KitSoft);
                if (m.RarityOddsText != null)
                {
                    RaisingKicker(l, "oddsKicker", RaisingText.OddsTitle);
                    var bar = l["oddsBar"];
                    float x = bar.X;
                    foreach (var (part, color) in new[] { (v.Rarity.R, KitSoft), (v.Rarity.SR, cyan), (v.Rarity.SSR, gold) })
                    {
                        float w = bar.W * part / 1_000_000f;
                        if (w > 0) Panel("odds", x, bar.Y, w, bar.H, color);
                        x += w;
                    }
                    RaisingLine(l, "odds", m.RarityOddsText);
                    RaisingLine(l, "oddsNote", RaisingText.OddsNote, KitSoft);
                }
                RaisingLine(l, "distance", m.DistanceText, KitMuted);
            }
            // ③ what each parent passes on; the one CTA
            RaisingKicker(l, "giftsKicker", RaisingText.Gifts);
            if (v != null && m.Sire != null && m.Dam != null)
            {
                var lines = new List<string> { "父　" + m.Sire.Name };
                lines.AddRange(m.ParentGifts("sire"));
                lines.Add("母　" + m.Dam.Name);
                lines.AddRange(m.ParentGifts("dam"));
                lines.AddRange(m.AtavismLines().Take(2));
                RaisingLine(l, "gifts", string.Join("\n", lines.Select(RaisingTr)), KitSoft);
                var sireId = m.Sire.IsStud ? null : m.Sire.HorseId; var damId = m.Dam.Id;
                if (sireId != null) RaisingGhost(l, "sirePedigree", RaisingText.SirePedigree, () => OpenPedigree(sireId, Breeding));
                RaisingGhost(l, "damPedigree", RaisingText.DamPedigree, () => OpenPedigree(damId, Breeding));
                var go = RaisingCta(l, RaisingText.Breed, () => RaisingBreed(m.NormalLeft <= 0));
                go.interactable = m.CanBreed;
                RaisingLine(l, "today", m.FeeLine ?? m.TodayLine, KitSoft);
            }
            RaisingLine(l, "legal", RaisingText.BreedingLegal, KitSoft);
            RaisingNote(l);
        }

        void RaisingParents(RaisingLayout.Screen l, string who, string title, List<(string key, string name, string rarity, string style)> list, string selected, Action<string> pick)
        {
            RaisingKicker(l, who + "Kicker", title);
            if (raisingBreeding != null && list.Count == 0) { RaisingLine(l, who + "0.name", RaisingText.NoRetired, RaisingDim); return; }
            for (int i = 0; i < list.Count; i++)
            {
                var c = list[i]; string id = who + i;
                var card = RaisingCard(l, id + ".card");
                var outline = card.gameObject.AddComponent<Outline>();
                outline.effectColor = c.key == selected ? cyan : new Color(1, 1, 1, .15f); outline.effectDistance = new Vector2(2, -2);
                var key = c.key;
                card.gameObject.AddComponent<Button>().onClick.AddListener(() => pick(key));
                RaisingLine(l, id + ".name", c.name);
                RaisingLine(l, id + ".rarity", c.rarity + "　" + PedigreeModel.StyleText(c.style), gold, TextAnchor.UpperRight);
                RaisingLine(l, id + ".aim", raisingBreeding.AimLine(who, c.key), raisingBreeding.AimIsUp(who, c.key) ? cyan : KitMuted);
            }
        }

        async Task RaisingLoadBreeding()
        {
            var m = raisingBreeding;
            await m.LoadAsync();
            if (m.Message != null) screenNote = m.Message;
            await RaisingSelect(m);
        }

        async Task RaisingSelect(BreedingModel m)
        {
            var sire = m.Sires.FirstOrDefault(s => s.Key == raisingSireKey) ?? m.Sires.FirstOrDefault();
            var dam = m.Dams.FirstOrDefault(h => h.Id == raisingDamId) ?? m.Dams.FirstOrDefault();
            if (sire != null) m.SelectSire(sire.Key);
            if (dam != null) m.SelectDam(dam.Id);
            if (m.Sire == null || m.Dam == null) return;
            var r = await m.PreviewAsync();
            if (!r.Ok) screenNote = r.Message;
            await m.LoadAimsAsync();
        }

        void RaisingReselect() { var m = raisingBreeding; if (m != null) LoadScreenModel(() => RaisingSelect(m), Breeding); Breeding(); }

        async void RaisingBreed(bool useMaterial)
        {
            var m = raisingBreeding;
            if (m == null) return;
            ActionResult r;
            try { r = await m.BreedAsync(useMaterial); } catch (Exception e) { r = ActionResult.Error(e.Message); }
            if (!r.Ok || m.Reveal == null) { screenNote = r.Message; if (currentScreen == (Action)Breeding) Breeding(); return; }
            screenNote = null;
            m.NextRevealStep(); // the birth is the moment: the first step at once
            currentScreen = FoalRevealScreen;
            FoalRevealScreen();
        }

        // ------------------------------------------------------------------------------------------- 仔馬のお披露目

        void FoalRevealScreen()
        {
            var m = raisingBreeding;
            if (m?.Reveal == null) { currentScreen = null; Breeding(); return; }
            currentScreen = FoalRevealScreen; Clear(); SetArt("Art/scout-reveal");
            bool done = m.RevealDone, again = done && m.AgainWithMaterialLine != null;
            var l = RaisingLayout.FoalReveal(done, again);
            var rv = m.Reveal; int step = m.RevealStep;
            RaisingCard(l, "card");
            RaisingKicker(l, "kicker", RaisingText.NewLife);
            RaisingLine(l, "title", RaisingText.FoalBorn);
            if (step >= 1) RaisingLine(l, "sexstyle", m.RevealSexStyleText);
            if (step >= 2)
                for (int i = 0; i < rv.Stats.Count && i < 5; i++)
                {
                    var s = rv.Stats[i]; string k = "stat" + i;
                    RaisingLine(l, k + ".name", TrainingModel.StatNames.TryGetValue(s.Key, out var n) ? n : s.Key);
                    var t = l[k + ".track"];
                    Panel(t.Id, t.X, t.Y, t.W, t.H, RaisingTrack);
                    float a = Mathf.InverseLerp(400, 1000, s.Min), z = Mathf.InverseLerp(400, 1000, s.Max), at = Mathf.InverseLerp(400, 1000, s.Value);
                    Panel(t.Id + " band", t.X + t.W * a, t.Y - 3, Mathf.Max(4, t.W * (z - a)), t.H + 6, new Color(0, .8f, .95f, .35f));
                    Panel(t.Id + " pin", t.X + t.W * at - 2, t.Y - 7, 4, t.H + 14, Color.white);
                    bool high = s.Mark == "high";
                    RaisingLine(l, k + ".value", s.Value.ToString(), high ? cyan : Color.white);
                    if (high) RaisingLine(l, k + ".mark", RaisingText.AboveRange, cyan);
                }
            if (step >= 3)
            {
                RaisingLine(l, "rarity", rv.Foal.Rarity, gold);
                RaisingLine(l, "summary", m.RevealSummaryText);
            }
            if (step >= 4)
            {
                RaisingLine(l, "skill", m.RevealSkillText, cyan);
                RaisingLine(l, "atavism", m.RevealAtavismText, Color.white);
                RaisingLine(l, "parents", m.RevealParentsText, KitMuted);
            }
            if (!done)
            {
                RaisingCta(l, RaisingText.Turn, () => { m.NextRevealStep(); FoalRevealScreen(); });
                RaisingGhost(l, "all", RaisingText.ShowAll, () => { m.RevealAll(); FoalRevealScreen(); });
                return;
            }
            var foalId = rv.Foal.Id;
            RaisingCta(l, RaisingText.SeeHorseCard, () => OpenHorseCard(foalId, () => { currentScreen = null; Breeding(); }));
            RaisingGhost(l, "back", RaisingText.BackToBreeding, () => { currentScreen = null; Breeding(); });
            if (again)
            {
                RaisingGhost(l, "again", RaisingText.BreedAgain, () => RaisingBreed(true));
                RaisingLine(l, "again.line", m.AgainWithMaterialLine, KitMuted);
            }
        }

        // ------------------------------------------------------------------------------------------- 血統 (minimal)

        void OpenPedigree(string horseId, Action back)
        {
            raisingPedigreeHorse = horseId; raisingPedigreeBack = back;
            currentScreen = null;
            PedigreeScreen();
        }

        void PedigreeScreen()
        {
            if (currentScreen != (Action)PedigreeScreen)
            {
                screenNote = null; currentScreen = PedigreeScreen;
                raisingPedigree = backend.Api != null ? new PedigreeModel(new ApiPedigree(backend.Api), MuchiServices.Track, () => MuchiServices.NowMs) : null;
                var id = raisingPedigreeHorse; var pm = raisingPedigree;
                if (pm != null && id != null && backend.Online) LoadScreenModel(async () => { if (!await pm.OpenAsync(id, PedigreeSources.Horse)) screenNote = pm.Message; }, PedigreeScreen);
            }
            Clear(); SetArt("Art/home-paddock");
            var l = RaisingLayout.Pedigree();
            var m = raisingPedigree; var v = m?.View;
            RaisingLine(l, "title", RaisingText.PedigreeTitle);
            RaisingCard(l, "treeCard");
            RaisingGhost(l, "back", RaisingText.Back, () => (raisingPedigreeBack ?? Stable)());
            var horse = raisingPedigreeHorse;
            RaisingCta(l, RaisingText.SeeHorseCard, () => OpenHorseCard(horse, PedigreeScreen));
            if (v == null) { RaisingLine(l, "sub", m?.Message ?? screenNote ?? (backend.Online ? "…" : PedigreeModel.OfflineText), KitMuted); return; }
            RaisingLine(l, "sub", (v.LineName != null ? v.LineName + "　·　" : "") + RaisingText.PedigreeSub, KitSoft);
            // elbow lines first (under the boxes): parent right edge → mid → each child's left edge
            for (int i = 0; 2 * i + 2 < PedigreeTree.SlotCount; i++)
            {
                if (m.Boxes[i].Empty) continue;
                var p = RaisingLayout.PedigreeSlot(i); var a = RaisingLayout.PedigreeSlot(2 * i + 1); var c = RaisingLayout.PedigreeSlot(2 * i + 2);
                float pcy = p.Y + p.H / 2, acy = a.Y + a.H / 2, ccy = c.Y + c.H / 2, mid = Mathf.Round((p.Right + a.X) / 2);
                Panel("ped line", p.Right, pcy, mid - p.Right, 2, KitLine);
                Panel("ped line", mid, acy, 2, ccy - acy, KitLine);
                if (!m.Boxes[2 * i + 1].Empty) Panel("ped line", mid, acy, a.X - mid, 2, m.Boxes[2 * i + 1].Shared ? cyan : KitLine);
                if (!m.Boxes[2 * i + 2].Empty) Panel("ped line", mid, ccy, c.X - mid, 2, m.Boxes[2 * i + 2].Shared ? cyan : KitLine);
            }
            foreach (var bx in m.Boxes)
            {
                var r = RaisingLayout.PedigreeSlot(bx.Slot); string k = "slot" + bx.Slot;
                var img = Panel(k, r.X, r.Y, r.W, r.H, bx.Empty ? new Color(0, 0, 0, .18f) : KitPanel);
                if (bx.Shared) { var o = img.gameObject.AddComponent<Outline>(); o.effectColor = cyan; o.effectDistance = new Vector2(2, -2); }
                if (m.CanOpenAncestor(bx)) { var hid = bx.Node.HorseId; img.gameObject.AddComponent<Button>().onClick.AddListener(() => OpenPedigree(hid, raisingPedigreeBack)); }
                RaisingLine(l, k + ".rel", bx.Relation, cyan);
                if (bx.Shared) RaisingLine(l, k + ".badge", PedigreeModel.SharedBadge, cyan, TextAnchor.UpperRight);
                RaisingLine(l, k + ".name", bx.Empty ? "—" : bx.Node.Name, bx.Empty ? RaisingDim : Color.white);
                if (bx.Empty || bx.Gen == 3) continue;
                RaisingLine(l, k + ".traits", bx.NoRecord ? RaisingText.NoRecord : bx.TraitLine, bx.NoRecord ? KitMuted : KitSoft);
                if (bx.Gen < 2) RaisingLine(l, k + ".under", bx.OwnerLine ?? (bx.Node.Founder ? PedigreeModel.FounderBadge : bx.Node.Rec?.BestText), bx.OwnerLine != null ? KitMuted : gold);
                if (bx.Gen == 0 && bx.Node.Rec != null) RaisingLine(l, k + ".line", bx.Node.Rec.Rarity + "　/　" + bx.Node.Rec.LineName);
            }
            RaisingLine(l, "inbreeding", m.InbreedingLine ?? PedigreeModel.NoSharedText, m.InbreedingLine != null ? gold : KitSoft);
        }

        // ------------------------------------------------------------------------------------------- race result (ruleset 1.4)

        /// <summary>StartDriver's hook: the wallet and points before this race, and a fresh settle for its result.</summary>
        void RaisingRaceStarted()
        {
            raisingRewardsBefore = ResultRewards.Snapshot(backend.Player);
            raisingSettling = raisingSettled = raisingPromoPopupDone = false;
        }

        void RaisingResult()
        {
            currentScreen = Result;
            bool first = tutorial;
            var hud = driver != null ? HudModel.Build(driver, MuchiServices.NowMs) : new HudSnapshot();
            var result = driver != null ? RaceResultModel.Build(driver, observer) : new RaceResultModel();
            int place = result.HasResult && result.Place > 0 ? result.Place : hud.FinishPlace > 0 ? hud.FinishPlace : hud.Rank;
            bool online = driver != null && driver.Online;
            bool confirmed = online && driver.Phase == RacePhase.Confirmed, voided = online && driver.Phase == RacePhase.Void;
            Clear(); SetArt(place >= 1 && place <= 3 ? "Art/race-result" : "Art/first-ride");
            bool promoReady = online && raceMode == "ranked" && raisingSettled && raisingPromotion != null;
            var plan = promoReady ? ResultPromotionPlan.Build(raisingPromotion, RaisingPromotionReward()) : new ResultPromotionPlan();
            if (raisingPromoPopupDone && plan.What == ResultPromotionPlan.Show.Card && plan.Title == raisingPromotion.OutcomeTitle) plan.What = ResultPromotionPlan.Show.None; // the sheet said it
            var l = RaisingLayout.Result(plan.What == ResultPromotionPlan.Show.Card);
            RaisingCard(l, "panel");
            string mode = online ? RaisingText.Ranked : first ? RaisingText.FirstRide : RaisingText.Practice;
            RaisingKicker(l, "kicker", RaisingText.ResultKicker + "　/　" + mode);
            string headline = result.HasResult ? result.Headline : place > 0 ? place + "着" : "—";
            RaisingLine(l, "place", headline, place == 1 ? gold : Color.white);
            RaisingLine(l, "won", result.Won ? RaisingText.Win : result.Runners > 0 ? result.Runners + "頭中" : null);
            RaisingLine(l, "partner", horseName + "　/　" + mode);
            RaisingBar(l["rule"], KitLine);
            // the numbers: the time, and the coins / points the server granted (never a client guess)
            var rewards = (raisingRewardsBefore ?? new ResultRewards()).Settle(backend.Player, online, confirmed && raisingSettled, voided);
            RaisingKicker(l, "timeKicker", RaisingText.Time);
            RaisingKicker(l, "coinsKicker", RaisingText.FreeCoins);
            RaisingKicker(l, "pointsKicker", RaisingText.SeasonPoints);
            RaisingLine(l, "time", result.HasResult ? result.TimeText : HudModel.FormatTime(hud.ElapsedMs));
            RaisingLine(l, "coins", rewards.CoinsText, rewards.Known ? gold : RaisingDim);
            RaisingLine(l, "points", rewards.PointsText, rewards.Known ? gold : RaisingDim);
            RaisingLine(l, "rewards", rewards.Line, KitSoft);
            // the reason: 勝因 / 敗因, the debrief, the tip and the honest 1.4 lesson row (fitted to its box)
            var lines = ResultLines.Build(result, false, l["tip"], l["lesson"]);
            RaisingKicker(l, "reasonKicker", lines.ReasonKicker);
            RaisingLine(l, "debrief", lines.Debrief);
            RaisingLine(l, "tip", lines.Tip, KitMuted);
            RaisingLine(l, "lesson", lines.Lesson, cyan);
            if (result.Status != null) RaisingLine(l, "status", result.Status, KitSoft);
            else if (online && driver.Phase == RacePhase.Failed) RaisingLine(l, "status", "CONNECTION FAILED  /  " + (driver.FailureReason ?? ""), KitSoft);
            // the one CTA: the tutorial's retry / naming, else もう一度 (the entry); home and the horse card are quiet
            bool retry = first && result.TutorialRetry;
            Action next = retry ? (Action)(() => StartDriver(backend.CreateTutorialRace(), "tutorial", true)) : first ? (Action)NamePartner : Entry;
            RaisingCta(l, retry || first ? result.PrimaryAction : RaisingText.Again, next);
            if (!first)
            {
                RaisingGhost(l, "home", RaisingText.Home, Home);
                RaisingGhost(l, "horseCard", HorseProfileModel.Title, () => OpenHorseCard(null, Result));
            }
            // the promotion series: the card, or the outcome popup — never both
            if (plan.What == ResultPromotionPlan.Show.Card)
            {
                RaisingCard(l, "promoCard");
                RaisingKicker(l, "promoKicker", plan.Kicker);
                RaisingLine(l, "promoTitle", plan.Title, plan.Gold ? gold : Color.white);
                RaisingLine(l, "promoLead", plan.Lead);
                RaisingLine(l, "promoMarks", plan.Marks, cyan);
                RaisingLine(l, "promoRule", plan.Rule, KitMuted);
                RaisingLine(l, "promoFoot", plan.Foot, KitSoft);
                RaisingLine(l, "promoReward", plan.RewardLine, Color.white);
            }
            if (first && result.Won) Ftue("race1_win", Math.Max(0, backend.TutorialAttempts - 1));
            if (!first && confirmed && raceMode == "ranked" && result.HasResult) Ftue("race2_done", result.Place); // 06 §8.1 row 8
            if (online && !raisingSettled) RaisingSettle();
            if (plan.What == ResultPromotionPlan.Show.Popup)
                Moment(RaisingTr(plan.MomentKicker), RaisingTr(plan.Title), RaisingTr(plan.MomentLine), null, RaisingTr(plan.MomentButton), RaisingClosePromotion);
        }

        /// <summary>Waits for the room's verdict, refreshes the wallet / points and the promotion series, then redraws the result once.</summary>
        async void RaisingSettle()
        {
            if (raisingSettling) return;
            raisingSettling = true;
            var d = driver;
            for (int i = 0; i < 60 && d != null && d == driver && d.Phase != RacePhase.Confirmed && d.Phase != RacePhase.Void && d.Phase != RacePhase.Failed; i++) await Task.Delay(500);
            if (d == null || d != driver) return;
            if (d.Phase == RacePhase.Confirmed)
            {
                try { await backend.RefreshAsync(); } catch (Exception e) { Debug.LogWarning("result refresh: " + e.Message); }
                if (raceMode == "ranked")
                {
                    if (raisingPromotion == null) raisingPromotion = new PromotionModel(backend) { Prompts = raisingPrompts };
                    try { await raisingPromotion.AfterRankedResultAsync(); } catch (Exception e) { Debug.LogWarning("promotion: " + e.Message); }
                }
            }
            raisingSettled = true;
            if (!inRace && currentScreen == (Action)Result && d == driver) Result();
        }

        async void RaisingClosePromotion()
        {
            raisingPromoPopupDone = true;
            try { if (raisingPromotion != null) await raisingPromotion.CloseOutcomeAsync(); } catch (Exception e) { Debug.LogWarning("promotion ack: " + e.Message); }
        }

        /// <summary>
        /// The free class pattern granted on promotion (quality/shopcfg, option A). The server grants it at the season close, so
        /// right after a passed series the result shows what reaching the class will give (PromotionView.NextReward); a reward
        /// already granted and not yet acknowledged (PromotionView.Reward) reads as received. Its moment is shown on Home.
        /// </summary>
        PromotionRewardInfo RaisingPromotionReward()
        {
            var v = raisingPromotion?.View;
            if (v == null) return null;
            if (v.Reward != null && v.Reward.Items.Count > 0) return new PromotionRewardInfo { Name = PromotionPips.RewardItems(v.Reward, GoalLadderModel.ItemName), Granted = true };
            if (v.NextReward != null && v.NextReward.Items.Count > 0) return new PromotionRewardInfo { Name = PromotionPips.RewardItems(v.NextReward, GoalLadderModel.ItemName), Granted = false };
            return null;
        }

        /// <summary>Home: the promotion reward granted at the season close gets its moment once (then acknowledged on the server).</summary>
        async void RaisingRewardMomentOnHome()
        {
            if (!backend.Online || raisingRewardMomentUp) return;
            if (raisingPromotion == null) raisingPromotion = new PromotionModel(backend) { Prompts = raisingPrompts };
            raisingPromotion.ItemName = GoalLadderModel.ItemName;
            try { await raisingPromotion.RefreshAsync(); } catch (Exception e) { Debug.LogWarning("promotion: " + e.Message); return; }
            if (inRace || currentScreen != (Action)Home || raisingRewardMomentUp || !raisingPromotion.TryShowRewardMoment()) return;
            raisingRewardMomentUp = true;
            Moment(RaisingTr(raisingPromotion.RewardMomentKicker), RaisingTr(raisingPromotion.RewardMomentItems), RaisingTr(raisingPromotion.RewardMomentSub), null, RaisingTr(RaisingText.Continue), async () =>
            {
                raisingRewardMomentUp = false;
                try { await raisingPromotion.CloseRewardMomentAsync(); } catch (Exception e) { Debug.LogWarning("promotion reward ack: " + e.Message); }
            });
        }
        bool raisingRewardMomentUp;
    }
}
