using System;
using System.Collections.Generic;
using System.Text;
using Muchi.Engine;
using Muchi.Net;

namespace Muchi.Client
{
    /// <summary>One piece of a template: fixed text (pre-recorded clip) or a placeholder.</summary>
    public sealed class TemplatePart
    {
        /// <summary>Clip id for fixed text ("variantId#n"), null for a placeholder.</summary>
        public string ClipId;
        public string Text;
        /// <summary>name, name2, name3, place or skill (the subject horse's skill name); null for fixed text.</summary>
        public string Placeholder;
    }

    public sealed class PhraseVariant
    {
        public string Id;
        public string Text;
        public List<TemplatePart> Parts = new List<TemplatePart>();
    }

    public sealed class PhraseDef
    {
        public string Kind;
        public int Priority;
        /// <summary>Key moment: never dropped, only delayed (gate, leader, spurt, winner, result).</summary>
        public bool MustSay;
        public List<PhraseVariant> Variants = new List<PhraseVariant>();
    }

    /// <summary>Commentary templates (engine/Muchi.Client/Resources/Muchi/commentary-ja.json). In Unity load the file as a TextAsset.</summary>
    public sealed class CommentaryTemplates
    {
        /// <summary>
        /// "ja" (commentary-ja.json) or "en" (commentary-en.json, REQ-L10N-012). In English, places are ordinals ("3rd"),
        /// horse and skill names come from the English tables (<see cref="Loc.English"/>; katakana names romanized).
        /// </summary>
        public string Language = "ja";
        public int TicksPerChar = 3;
        public int MinLineTicks = 24;
        public int GapTicks = 4;
        public int LeaderStableTicks = 30;
        public int PositionCallIntervalTicks = 240;
        public int PendingExpiryTicks = 60;
        /// <summary>
        /// Key moments are delayed, never dropped — unless they are this stale (Process called in a batch after a
        /// reconnect fast-forward or catch-up). Finish and result lines are never dropped.
        /// </summary>
        public int MustSayExpiryTicks = 200;
        /// <summary>Runner-up this close to the winner (ticks) gets the photo-finish line.</summary>
        public int PhotoFinishTicks = 2;
        /// <summary>Two horses swapping the lead within this many ticks in the final straight get the duel line.</summary>
        public int DuelWindowTicks = 150;
        /// <summary>A winner this far back when the final straight started (0 = leader) wins "from the back".</summary>
        public int ComebackFromRank = 5;
        /// <summary>Skill lines for horses other than the player's (leaders only, rank &lt; 3), at most this many per race.</summary>
        public int MaxOtherSkillLines = 2;
        public readonly Dictionary<string, PhraseDef> Phrases = new Dictionary<string, PhraseDef>();

        /// <summary>
        /// Optional kinds the shipped templates carry (REQ-COMM-*; old templates without them speak exactly as before):
        /// race-story lines and the mid-race ground call. Variants of any kind may also be specialised per race mode
        /// ("kind@tutorial", "kind@ranked", …: tone) and per venue ("kind@nordhaven": the venue's own lines).
        /// </summary>
        public static readonly string[] StoryKinds = { "duel", "photo_finish", "comeback_win", "wire_win" };

        public static readonly string[] RequiredKinds =
        {
            "gate_open", "good_start", "late_start", "leader", "position_call", "kakari", "spurt",
            "focus_whip", "cpu_takeover", "finish_win", "focus_finish", "result",
        };

