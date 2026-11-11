using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Engine;
using Muchi.Net;

namespace Muchi.Client
{
    // =====================================================================================================
    // マイリプレイ (REQ-MYRP-001..016, contracts/protocol.md §37, server/src/domain/myReplays.ts).
    //
    // The server keeps only the §7 replay log and the result hash. ReplayPlayer re-simulates the whole race on the
    // device (REQ-RACE-073), checks the hash, and only then plays it: 0.5x / 1x / 2x, the camera on any horse, jump to
    // the last 200 m. A retired / unknown ruleset (server) or a hash mismatch (device) shows 「再生できません」 — a
    // different race is never shown. Titles are what the player typed: never translated or romanized.
    // =====================================================================================================

    /// <summary>
    /// REQ-MYRP-008: how another human is named in anything replayed or photographed from a race — <c>p&lt;slot&gt;</c>
    /// (0-based slot), the same rule as the server's <c>maskedPlayerId</c> (myReplays.ts). Saved replays arrive already
    /// masked; photo mode (§38, <see cref="PhotoNames"/>) names plates through this one helper.
    /// </summary>
    public static class ReplayPrivacy
    {
        public static string MaskedId(int slot) => "p" + slot.ToString(System.Globalization.CultureInfo.InvariantCulture);
        /// <summary>True for an id this rule produced (a saved replay's other players).</summary>
        public static bool IsMasked(string playerId)
            => playerId != null && playerId.Length > 1 && playerId[0] == 'p' && int.TryParse(playerId.Substring(1), System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var n) && MaskedId(n) == playerId;
    }

    /// <summary>Why a replay cannot be played (server `reason`, plus the device's own checks).</summary>
    public static class ReplayUnplayable
    {
        public const string RulesetRetired = "ruleset_retired";
        public const string RulesetUnknown = "ruleset_unknown";
        /// <summary>Re-simulated on this device, the result hash differs (another engine build): never play it.</summary>
        public const string HashMismatch = "hash_mismatch";
        /// <summary>The log could not be read (corrupt or a format this build does not know).</summary>
        public const string Broken = "broken";
    }

    /// <summary>A recent race / best moment (GET /v1/replays `moments` and `recent`).</summary>
    public class ReplayRace
    {
        public string RaceId, Mode, TrackId, Moment, RulesetVersion, ResultHash;
        public long At;
        public int Place, FieldSize, Slot;
        /// <summary>Recent races only: already in the saved list.</summary>
        public bool Saved;
        /// <summary>Recent races only: when it can no longer be saved (the real time, never a countdown pitch).</summary>
        public long? ExpiresAt;
        public bool IsMoment => !string.IsNullOrEmpty(Moment);

        internal void Fill(JsonNode o)
        {
            RaceId = J.Str(o, "raceId"); Mode = J.Str(o, "mode"); TrackId = J.Str(o, "trackId"); Moment = J.Str(o, "moment");
            RulesetVersion = J.Str(o, "rulesetVersion"); ResultHash = J.Str(o, "resultHash"); At = J.Long(o, "at");
            Place = J.Int(o, "place"); FieldSize = J.Int(o, "fieldSize"); Slot = J.Int(o, "slot"); Saved = J.Bool(o, "saved"); ExpiresAt = J.LongN(o, "expiresAt");
        }
        internal static ReplayRace Parse(JsonNode o) { var r = new ReplayRace(); r.Fill(o); return r; }
    }

    /// <summary>A saved replay (own list, or a friend's public one — then <see cref="Favorite"/> is always false).</summary>
    public sealed class SavedReplay : ReplayRace
    {
        /// <summary>What the player typed (null = no title: show the course and place). Never translated.</summary>
        public string ReplayTitle;
        public bool Favorite, Public, Playable;
        public string Reason;
        public long SavedAt;
        public int SizeBytes;
        internal static SavedReplay ParseSaved(JsonNode o)
        {
            var r = new SavedReplay
            {
                ReplayTitle = J.Str(o, "replayTitle"), Favorite = J.Bool(o, "favorite"), Public = J.Bool(o, "public"),
                Playable = J.Bool(o, "playable", true), Reason = J.Str(o, "reason"), SavedAt = J.Long(o, "savedAt"), SizeBytes = J.Int(o, "sizeBytes"),
            };
            r.Fill(o);
            return r;
        }
    }

