using System;
using System.Collections.Generic;
using Muchi.Engine;
using Muchi.Net;

namespace Muchi.Client
{
    // =====================================================================================================
    // Time attack + ghosts (REQ-TA-*).
    //
    // Flow: StartTimeAttackAsync → TimeAttackRun (OfflineRace on the device, ghosts alongside) →
    // SubmitTimeAttackAsync (inputs only; the server re-simulates the config it issued with the same engine).
    //
    // Ghosts are SEPARATE simulations: each ghost is its own RaceSim built from the ghost's verified replay
    // log (its own config: horse, seed, ruleset) and fed its recorded inputs. Nothing a ghost does can affect
    // the player's horse (no slipstream, no blocking), so the player's run stays exactly reproducible from
    // the issued config + the player's inputs, and every ghost reproduces its recorded finish bit for bit.
    // Ghosts are stepped tick-by-tick in lockstep with the player's race (same tick index).
    // =====================================================================================================

    /// <summary>A time attack session issued by the server (POST /v1/time-attack/start).</summary>
    /// <summary>Server limits for time attack submissions (server/master/progression.json timeAttack).</summary>
    public static class TimeAttackLimits
    {
        /// <summary>Most input records a submission may carry (timeAttack.maxInputs).</summary>
        public const int MaxInputs = 400;
    }

    public sealed class TimeAttackSession
    {
        public string SessionId, Token;
        public RaceConfig Config;
        /// <summary>The config exactly as received, echoed back on submit so the server can detect tampering.</summary>
        public JsonNode ConfigJson;
        public long ExpiresAt;
        public int AttemptsLeft;
        internal static TimeAttackSession Parse(JsonNode o)
        {
            var cfg = J.Opt(o, "config");
            return new TimeAttackSession
            {
                SessionId = J.Str(o, "sessionId"), Token = J.Str(o, "token"), ExpiresAt = J.Long(o, "expiresAt"), AttemptsLeft = J.Int(o, "attemptsLeft"),
                ConfigJson = cfg, Config = cfg == null ? null : ProtocolCodec.ParseConfig(cfg),
            };
        }
    }

    public sealed class TimeAttackMilestone
    {
        public string Id;
        public long? MaxTimeMs;
        public Reward Reward;
        public bool Reached;
        internal static TimeAttackMilestone Parse(JsonNode o) => new TimeAttackMilestone
        {
            Id = J.Str(o, "id"), MaxTimeMs = J.LongN(o, "maxTimeMs"), Reward = Reward.Parse(J.Opt(o, "reward")), Reached = J.Bool(o, "reached"),
        };
    }

    /// <summary>Result of a verified submission (POST /v1/time-attack/submit).</summary>
    public sealed class TimeAttackResult
    {
        public string SessionId, TrackId, SeasonId, ResultHash;
        public bool Finished, SeasonBest, AllTimeBest, Published;
        public long? TimeMs, PreviousSeasonBestMs;
        public int? FinishTick, FinishFrac;
        public List<TimeAttackMilestone> Milestones = new List<TimeAttackMilestone>();
        internal static TimeAttackResult Parse(JsonNode o) => new TimeAttackResult
        {
            SessionId = J.Str(o, "sessionId"), TrackId = J.Str(o, "trackId"), SeasonId = J.Str(o, "seasonId"), ResultHash = J.Str(o, "resultHash"),
            Finished = J.Bool(o, "finished"), SeasonBest = J.Bool(o, "seasonBest"), AllTimeBest = J.Bool(o, "allTimeBest"), Published = J.Bool(o, "published"),
            TimeMs = J.LongN(o, "timeMs"), PreviousSeasonBestMs = J.LongN(o, "previousSeasonBestMs"),
            FinishTick = J.IntN(o, "finishTick"), FinishFrac = J.IntN(o, "finishFrac"),
            Milestones = J.List(o, "milestones", TimeAttackMilestone.Parse),
        };
    }