        public static CommentaryTemplates Parse(string json)
        {
            var o = JsonNode.Parse(json);
            var t = new CommentaryTemplates
            {
                Language = Loc.Normalize(J.Str(o, "language")),
                TicksPerChar = J.Int(o, "ticksPerChar", 3),
                MinLineTicks = J.Int(o, "minLineTicks", 24),
                GapTicks = J.Int(o, "gapTicks", 4),
                LeaderStableTicks = J.Int(o, "leaderStableTicks", 30),
                PositionCallIntervalTicks = J.Int(o, "positionCallIntervalTicks", 240),
                PendingExpiryTicks = J.Int(o, "pendingExpiryTicks", 60),
                MustSayExpiryTicks = J.Int(o, "mustSayExpiryTicks", 200),
                PhotoFinishTicks = J.Int(o, "photoFinishTicks", 2),
                DuelWindowTicks = J.Int(o, "duelWindowTicks", 150),
                ComebackFromRank = J.Int(o, "comebackFromRank", 5),
                MaxOtherSkillLines = J.Int(o, "maxOtherSkillLines", 2),
            };
            foreach (var kv in o.Get("phrases").Props)
            {
                var def = new PhraseDef { Kind = kv.Key, Priority = J.Int(kv.Value, "priority"), MustSay = J.Bool(kv.Value, "mustSay") };
                foreach (var v in kv.Value.Get("variants").Items)
                {
                    var pv = new PhraseVariant { Id = J.Str(v, "id"), Text = J.Str(v, "text") };
                    pv.Parts = Split(pv.Id, pv.Text);
                    def.Variants.Add(pv);
                }
                if (def.Variants.Count == 0) throw new FormatException("phrase " + kv.Key + " has no variants");
                t.Phrases[kv.Key] = def;
            }
            foreach (var k in RequiredKinds) if (!t.Phrases.ContainsKey(k)) throw new FormatException("missing phrase kind: " + k);
            foreach (var kv in t.Phrases)
            {
                // a specialised phrase ("spurt@nordhaven") must specialise a known kind and keep its key-moment rule
                int at = kv.Key.IndexOf('@');
                if (at < 0) continue;
                string baseKind = kv.Key.Substring(0, at);
                if (!t.Phrases.TryGetValue(baseKind, out var b)) throw new FormatException("specialised phrase without base kind: " + kv.Key);
                if (b.MustSay != kv.Value.MustSay) throw new FormatException("specialised phrase must keep mustSay of " + baseKind + ": " + kv.Key);
            }
            return t;
        }

        private static List<TemplatePart> Split(string id, string text)
        {
            var parts = new List<TemplatePart>();
            int i = 0, n = 0;
            while (i < text.Length)
            {
                int open = text.IndexOf('{', i);
                if (open < 0) { parts.Add(new TemplatePart { ClipId = id + "#" + n++, Text = text.Substring(i) }); break; }
                if (open > i) parts.Add(new TemplatePart { ClipId = id + "#" + n++, Text = text.Substring(i, open - i) });
                int close = text.IndexOf('}', open);
                if (close < 0) throw new FormatException("unclosed placeholder in " + id);
                string ph = text.Substring(open + 1, close - open - 1);
                if (ph != "name" && ph != "name2" && ph != "name3" && ph != "place" && ph != "skill") throw new FormatException("unknown placeholder {" + ph + "} in " + id);
                parts.Add(new TemplatePart { Placeholder = ph });
                i = close + 1;
            }
            return parts;
        }

        /// <summary>Every fixed clip (id → text) to pre-generate with TTS once. Names are generated per horse ("name:&lt;horseId&gt;").</summary>
        public Dictionary<string, string> AllFixedClips()
        {
            var d = new Dictionary<string, string>();
            foreach (var p in Phrases.Values)
                foreach (var v in p.Variants)
                    foreach (var part in v.Parts)
                        if (part.ClipId != null) d[part.ClipId] = part.Text;
            return d;
        }
    }

    public sealed class CommentaryLine
    {
        /// <summary>Simulation tick at which the line starts (may be after the race end for the closing lines).</summary>
        public int Tick;
        public string Kind;
        /// <summary>The template phrase used: the kind itself, or its mode/venue specialisation ("spurt@bellmoor").</summary>
        public string PhraseKey;
        public string VariantId;
        /// <summary>Main subject slot, -1 if none.</summary>
        public int Slot;
        public int Priority;
        public int DurationTicks;
        public string Text;
        /// <summary>Audio clips to play in order: fixed clip ids, "name:&lt;horseId&gt;" and "num:&lt;n&gt;".</summary>
        public string[] ClipKeys;
        /// <summary>
        /// The line was cut short by a more urgent one (the pre-gate ground intro when the gate opens): stop or
        /// fade its audio after <see cref="DurationTicks"/>.
        /// </summary>
        public bool Interrupted;