    /// <summary>GET /v1/replays.</summary>
    public sealed class MyReplaysView
    {
        public bool Enabled;
        public int MaxSaved, Used, TitleMaxChars;
        public List<SavedReplay> Saved = new List<SavedReplay>();
        public List<ReplayRace> Moments = new List<ReplayRace>();
        public List<ReplayRace> Recent = new List<ReplayRace>();
        public bool Full => Used >= MaxSaved;
        internal static MyReplaysView Parse(JsonNode o) => new MyReplaysView
        {
            Enabled = J.Bool(o, "enabled"), MaxSaved = J.Int(o, "maxSaved"), Used = J.Int(o, "used"), TitleMaxChars = J.Int(o, "titleMaxChars"),
            Saved = J.List(o, "saved", SavedReplay.ParseSaved), Moments = J.List(o, "moments", ReplayRace.Parse), Recent = J.List(o, "recent", ReplayRace.Parse),
        };
        public static MyReplaysView FromJson(string json) => Parse(JsonNode.Parse(json));
    }

    public sealed class ReplaySaveResult
    {
        public SavedReplay Saved;
        public bool AlreadySaved;
        public MyReplaysView View;
        internal static ReplaySaveResult Parse(JsonNode o) => new ReplaySaveResult { Saved = SavedReplay.ParseSaved(J.Opt(o, "saved")), AlreadySaved = J.Bool(o, "alreadySaved"), View = MyReplaysView.Parse(J.Opt(o, "view")) };
    }

    public sealed class ReplayDeleteResult
    {
        public bool Deleted;
        public MyReplaysView View;
        internal static ReplayDeleteResult Parse(JsonNode o) => new ReplayDeleteResult { Deleted = J.Bool(o, "deleted"), View = MyReplaysView.Parse(J.Opt(o, "view")) };
    }

    /// <summary>A friend's public replays (GET /v1/friends/:playerId/replays).</summary>
    public sealed class FriendReplays
    {
        public string PlayerId, DisplayName;
        public List<SavedReplay> Replays = new List<SavedReplay>();
        internal static FriendReplays Parse(JsonNode o) => new FriendReplays { PlayerId = J.Str(o, "playerId"), DisplayName = J.Str(o, "displayName"), Replays = J.List(o, "replays", SavedReplay.ParseSaved) };
    }

    /// <summary>One horse of a replay: its name and who rode it (never another player's name or id).</summary>
    public sealed class ReplayEntrant
    {
        public int Slot;
        public string HorseName;
        /// <summary>you | player | cpu | owner_player (the friend whose replay it is).</summary>
        public string Owner;
        internal static ReplayEntrant Parse(JsonNode o) => new ReplayEntrant { Slot = J.Int(o, "slot"), HorseName = J.Str(o, "horseName"), Owner = J.Str(o, "owner") };
    }

    /// <summary>GET /v1/replays/:raceId/data (or a friend's). <see cref="Log"/> is null when it could not be read.</summary>
    public sealed class ReplayData
    {
        public string RaceId, Owner, ReplayTitle, ResultHash, RulesetVersion, Reason, OwnerName;
        public int FocusSlot;
        public bool Playable;
        public List<ReplayEntrant> Entrants = new List<ReplayEntrant>();
        public ReplayLog Log;
        public string LogError;
        /// <summary>REQ-CHEER-012 (§55.6): 「応援の多かった瞬間」 markers in race order (empty: nobody cheered, or an older server).</summary>
        public List<CheerMoment> CheerMoments = new List<CheerMoment>();

        internal static ReplayData Parse(JsonNode o)
        {
            var d = new ReplayData
            {
                RaceId = J.Str(o, "raceId"), Owner = J.Str(o, "owner"), ReplayTitle = J.Str(o, "replayTitle"), ResultHash = J.Str(o, "resultHash"),
                RulesetVersion = J.Str(o, "rulesetVersion"), Playable = J.Bool(o, "playable"), Reason = J.Str(o, "reason"), OwnerName = J.Str(o, "ownerName"),
                FocusSlot = J.Int(o, "focusSlot"), Entrants = J.List(o, "entrants", ReplayEntrant.Parse),
                CheerMoments = J.List(o, "cheerMoments", CheerMoment.Parse),
            };
            try { var l = J.Opt(o, "replayLog"); d.Log = l == null ? null : ProtocolCodec.ParseReplayLog(l); }
            catch (Exception e) { d.Log = null; d.LogError = e.Message; } // an unknown ruleset key / format: unplayable, never a crash
            return d;
        }
        public static ReplayData FromJson(string json) => Parse(JsonNode.Parse(json));
    }

