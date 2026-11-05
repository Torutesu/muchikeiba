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
        /// <summary>name, name2, name3 or place; null for fixed text.</summary>
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

    /// <summary>Commentary templates (engine/Muchi.Client/Data/commentary-ja.json). In Unity load the file as a TextAsset.</summary>
    public sealed class CommentaryTemplates
    {
        public int TicksPerChar = 3;
        public int MinLineTicks = 24;
        public int GapTicks = 4;
        public int LeaderStableTicks = 30;
        public int PositionCallIntervalTicks = 240;
        public int PendingExpiryTicks = 60;
        public readonly Dictionary<string, PhraseDef> Phrases = new Dictionary<string, PhraseDef>();

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
                TicksPerChar = J.Int(o, "ticksPerChar", 3),
                MinLineTicks = J.Int(o, "minLineTicks", 24),
                GapTicks = J.Int(o, "gapTicks", 4),
                LeaderStableTicks = J.Int(o, "leaderStableTicks", 30),
                PositionCallIntervalTicks = J.Int(o, "positionCallIntervalTicks", 240),
                PendingExpiryTicks = J.Int(o, "pendingExpiryTicks", 60),
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
                if (ph != "name" && ph != "name2" && ph != "name3" && ph != "place") throw new FormatException("unknown placeholder {" + ph + "} in " + id);
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
        public string VariantId;
        /// <summary>Main subject slot, -1 if none.</summary>
        public int Slot;
        public int Priority;
        public int DurationTicks;
        public string Text;
        /// <summary>Audio clips to play in order: fixed clip ids, "name:&lt;horseId&gt;" and "num:&lt;n&gt;".</summary>
        public string[] ClipKeys;

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
        private bool _spurtSaid, _focusWhipSaid, _anyFinished, _flushed;
        private int _lastPositionCall = -1;

        public IReadOnlyList<CommentaryLine> Lines => _lines;

        /// <param name="focusSlot">The player's horse (its whips, start and place get lines). -1 for spectators.</param>
        public Commentator(CommentaryTemplates templates, RaceConfig config, int focusSlot = -1)
        {
            _t = templates ?? throw new ArgumentNullException(nameof(templates));
            _cfg = config ?? throw new ArgumentNullException(nameof(config));
            _focus = focusSlot;
        }

        /// <summary>Reads new events, returns the lines that start now (often empty).</summary>
        public List<CommentaryLine> Process(RaceSim sim)
        {
            var started = new List<CommentaryLine>();
            int now = sim.Tick - 1;
            var events = sim.Events;
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
                var c = Add("position_call", now, sim.SlotAtRank(0));
                c.Slot2 = sim.SlotAtRank(1);
                c.Slot3 = sim.SlotAtRank(2);
                _lastPositionCall = now;
            }

            _pending.RemoveAll(c => !c.Def.MustSay && now - c.CreatedTick > _t.PendingExpiryTicks);

            if (now >= _busyUntil && _pending.Count > 0) started.Add(Speak(PickNext(), now));

            if (sim.IsFinished && !_flushed)
            {
                _flushed = true;
                _pending.RemoveAll(c => !c.Def.MustSay);
                while (_pending.Count > 0) started.Add(Speak(PickNext(), Math.Max(now, _busyUntil)));
            }
            return started;
        }

        private void OnEvent(RaceSim sim, RaceEvent e)
        {
            switch (e.Type)
            {
                case RaceEventType.GateOpen:
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
                    _leader = e.Slot;
                    _leaderSince = e.Tick;
                    break;
                case RaceEventType.Kakari:
                    if (e.Slot == _focus || sim.GetHorse(e.Slot).Rank < 3) Add("kakari", e.Tick, e.Slot);
                    break;
                case RaceEventType.Whip:
                    if (e.Slot == _focus && !_focusWhipSaid) { _focusWhipSaid = true; Add("focus_whip", e.Tick, e.Slot); }
                    break;
                case RaceEventType.SpurtStart:
                    if (!_spurtSaid) { _spurtSaid = true; Add("spurt", e.Tick, e.Slot); }
                    break;
                case RaceEventType.CpuTakeover:
                    if (e.Slot == _focus) Add("cpu_takeover", e.Tick, e.Slot);
                    break;
                case RaceEventType.Finish:
                    if (e.Value == 1)
                    {
                        _anyFinished = true;
                        _pending.RemoveAll(c => c.Kind == "leader" || c.Kind == "position_call" || c.Kind == "kakari");
                        Add("finish_win", e.Tick, e.Slot);
                    }
                    else if (e.Slot == _focus)
                    {
                        Add("focus_finish", e.Tick, e.Slot).Place = e.Value;
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
                    break;
            }
        }

        private Cand Add(string kind, int tick, int slot)
        {
            var c = new Cand { Kind = kind, Slot = slot, CreatedTick = tick, Def = _t.Phrases[kind] };
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

        private CommentaryLine Speak(Cand c, int tick)
        {
            _kindCount.TryGetValue(c.Kind, out int n);
            _kindCount[c.Kind] = n + 1;
            ulong salt = 0xcbf29ce484222325UL;
            foreach (char ch in c.Kind) { salt ^= ch; salt *= 0x100000001b3UL; }
            var variants = c.Def.Variants;
            var v = variants[(int)(SeedMix.Derive(_cfg.Seed, salt, (ulong)n) % (ulong)variants.Count)];

            var text = new StringBuilder();
            var clips = new List<string>();
            foreach (var p in v.Parts)
            {
                if (p.ClipId != null) { text.Append(p.Text); clips.Add(p.ClipId); continue; }
                if (p.Placeholder == "place") { text.Append(c.Place); clips.Add("num:" + c.Place); continue; }
                int slot = p.Placeholder == "name" ? c.Slot : p.Placeholder == "name2" ? c.Slot2 : c.Slot3;
                var horse = slot >= 0 && slot < _cfg.Entrants.Count ? _cfg.Entrants[slot].Horse : null;
                text.Append(horse?.Name ?? "");
                clips.Add("name:" + (horse?.Id ?? "?"));
            }
            string s = text.ToString();
            int dur = Math.Max(_t.MinLineTicks, s.Length * _t.TicksPerChar) + _t.GapTicks;
            var line = new CommentaryLine
            {
                Tick = tick, Kind = c.Kind, VariantId = v.Id, Slot = c.Slot, Priority = c.Def.Priority,
                DurationTicks = dur, Text = s, ClipKeys = clips.ToArray(),
            };
            _busyUntil = tick + dur;
            _lines.Add(line);
            return line;
        }
    }
}