        public override string ToString() => Tick + " [" + Kind + "] " + Text;
    }

    /// <summary>
    /// Turns RaceSim events and state into Japanese commentary (AI実況のテキスト側).
    /// Deterministic for a given race (variants chosen from the race seed), lines never overlap,
    /// key moments are never dropped. Call <see cref="Process"/> after every simulated tick.
    /// </summary>
    public sealed class Commentator
    {
        private sealed class Cand
        {
            public string Kind;
            public int Slot = -1, Slot2 = -1, Slot3 = -1, Place;
            public int CreatedTick;
            public string Key;
            public PhraseDef Def;
        }

        private readonly CommentaryTemplates _t;
        private readonly RaceConfig _cfg;
        private readonly int _focus;
        private readonly List<Cand> _pending = new List<Cand>();
        private readonly List<CommentaryLine> _lines = new List<CommentaryLine>();
        private readonly Dictionary<string, int> _kindCount = new Dictionary<string, int>();
        private int _eventIndex;
        private int _busyUntil;
        private int _leader = -1, _leaderSince, _announcedLeader = -1;
        private bool _spurtSaid, _focusWhipSaid, _anyFinished, _flushed, _introDone;
        private int _lastPositionCall = -1;
        private CommentaryLine _current;
        private readonly string _mode, _venue;
        // race story (REQ-COMM-003): each horse's rank and tick as it reached the spurt mark (from the tick-stamped
        // SpurtStart events, so a batched catch-up Process tells the same story), lead changes, winner's finish tick
        private int[] _spurtRank, _spurtTick;
        private readonly List<RaceEvent> _leaderChanges = new List<RaceEvent>();
        private int _prevLeader = -1, _prevLeaderChange = -1;
        private bool _duelSaid, _photoSaid, _goingCallDone;
        private int _otherSkillLines;
        private int _winnerTick = -1;

        public IReadOnlyList<CommentaryLine> Lines => _lines;

        private readonly HashSet<int> _bondSlots = new HashSet<int>();
        private bool _bondSaid;

        /// <summary>
        /// REQ-BOND-004: slots whose rider has a strong bond with the horse (from start.visuals, see
        /// RaceVisuals.BondCalloutSlots). The commentary may call the focus horse out once at the final straight.
        /// Flavour only; has no effect on the race.
        /// </summary>
        public void SetBondCallouts(IEnumerable<int> slots)
        {
            _bondSlots.Clear();
            if (slots != null) foreach (var x in slots) _bondSlots.Add(x);
        }

        /// <param name="focusSlot">The player's horse (its whips, start and place get lines). -1 for spectators.</param>
        public Commentator(CommentaryTemplates templates, RaceConfig config, int focusSlot = -1)
        {
            _t = templates ?? throw new ArgumentNullException(nameof(templates));
            _cfg = config ?? throw new ArgumentNullException(nameof(config));
            _focus = focusSlot;
            _mode = ModeName(config.Mode);
            _venue = VenueOf(config.Track);
        }

        /// <summary>Lower-case mode name used in specialised phrase keys ("kind@tutorial").</summary>
        public static string ModeName(RaceMode m)
        {
            switch (m)
            {
                case RaceMode.Ranked: return "ranked";
                case RaceMode.Friend: return "friend";
                case RaceMode.Tutorial: return "tutorial";
                case RaceMode.TimeAttack: return "timeattack";
                case RaceMode.Event: return "event";
                case RaceMode.Tournament: return "tournament";
                default: return "other";
            }
        }