    public sealed partial class ApiClient
    {
        /// <summary>REQ-MYRP-006: the saved list, best moments and recent races.</summary>
        public Task<MyReplaysView> GetMyReplaysAsync(CancellationToken ct = default)
            => Call("GET", "/v1/replays", null, true, null, true, MyReplaysView.Parse, ct);

        /// <summary>
        /// REQ-MYRP-003: save one of the player's recent races (keyed: reuse the key until an answer arrives). ConflictException
        /// REPLAY_LIMIT (the free slots are full), DELETION_PENDING; 410 REPLAY_EXPIRED; 400 INVALID_NAME / NG_NAME for the title.
        /// </summary>
        public Task<ReplaySaveResult> SaveReplayAsync(string raceId, string replayTitle = null, string idempotencyKey = null, CancellationToken ct = default)
        {
            var b = JsonNode.Obj().Set("raceId", raceId);
            if (replayTitle != null) b.Set("replayTitle", replayTitle);
            return Call("POST", "/v1/replays", b, true, idempotencyKey ?? NewIdempotencyKey(), true, ReplaySaveResult.Parse, ct);
        }

        /// <summary>
        /// REQ-MYRP-005: rename (<paramref name="clearTitle"/> removes the title), favourite and public toggles. Value replacements:
        /// safe to retry. Pass only what changes (null = unchanged).
        /// </summary>
        public Task<SavedReplay> UpdateReplayAsync(string raceId, string replayTitle = null, bool clearTitle = false, bool? favorite = null, bool? isPublic = null, CancellationToken ct = default)
        {
            var b = JsonNode.Obj();
            if (clearTitle) b.Set("replayTitle", JsonNode.Null());
            else if (replayTitle != null) b.Set("replayTitle", replayTitle);
            if (favorite.HasValue) b.Set("favorite", favorite.Value);
            if (isPublic.HasValue) b.Set("public", isPublic.Value);
            if (b.Count == 0) throw new ArgumentException("nothing to change");
            return Call("PATCH", "/v1/replays/" + Uri.EscapeDataString(raceId), b, true, null, true, o => SavedReplay.ParseSaved(J.Opt(o, "saved")), ct);
        }

        /// <summary>REQ-MYRP-005: delete a saved replay (deleting one that is not there answers Deleted = false).</summary>
        public Task<ReplayDeleteResult> DeleteReplayAsync(string raceId, CancellationToken ct = default)
            => Call("DELETE", "/v1/replays/" + Uri.EscapeDataString(raceId), null, true, null, true, ReplayDeleteResult.Parse, ct);

        /// <summary>REQ-MYRP-008: the log of a saved replay, best moment or recent race (410 REPLAY_EXPIRED once the source is gone).</summary>
        public Task<ReplayData> GetReplayDataAsync(string raceId, CancellationToken ct = default)
            => Call("GET", "/v1/replays/" + Uri.EscapeDataString(raceId) + "/data", null, true, null, true, ReplayData.Parse, ct);

        /// <summary>REQ-MYRP-010: a friend's public replays (404 when hidden — never says why).</summary>
        public Task<FriendReplays> GetFriendReplaysAsync(string playerId, CancellationToken ct = default)
            => Call("GET", "/v1/friends/" + Uri.EscapeDataString(playerId) + "/replays", null, true, null, true, FriendReplays.Parse, ct);

        public Task<ReplayData> GetFriendReplayDataAsync(string playerId, string raceId, CancellationToken ct = default)
            => Call("GET", "/v1/friends/" + Uri.EscapeDataString(playerId) + "/replays/" + Uri.EscapeDataString(raceId) + "/data", null, true, null, true, ReplayData.Parse, ct);
    }

    /// <summary>One frame of a full replay: two engine states per horse and the interpolation, plus the camera on the chosen horse.</summary>
    public sealed class ReplayPlayerFrame
    {
        public int TimeMs, Tick, AlphaPermille;
        /// <summary>Per slot. Shared read-only arrays: do not modify.</summary>
        public HorseState[] From, To;
        public RaceCameraShot Camera;
        public int CameraSlot;
        /// <summary>Metres the camera horse has left (0 once finished).</summary>
        public double RemainingM;
        /// <summary>1-based place of the camera horse at this frame.</summary>
        public int Rank;
        public bool Finished;
    }

    /// <summary>
    /// REQ-MYRP-009: plays a whole saved race, re-simulated on the device. <see cref="Open"/> never throws: check
    /// <see cref="Playable"/> / <see cref="Reason"/> and show 「再生できません」 otherwise.
    /// </summary>
    public sealed class ReplayPlayer
    {
        public static readonly double[] Speeds = { 0.5, 1.0, 2.0 };
        public const int FinalStretchM = 200;