    public sealed class TimeAttackBest
    {
        public long TimeMs, At;
        public int FinishTick, FinishFrac;
        public string SessionId, HorseId, HorseName;
        internal static TimeAttackBest Parse(JsonNode o) => o == null ? null : new TimeAttackBest
        {
            TimeMs = J.Long(o, "timeMs"), At = J.Long(o, "at"), FinishTick = J.Int(o, "finishTick"), FinishFrac = J.Int(o, "finishFrac"),
            SessionId = J.Str(o, "sessionId"), HorseId = J.Str(o, "horseId"), HorseName = J.Str(o, "horseName"),
        };
    }

    /// <summary>GET /v1/time-attack/:trackId/me</summary>
    public sealed class TimeAttackMe
    {
        public string TrackId, SeasonId;
        public TimeAttackBest SeasonBest, AllTimeBest;
        public int AttemptsLeft;
        /// <summary>Rank as of the last leaderboard snapshot (null before the first one).</summary>
        public int? Rank, Total;
        public List<TimeAttackMilestone> Milestones = new List<TimeAttackMilestone>();
        internal static TimeAttackMe Parse(JsonNode o)
        {
            var r = J.Opt(o, "rank");
            return new TimeAttackMe
            {
                TrackId = J.Str(o, "trackId"), SeasonId = J.Str(o, "seasonId"), AttemptsLeft = J.Int(o, "attemptsLeft"),
                SeasonBest = TimeAttackBest.Parse(J.Opt(o, "seasonBest")), AllTimeBest = TimeAttackBest.Parse(J.Opt(o, "allTimeBest")),
                Rank = r == null ? (int?)null : J.Int(r, "rank"), Total = r == null ? (int?)null : J.Int(r, "total"),
                Milestones = J.List(o, "milestones", TimeAttackMilestone.Parse),
            };
        }
    }

    public enum GhostKind { Top, Friends, Me }

    public sealed class GhostEntry
    {
        public string PlayerId, DisplayName, HorseName, Path;
        public long TimeMs;
        public int? Rank;
        internal static GhostEntry Parse(JsonNode o) => new GhostEntry
        {
            PlayerId = J.Str(o, "playerId"), DisplayName = J.Str(o, "displayName"), HorseName = J.Str(o, "horseName"), Path = J.Str(o, "path"),
            TimeMs = J.Long(o, "timeMs"), Rank = J.IntN(o, "rank"),
        };
    }

    /// <summary>GET /v1/time-attack/:trackId/ghosts</summary>
    public sealed class GhostList
    {
        public string SeasonId, TrackId, Kind;
        public List<GhostEntry> Ghosts = new List<GhostEntry>();
        internal static GhostList Parse(JsonNode o) => new GhostList
        {
            SeasonId = J.Str(o, "seasonId"), TrackId = J.Str(o, "trackId"), Kind = J.Str(o, "kind"), Ghosts = J.List(o, "ghosts", GhostEntry.Parse),
        };
    }

    public sealed class GhostMeta
    {
        public string PlayerId, DisplayName, HorseName, SeasonId, TrackId;
        public long TimeMs;
        public int FinishTick, FinishFrac;
        internal static GhostMeta Parse(JsonNode o) => o == null ? null : new GhostMeta
        {
            PlayerId = J.Str(o, "playerId"), DisplayName = J.Str(o, "displayName"), HorseName = J.Str(o, "horseName"),
            SeasonId = J.Str(o, "seasonId"), TrackId = J.Str(o, "trackId"), TimeMs = J.Long(o, "timeMs"),
            FinishTick = J.Int(o, "finishTick"), FinishFrac = J.Int(o, "finishFrac"),
        };
    }

    /// <summary>A verified run: metadata + the replay log (config + inputs) it was verified from.</summary>
    public sealed class Ghost
    {
        public GhostMeta Meta;
        public ReplayLog Log;
        /// <summary>Public so a downloaded ghost can be cached on disk and loaded again offline.</summary>
        public static Ghost Parse(JsonNode o) => new Ghost { Meta = GhostMeta.Parse(J.Opt(o, "meta")), Log = ProtocolCodec.ParseReplayLog(o.Get("log")) };
    }