        /// <summary>Venue of a course: the course id up to the first '_' ("nordhaven_turf_2400" → "nordhaven"; server/master/visuals.json tracks).</summary>
        public static string VenueOf(TrackSpec track)
        {
            if (track?.Id == null) return null;
            int i = track.Id.IndexOf('_');
            return i > 0 ? track.Id.Substring(0, i) : track.Id;
        }

        /// <summary>Template key for a kind in this race: mode tone first, then the venue's own lines, then the plain kind.</summary>
        public string PhraseKeyFor(string kind)
        {
            string k = kind + "@" + _mode;
            if (_t.Phrases.ContainsKey(k)) return k;
            if (_venue != null && _t.Phrases.ContainsKey(k = kind + "@" + _venue)) return k;
            return kind;
        }

        /// <summary>Mid-race ground call for off-good going ("going_call_turf_soft"), null on good ground or old configs.</summary>
        public static string GoingCallKind(TrackSpec track)
        {
            if (track?.Going == null || track.EffectiveGoing == Going.Good) return null;
            return "going_call_" + (track.Surface == Surface.Dirt ? "dirt" : "turf") + "_" + ProtocolCodec.GoingToString(track.EffectiveGoing, track.Surface);
        }

        /// <summary>Reads new events, returns the lines that start now (often empty).</summary>
        public List<CommentaryLine> Process(RaceSim sim)
        {
            var started = new List<CommentaryLine>();
            int now = sim.Tick - 1;
            var events = sim.Events;
            if (!_introDone)
            {
                _introDone = true;
                // the ground/night intro belongs before the gate; skip it when processing starts after the gate
                string intro = IntroKind(_cfg.Track);
                if (intro != null && _t.Phrases.ContainsKey(intro) && !sim.GateOpened) Add(intro, now, -1);
            }
            for (; _eventIndex < events.Count; _eventIndex++) OnEvent(sim, events[_eventIndex]);

            if (!_anyFinished && _leader >= 0 && _leader != _announcedLeader && now - _leaderSince >= _t.LeaderStableTicks)
            {
                _pending.RemoveAll(c => c.Kind == "leader");
                Add("leader", now, _leader);
                _announcedLeader = _leader;
            }

            if (!_anyFinished && sim.GateOpened && !_spurtSaid && now >= _busyUntil && _pending.Count == 0
                && _lastPositionCall >= 0 && now - _lastPositionCall >= _t.PositionCallIntervalTicks && sim.EntrantCount >= 3)
            {
                string going = _goingCallDone ? null : GoingCallKind(_cfg.Track);
                _goingCallDone = true;
                if (going != null && _t.Phrases.ContainsKey(going)) Add(going, now, sim.SlotAtRank(0)); // once, instead of the first position call
                else
                {
                    var c = Add("position_call", now, sim.SlotAtRank(0));
                    c.Slot2 = sim.SlotAtRank(1);
                    c.Slot3 = sim.SlotAtRank(2);
                }
                _lastPositionCall = now;
            }

            _pending.RemoveAll(c => !c.Def.MustSay && now - c.CreatedTick > _t.PendingExpiryTicks);
            // stale key moments (batched Process after a fast-forward) and an intro that missed the gate
            _pending.RemoveAll(c => c.Def.MustSay && !NeverExpires(c.Kind) && now - c.CreatedTick > _t.MustSayExpiryTicks);
            if (sim.GateOpened) _pending.RemoveAll(c => IsIntro(c.Kind));

            if (now >= _busyUntil && _pending.Count > 0) started.Add(Speak(PickNext(), now));

            if (sim.IsFinished && !_flushed)
            {
                _flushed = true;
                _pending.RemoveAll(c => !c.Def.MustSay);
                while (_pending.Count > 0) started.Add(Speak(PickNext(), Math.Max(now, _busyUntil)));
            }
            return started;
        }