        private readonly List<HorseState[]> _states; // _states[t] = all horses when sim.Tick == t
        private readonly int _msPerTick;
        private readonly RaceCameraRig _rig;
        private double _timeMs;

        public bool Playable { get; }
        public string Reason { get; }
        public ReplayData Data { get; }
        public RaceConfig Config { get; }
        public RaceResult Result { get; }
        /// <summary>The player's own horse (the server's focusSlot): the default camera and the share card's horse.</summary>
        public int OwnSlot { get; }
        public int CameraSlot { get; private set; }
        public double Speed { get; private set; } = 1.0;
        public bool Paused { get; set; }
        public int EndTick => _states == null ? 0 : _states.Count - 1;
        public int DurationMs => EndTick * _msPerTick;
        public int TimeMs => (int)_timeMs;
        public bool AtEnd => Playable && _timeMs >= DurationMs;

        private ReplayPlayer(ReplayData data, string reason)
        {
            Data = data; Playable = false; Reason = reason;
        }

        private ReplayPlayer(ReplayData data, RaceConfig config, List<HorseState[]> states, RaceResult result, TrackVisual visual)
        {
            Data = data; Config = config; _states = states; Result = result; Playable = true;
            _msPerTick = 1000 / config.Net.TickHz;
            _rig = RaceCameraRig.For(config, visual);
            OwnSlot = data.FocusSlot >= 0 && data.FocusSlot < config.Entrants.Count ? data.FocusSlot : 0;
            CameraSlot = OwnSlot;
        }

        /// <summary>Re-simulate and verify. The server's verdict (retired / unknown ruleset) wins; then the log, then the hash.</summary>
        public static ReplayPlayer Open(ReplayData data, TrackVisual visual = null)
        {
            if (data == null) throw new ArgumentNullException(nameof(data));
            if (!data.Playable) return new ReplayPlayer(data, string.IsNullOrEmpty(data.Reason) ? ReplayUnplayable.RulesetUnknown : data.Reason);
            if (data.Log == null) return new ReplayPlayer(data, ReplayUnplayable.Broken);
            try
            {
                var cfg = data.Log.Config;
                cfg.Validate();
                var byTick = new SortedDictionary<int, List<InputRecord>>();
                foreach (var r in data.Log.Inputs)
                {
                    if (r.Slot < 0 || r.Slot >= cfg.Entrants.Count || r.Tick < 0 || r.Tick >= cfg.Ruleset.MaxTicks) return new ReplayPlayer(data, ReplayUnplayable.Broken);
                    if (!byTick.TryGetValue(r.Tick, out var list)) byTick[r.Tick] = list = new List<InputRecord>();
                    list.Add(r);
                }
                var sim = new RaceSim(cfg);
                int n = cfg.Entrants.Count;
                var cmds = new byte[n];
                var states = new List<HorseState[]>(cfg.Ruleset.MaxTicks / 4);
                while (true)
                {
                    var row = new HorseState[n];
                    for (int s = 0; s < n; s++) row[s] = sim.GetHorse(s);
                    states.Add(row);
                    if (sim.IsFinished) break;
                    Array.Clear(cmds, 0, n);
                    if (byTick.TryGetValue(sim.Tick, out var list)) foreach (var r in list) cmds[r.Slot] |= r.Cmd;
                    sim.Step(cmds);
                }
                // same stepping as RaceReplay.Run: the hash is the race the room confirmed, or nothing is shown
                if (string.IsNullOrEmpty(data.ResultHash) || !string.Equals(data.ResultHash, sim.Result.Hash, StringComparison.OrdinalIgnoreCase))
                    return new ReplayPlayer(data, ReplayUnplayable.HashMismatch);
                return new ReplayPlayer(data, cfg, states, sim.Result, visual);
            }
            catch (Exception)
            {
                return new ReplayPlayer(data, ReplayUnplayable.Broken);
            }
        }

        private void RequirePlayable() { if (!Playable) throw new InvalidOperationException("replay is not playable: " + Reason); }

        /// <summary>0.5, 1 or 2 (anything else throws).</summary>
        public void SetSpeed(double speed)
        {
            if (Array.IndexOf(Speeds, speed) < 0) throw new ArgumentException("speed must be 0.5, 1 or 2");
            Speed = speed;
        }

        /// <summary>The next speed in 0.5 → 1 → 2 → 0.5 (the speed button).</summary>
        public double CycleSpeed()
        {
            int i = Array.IndexOf(Speeds, Speed);
            Speed = Speeds[(i + 1) % Speeds.Length];
            return Speed;
        }