    /// <summary>
    /// Replays a ghost (its own RaceSim + recorded inputs) in lockstep with the player's race. Rendering
    /// reads <see cref="Horse"/>/<see cref="PreviousHorse"/> like any other horse; it never interacts.
    /// </summary>
    public sealed class GhostPlayer
    {
        private readonly Dictionary<int, byte> _cmdByTick = new Dictionary<int, byte>();
        private readonly byte[] _cmds;
        private readonly int _slot;

        public RaceSim Sim { get; }
        public GhostMeta Meta { get; }

        public GhostPlayer(ReplayLog log, GhostMeta meta = null, int slot = 0)
        {
            if (log == null) throw new ArgumentNullException(nameof(log));
            log.Config.Validate();
            if (slot < 0 || slot >= log.Config.Entrants.Count) throw new ArgumentException("ghost slot out of range");
            Sim = new RaceSim(log.Config);
            Meta = meta;
            _slot = slot;
            _cmds = new byte[log.Config.Entrants.Count];
            foreach (var r in log.Inputs)
            {
                if (r.Slot != slot) continue;
                _cmdByTick.TryGetValue(r.Tick, out var c);
                _cmdByTick[r.Tick] = (byte)(c | r.Cmd);
            }
        }

        public GhostPlayer(Ghost g) : this(g.Log, g.Meta) { }

        public HorseState Horse => Sim.GetHorse(_slot);
        public HorseState PreviousHorse => Sim.GetPreviousHorse(_slot);
        public bool Finished => Sim.GetHorse(_slot).Finished;

        /// <summary>Simulate up to and including <paramref name="tick"/> (no-op once the ghost has finished).</summary>
        public void AdvanceTo(int tick)
        {
            while (!Sim.IsFinished && Sim.Tick <= tick)
            {
                Array.Clear(_cmds, 0, _cmds.Length);
                if (_cmdByTick.TryGetValue(Sim.Tick, out var c)) _cmds[_slot] = c;
                Sim.Step(_cmds);
            }
        }

        /// <summary>Run to the end (e.g. to show the ghost's final time before the race).</summary>
        public void RunToEnd() => AdvanceTo(int.MaxValue - 1);

        /// <summary>Race time in ms from the gate opening (same formula as OfflineRace.FinishTimeMs / the server).</summary>
        public long FinishTimeMs
        {
            get
            {
                var h = Sim.GetHorse(_slot);
                if (!h.Finished) return -1;
                int msPerTick = 1000 / Sim.Config.Net.TickHz;
                return (long)(h.FinishTick - Sim.P.GateOpenTick) * msPerTick + (long)h.FinishFracRaw * msPerTick / 65536;
            }
        }
    }

    /// <summary>
    /// One time attack attempt on the device: the player's OfflineRace plus any number of ghosts stepped
    /// alongside it. Submit with <see cref="ApiClient.SubmitTimeAttackAsync(TimeAttackSession, OfflineRace, System.Threading.CancellationToken)"/>.
    /// </summary>
    public sealed class TimeAttackRun
    {
        public TimeAttackSession Session { get; }
        public OfflineRace Race { get; }
        public List<GhostPlayer> Ghosts { get; } = new List<GhostPlayer>();

        public TimeAttackRun(TimeAttackSession session)
        {
            Session = session ?? throw new ArgumentNullException(nameof(session));
            if (session.Config.Mode != RaceMode.TimeAttack) throw new ArgumentException("not a time attack config");
            Race = new OfflineRace(session.Config, 0) { MaxRecordedInputs = TimeAttackLimits.MaxInputs };
            Race.TicksAdvanced += (_, lastTick) => { foreach (var g in Ghosts) g.AdvanceTo(lastTick); };
        }

        public GhostPlayer AddGhost(Ghost g)
        {
            var gp = new GhostPlayer(g);
            gp.AdvanceTo(Race.Sim.Tick - 1); // catch up if added mid-race
            Ghosts.Add(gp);
            return gp;
        }

        /// <summary>Advance exactly one tick (player + ghosts). Tests and "skip" use this; real play uses Race.Update.</summary>
        public void StepOnce()
        {
            if (Race.IsFinished) return;
            Race.StepOnce();
            foreach (var g in Ghosts) g.AdvanceTo(Race.Sim.Tick - 1);
        }

        public long FinishTimeMs => Race.FinishTimeMs(0);
    }
}