        /// <summary>
        /// Phrase kind for the pre-gate line about the ground and lighting (REQ-RACE-036), e.g. "ground_turf_soft_night".
        /// Null when the config carries neither going nor night (old configs: no extra line, same commentary as before).
        /// </summary>
        public static string IntroKind(TrackSpec track)
        {
            if (track == null || (track.Going == null && track.Night != true)) return null;
            string surface = track.Surface == Surface.Dirt ? "dirt" : "turf";
            string kind = "ground_" + surface + "_" + ProtocolCodec.GoingToString(track.EffectiveGoing, track.Surface);
            return track.Night == true ? kind + "_night" : kind;
        }

        /// <summary>The winner's line: plain, from the back, or wire to wire.</summary>
        public static bool IsWinKind(string kind) => kind == "finish_win" || kind == "comeback_win" || kind == "wire_win";

        private static bool IsIntro(string kind) => kind.StartsWith("ground_", StringComparison.Ordinal);
        private static bool NeverExpires(string kind) => kind == "finish_win" || kind == "comeback_win" || kind == "wire_win" || kind == "photo_finish"
            || kind == "focus_finish" || kind.StartsWith("result", StringComparison.Ordinal);

        private void OnEvent(RaceSim sim, RaceEvent e)
        {
            switch (e.Type)
            {
                case RaceEventType.GateOpen:
                    // the gate call pre-empts the pre-gate intro if it is still running
                    if (_current != null && IsIntro(_current.Kind) && _busyUntil > e.Tick)
                    {
                        _current.DurationTicks = Math.Max(0, e.Tick - _current.Tick);
                        _current.Interrupted = true;
                        _busyUntil = e.Tick;
                    }
                    Add("gate_open", e.Tick, -1);
                    _lastPositionCall = e.Tick;
                    break;
                case RaceEventType.Start:
                    if (e.Slot == _focus && e.Value <= 1) Add("good_start", e.Tick, e.Slot);
                    break;
                case RaceEventType.LateStart:
                    if (e.Slot == _focus || !_pending.Exists(c => c.Kind == "late_start")) Add("late_start", e.Tick, e.Slot);
                    break;
                case RaceEventType.LeaderChanged:
                    // duel (REQ-COMM-003): in the final straight the lead goes back to the horse that just lost it
                    if (_spurtSaid && !_duelSaid && !_anyFinished && _prevLeader == e.Slot && _leader >= 0 && _leader != e.Slot
                        && e.Tick - _prevLeaderChange <= _t.DuelWindowTicks && _t.Phrases.ContainsKey("duel"))
                    {
                        _duelSaid = true;
                        Add("duel", e.Tick, e.Slot).Slot2 = _leader;
                    }
                    _leaderChanges.Add(e);
                    _prevLeader = _leader;
                    _prevLeaderChange = e.Tick;
                    _leader = e.Slot;
                    _leaderSince = e.Tick;
                    break;
                case RaceEventType.Kakari:
                    // the engine stamps the rank into the event: never read live state here (catch-up Process)
                    if (e.Slot == _focus || e.Value < 3) Add("kakari", e.Tick, e.Slot);
                    break;
                case RaceEventType.Whip:
                    if (e.Slot == _focus && !_focusWhipSaid) { _focusWhipSaid = true; Add("focus_whip", e.Tick, e.Slot); }
                    break;
                case RaceEventType.SpurtStart:
                    if (_spurtRank == null)
                    {
                        _spurtRank = new int[sim.EntrantCount];
                        _spurtTick = new int[sim.EntrantCount];
                        for (int i = 0; i < _spurtRank.Length; i++) _spurtRank[i] = _spurtTick[i] = -1;
                    }
                    if (e.Slot >= 0 && e.Slot < _spurtRank.Length && _spurtTick[e.Slot] < 0)
                    {
                        // the engine stamps the rank into the event: never read live state here (catch-up Process)
                        _spurtRank[e.Slot] = e.Value;
                        _spurtTick[e.Slot] = e.Tick;
                    }
                    if (!_spurtSaid)
                    {
                        _spurtSaid = true;
                        Add("spurt", e.Tick, e.Slot);
                    }
                    // REQ-BOND-004: flavour line for a horse its rider has bonded with (focus horse first)
                    if (_bondSlots.Contains(e.Slot) && !_bondSaid && _t.Phrases.ContainsKey("bond_call") && (e.Slot == _focus || _focus < 0))
                    {
                        _bondSaid = true;
                        Add("bond_call", e.Tick, e.Slot);
                    }
                    break;
                case RaceEventType.Skill:
                    // unique skill (ruleset 1.3): the player's horse always; others only near the front, a few per race. The
                    // rank is stamped into the event (never read live state: catch-up Process tells the same story)
                    if (!_anyFinished && _t.Phrases.ContainsKey("skill") && SkillName(e.Slot) != null)
                    {
                        if (e.Slot == _focus) Add("skill", e.Tick, e.Slot);
                        else if (e.Value < 3 && _otherSkillLines < _t.MaxOtherSkillLines) { _otherSkillLines++; Add("skill", e.Tick, e.Slot); }
                    }
                    break;
                case RaceEventType.CpuTakeover:
                    if (e.Slot == _focus) Add("cpu_takeover", e.Tick, e.Slot);
                    break;
                case RaceEventType.Finish:
                    if (e.Value == 1)
                    {
                        _anyFinished = true;
                        _winnerTick = e.Tick;
                        _pending.RemoveAll(c => c.Kind == "leader" || c.Kind == "position_call" || c.Kind == "kakari" || c.Kind == "duel" || c.Kind == "skill" || c.Kind.StartsWith("going_call_", StringComparison.Ordinal));
                        Add(WinKind(e.Slot, sim.EntrantCount), e.Tick, e.Slot);
                    }
                    else
                    {
                        // photo finish (REQ-COMM-003): the runner-up is within a whisker of the winner
                        if (e.Value == 2 && !_photoSaid && _winnerTick >= 0 && e.Tick - _winnerTick <= _t.PhotoFinishTicks && _t.Phrases.ContainsKey("photo_finish"))
                        {
                            _photoSaid = true;
                            Add("photo_finish", e.Tick, e.Slot);
                        }
                        if (e.Slot == _focus) Add("focus_finish", e.Tick, e.Slot).Place = e.Value;
                    }
                    break;
                case RaceEventType.RaceEnd:
                    var order = sim.Result?.Order;
                    if (order != null && order.Length >= 3)
                    {
                        var c = Add("result", e.Tick, order[0]);
                        c.Slot2 = order[1];
                        c.Slot3 = order[2];
                    }
                    else if (order != null && order.Length == 2 && _t.Phrases.ContainsKey("result_two"))
                    {
                        Add("result_two", e.Tick, order[0]).Slot2 = order[1];
                    }
                    else if (order != null && order.Length == 1 && _t.Phrases.ContainsKey("result_solo"))
                    {
                        Add("result_solo", e.Tick, order[0]);
                    }
                    break;
            }
        }