        /// <summary>Camera on any horse.</summary>
        public void SetCamera(int slot)
        {
            RequirePlayable();
            if (slot < 0 || slot >= Config.Entrants.Count) throw new ArgumentOutOfRangeException(nameof(slot));
            CameraSlot = slot;
        }

        /// <summary>Advance by <paramref name="realMs"/> of wall time (× speed; nothing while paused or at the end).</summary>
        public void Advance(double realMs)
        {
            RequirePlayable();
            if (Paused || realMs <= 0) return;
            _timeMs = Math.Min(DurationMs, _timeMs + realMs * Speed);
        }

        public void Seek(int timeMs)
        {
            RequirePlayable();
            _timeMs = Math.Max(0, Math.Min(DurationMs, timeMs));
        }

        /// <summary>The time at which <paramref name="slot"/> has <see cref="FinalStretchM"/> m left (the start for a horse that never gets there... the end).</summary>
        public int FinalStretchTimeMs(int slot)
        {
            RequirePlayable();
            long target = (long)(Config.Track.DistanceM - FinalStretchM) * 1000;
            for (int t = 0; t < _states.Count; t++)
            {
                var h = _states[t][slot];
                if (h.Departed && h.Distance.ToMilli() >= target) return t * _msPerTick;
            }
            return DurationMs;
        }

        /// <summary>「最後の200mへ」: jump to the camera horse's last 200 m.</summary>
        public void JumpToFinalStretch() => Seek(FinalStretchTimeMs(CameraSlot));

        /// <summary>The frame at the current time.</summary>
        public ReplayPlayerFrame Frame() => FrameAt(TimeMs);

        public ReplayPlayerFrame FrameAt(int timeMs)
        {
            RequirePlayable();
            int t = Math.Max(0, Math.Min(DurationMs, timeMs));
            int whole = t / _msPerTick;
            int alpha = (t % _msPerTick) * 1000 / _msPerTick;
            int i = Math.Min(_states.Count - 1, whole + 1);
            int j = Math.Max(0, i - 1);
            if (whole + 1 > _states.Count - 1) alpha = 1000;
            var from = _states[j];
            var to = _states[i];
            var c0 = from[CameraSlot]; var c1 = to[CameraSlot];
            double rem0 = Config.Track.DistanceM - TrackGeometry.DistanceM(c0.Distance), rem1 = Config.Track.DistanceM - TrackGeometry.DistanceM(c1.Distance);
            return new ReplayPlayerFrame
            {
                TimeMs = t, Tick = i, AlphaPermille = alpha, From = from, To = to, CameraSlot = CameraSlot, Camera = _rig.Shot(c0, c1, alpha),
                RemainingM = Math.Max(0, rem0 + (rem1 - rem0) * alpha / 1000.0), Rank = c1.Rank + 1, Finished = c1.Finished,
            };
        }

        /// <summary>Course-space pose of a horse in a frame (Unity converts it with CourseFrame like the live race).</summary>
        public TrackPose PoseOf(ReplayPlayerFrame f, int slot)
        {
            double a = f.AlphaPermille / 1000.0;
            var h0 = f.From[slot]; var h1 = f.To[slot];
            int lw = Config.Ruleset.LaneWidthMm;
            double d = TrackGeometry.DistanceM(h0.Distance) + (TrackGeometry.DistanceM(h1.Distance) - TrackGeometry.DistanceM(h0.Distance)) * a;
            double l = TrackGeometry.LateralM(h0.Lane, lw) + (TrackGeometry.LateralM(h1.Lane, lw) - TrackGeometry.LateralM(h0.Lane, lw)) * a;
            return _rig.Geometry.PoseAt(d, l);
        }

        /// <summary>The share card for the player's own horse (REQ-UXS-071 reuse: the last 200 m clip, the same hash check).</summary>
        public ShareCard BuildShareCard(string courseName = null, TrackVisual visual = null)
        {
            RequirePlayable();
            var clip = ReplayClip.Build(Config, Data.Log.Inputs, OwnSlot, null, visual, Data.ResultHash);
            return ShareCard.Build(clip, courseName);
        }

        /// <summary>The last-200 m clip (the share video), focus on the player's own horse.</summary>
        public ReplayClip BuildClip(ReplayClipOptions options = null, TrackVisual visual = null)
        {
            RequirePlayable();
            return ReplayClip.Build(Config, Data.Log.Inputs, OwnSlot, options, visual, Data.ResultHash);
        }
    }
}