        /// <summary>
        /// The winner's line: "from the back" when it was ComebackFromRank or further back as it reached the spurt mark
        /// (fields of 8+), "never gave up the lead" when it led then and no other horse took the lead afterwards, the
        /// plain finish line otherwise (or with old templates). Uses only tick-stamped events, so the line is the same
        /// whether Process ran every tick or once in a catch-up batch.
        /// </summary>
        private string WinKind(int slot, int field)
        {
            if (_spurtRank == null || slot < 0 || slot >= _spurtRank.Length || _spurtRank[slot] < 0) return "finish_win";
            int r = _spurtRank[slot];
            if (field >= 8 && r >= _t.ComebackFromRank && _t.Phrases.ContainsKey("comeback_win")) return "comeback_win";
            if (field >= 2 && r == 0 && LedFrom(slot, _spurtTick[slot]) && _t.Phrases.ContainsKey("wire_win")) return "wire_win";
            return "finish_win";
        }

        /// <summary>No lead change to another horse from <paramref name="tick"/> on.</summary>
        private bool LedFrom(int slot, int tick)
        {
            foreach (var e in _leaderChanges)
                if (e.Tick >= tick && e.Slot != slot) return false;
            return true;
        }

        private string SkillName(int slot) => slot >= 0 && slot < _cfg.Entrants.Count ? _cfg.Entrants[slot].Horse.Skill?.Name : null;

        private Cand Add(string kind, int tick, int slot)
        {
            string key = PhraseKeyFor(kind);
            var c = new Cand { Kind = kind, Key = key, Slot = slot, CreatedTick = tick, Def = _t.Phrases[key] };
            _pending.Add(c);
            return c;
        }

        private Cand PickNext()
        {
            Cand best = null;
            foreach (var c in _pending)
            {
                if (best == null) { best = c; continue; }
                if (c.Def.MustSay != best.Def.MustSay) { if (c.Def.MustSay) best = c; continue; }
                if (c.Def.Priority > best.Def.Priority || (c.Def.Priority == best.Def.Priority && c.CreatedTick < best.CreatedTick)) best = c;
            }
            _pending.Remove(best);
            return best;
        }

        private bool _en => _t.Language == Loc.En;

        /// <summary>A master name in English ("シンセイアカツキ" → "Shinsei Akatsuki"), else the katakana romanized.</summary>
        private static string EnglishName(string ja)
        {
            if (string.IsNullOrEmpty(ja)) return "";
            var t = Loc.English.Translate(ja);
            return t != null && !Loc.HasJapanese(t) ? t : Romaji.Name(ja);
        }

        private CommentaryLine Speak(Cand c, int tick)
        {
            // variants are chosen from the race seed and the phrase key (a plain kind hashes exactly as before)
            _kindCount.TryGetValue(c.Key, out int n);
            _kindCount[c.Key] = n + 1;
            ulong salt = 0xcbf29ce484222325UL;
            foreach (char ch in c.Key) { salt ^= ch; salt *= 0x100000001b3UL; }
            var variants = c.Def.Variants;
            var v = variants[(int)(SeedMix.Derive(_cfg.Seed, salt, (ulong)n) % (ulong)variants.Count)];

            var text = new StringBuilder();
            var clips = new List<string>();
            foreach (var p in v.Parts)
            {
                if (p.ClipId != null) { text.Append(p.Text); clips.Add(p.ClipId); continue; }
                if (p.Placeholder == "place") { text.Append(_en ? Loc.Ordinal(c.Place) : c.Place.ToString(System.Globalization.CultureInfo.InvariantCulture)); clips.Add("num:" + c.Place); continue; }
                if (p.Placeholder == "skill")
                {
                    // skill names are pre-generated per skill like horse names ("skill:<skillId>")
                    var sk = c.Slot >= 0 && c.Slot < _cfg.Entrants.Count ? _cfg.Entrants[c.Slot].Horse.Skill : null;
                    text.Append(_en ? EnglishName(sk?.Name) : sk?.Name ?? "");
                    clips.Add("skill:" + (sk?.Id ?? "?"));
                    continue;
                }
                int slot = p.Placeholder == "name" ? c.Slot : p.Placeholder == "name2" ? c.Slot2 : c.Slot3;
                var horse = slot >= 0 && slot < _cfg.Entrants.Count ? _cfg.Entrants[slot].Horse : null;
                text.Append(_en ? EnglishName(horse?.Name) : horse?.Name ?? "");
                clips.Add("name:" + (horse?.Id ?? "?"));
            }
            string s = text.ToString();
            int dur = Math.Max(_t.MinLineTicks, s.Length * _t.TicksPerChar) + _t.GapTicks;
            var line = new CommentaryLine
            {
                Tick = tick, Kind = c.Kind, PhraseKey = c.Key, VariantId = v.Id, Slot = c.Slot, Priority = c.Def.Priority,
                DurationTicks = dur, Text = s, ClipKeys = clips.ToArray(),
            };
            _busyUntil = tick + dur;
            _current = line;
            _lines.Add(line);
            return line;
        }
    }
}
