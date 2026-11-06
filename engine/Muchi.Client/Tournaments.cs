using System;
using System.Collections.Generic;
using Muchi.Engine;
using Muchi.Net;

namespace Muchi.Client
{
    // ------------------------------------------------------------------ spectating (REQ-SPEC-*)

    /// <summary>A race you can watch (GET /v1/races/live).</summary>
    public sealed class LiveRace
    {
        public string RaceId, Mode, TrackId, Visibility, Title, TournamentId;
        public long StartAtMs;
        public int Players, Rating, DelayMs;
        /// <summary>Your friends racing in it.</summary>
        public List<string> Friends = new List<string>();
        /// <summary>You are one of the runners (watching your own race is allowed, e.g. after leaving it).</summary>
        public bool You;
        internal static LiveRace Parse(JsonNode o) => new LiveRace
        {
            RaceId = J.Str(o, "raceId"), Mode = J.Str(o, "mode"), TrackId = J.Str(o, "trackId"), Visibility = J.Str(o, "visibility"), Title = J.Str(o, "title"),
            TournamentId = J.Str(o, "tournamentId"), StartAtMs = J.Long(o, "startAtMs"), Players = J.Int(o, "players"), Rating = J.Int(o, "rating"),
            DelayMs = J.Int(o, "delayMs"), Friends = J.List(o, "friends", x => x.AsString()), You = J.Bool(o, "you"),
        };
    }

    public sealed class LiveRaces
    {
        /// <summary>Races with you or your friends in them (friend rooms included).</summary>
        public List<LiveRace> Friends = new List<LiveRace>();
        /// <summary>Public races: tournament heats first, then the highest rated ranked/event races.</summary>
        public List<LiveRace> Featured = new List<LiveRace>();
        public long GeneratedAt;
        internal static LiveRaces Parse(JsonNode o) => new LiveRaces { Friends = J.List(o, "friends", LiveRace.Parse), Featured = J.List(o, "featured", LiveRace.Parse), GeneratedAt = J.Long(o, "generatedAt") };
    }

    /// <summary>Read-only seat (POST /v1/race/:raceId/spectate): connect to WsPath and hello with Ticket.</summary>
    public sealed class SpectatorTicket
    {
        public string RaceId, Ticket, WsPath, Mode, Title, TournamentId;
        public long StartAtMs;
        /// <summary>The stream runs this far behind the race (0 for friend rooms, 10 s for races with something at stake).</summary>
        public int DelayMs;
        internal static SpectatorTicket Parse(JsonNode o) => new SpectatorTicket
        {
            RaceId = J.Str(o, "raceId"), Ticket = J.Str(o, "ticket"), WsPath = J.Str(o, "wsPath"), Mode = J.Str(o, "mode"), Title = J.Str(o, "title"),
            TournamentId = J.Str(o, "tournamentId"), StartAtMs = J.Long(o, "startAtMs"), DelayMs = J.Int(o, "delayMs"),
        };
    }

    /// <summary>
    /// Watching a live race (REQ-SPEC-002): the same lockstep stream the players get (delayed for ranked, event and
    /// tournament races), simulated locally — so the spectator sees exactly the players' race and can check the
    /// final hash. Never sends inputs. Drive it like <see cref="RaceSession"/>: Start once, Update every frame,
    /// render with <see cref="TryGetRenderState"/> (already shifted by the stream delay).
    /// </summary>
    public sealed class SpectatorSession
    {
        public RaceSession Session { get; }
        public SpectatorTicket Ticket { get; }

        /// <param name="webSocketUrl">From <see cref="ApiClient.SpectatorWebSocketUrl"/>.</param>
        public SpectatorSession(ITransportFactory factory, string webSocketUrl, SpectatorTicket ticket, RaceSessionOptions options = null)
        {
            Ticket = ticket ?? throw new ArgumentNullException(nameof(ticket));
            Session = new RaceSession(factory, webSocketUrl, ticket.RaceId, ticket.Ticket, options);
        }

        public RaceSessionState State => Session.State;
        public RaceSim Sim => Session.Sim;
        public RaceVisuals Visuals => Session.Visuals;
        public FinalMessage Final => Session.Final;
        /// <summary>True once the room accepted us as a spectator (start.you = -1).</summary>
        public bool Accepted => Session.Client.IsSpectator;
        public int DelayMs => Session.Client.IsSpectator ? Session.Client.SpectatorDelayMs : Ticket.DelayMs;
        public bool IsTerminal => Session.IsTerminal;
        /// <summary>Our replay's result hash, to compare with <see cref="Final"/> (same race, same hash).</summary>
        public string LocalHash => Sim != null && Sim.IsFinished ? Sim.Result.Hash : null;

        public void Start(long nowMs) => Session.Start(nowMs);
        public void Update(long nowMs) => Session.Update(nowMs);
        public void Dispose() => Session.Dispose();
        public bool TryGetRenderState(int slot, long nowMs, out HorseState from, out HorseState to, out int alphaPermille)
            => Session.TryGetRenderState(slot, nowMs, out from, out to, out alphaPermille);
    }

    // ------------------------------------------------------------------ tournaments (REQ-TOUR-*)

    public sealed class TournamentSummary
    {
        public string Id, Name;
        /// <summary>"scheduled", "registration", "running", "paying", "finished" or "cancelled".</summary>
        public string Status;
        public long RegistrationOpensAtMs, RegistrationClosesAtMs, StartsAtMs;
        public long? FinishedAt;
        public int Entrants, MaxEntrants, HeatSize;
        internal static TournamentSummary Parse(JsonNode o) => new TournamentSummary
        {
            Id = J.Str(o, "id"), Name = J.Str(o, "name"), Status = J.Str(o, "status"), RegistrationOpensAtMs = J.Long(o, "registrationOpensAtMs"),
            RegistrationClosesAtMs = J.Long(o, "registrationClosesAtMs"), StartsAtMs = J.Long(o, "startsAtMs"), FinishedAt = J.LongN(o, "finishedAt"),
            Entrants = J.Int(o, "entrants"), MaxEntrants = J.Int(o, "maxEntrants"), HeatSize = J.Int(o, "heatSize"),
        };
        internal static List<TournamentSummary> ParseList(JsonNode o) => J.List(o, "tournaments", Parse);
    }

    public sealed class TournamentPrize
    {
        /// <summary>Null = everyone else who raced.</summary>
        public int? MaxRank;
        public Reward Reward;
        internal static TournamentPrize Parse(JsonNode o) => new TournamentPrize { MaxRank = J.IntN(o, "maxRank"), Reward = Reward.Parse(J.Opt(o, "reward")) };
    }

    public sealed class TournamentHeatResult
    {
        public string PlayerId, DisplayName;
        public int? Place;
        public bool NoShow, Advanced;
        internal static TournamentHeatResult Parse(JsonNode o) => new TournamentHeatResult
        {
            PlayerId = J.Str(o, "playerId"), DisplayName = J.Str(o, "displayName"), Place = J.IntN(o, "place"), NoShow = J.Bool(o, "noShow"), Advanced = J.Bool(o, "advanced"),
        };
    }

    public sealed class TournamentHeat
    {
        public string Id, RaceId, TrackId;
        /// <summary>"planned", "created" (racing — watchable), "finished" or "void".</summary>
        public string Status;
        public long StartAtMs;
        public List<string> PlayerIds = new List<string>();
        public List<string> DisplayNames = new List<string>();
        /// <summary>Null until the heat has a result.</summary>
        public List<TournamentHeatResult> Results;
        internal static TournamentHeat Parse(JsonNode o) => new TournamentHeat
        {
            Id = J.Str(o, "id"), RaceId = J.Str(o, "raceId"), TrackId = J.Str(o, "trackId"), Status = J.Str(o, "status"), StartAtMs = J.Long(o, "startAtMs"),
            PlayerIds = J.List(o, "players", x => J.Str(x, "playerId")), DisplayNames = J.List(o, "players", x => J.Str(x, "displayName")),
            Results = J.Opt(o, "results") == null ? null : J.List(o, "results", TournamentHeatResult.Parse),
        };
    }

    public sealed class TournamentRound
    {
        public int Index;
        public bool Final, Done;
        public long StartAtMs;
        public List<TournamentHeat> Heats = new List<TournamentHeat>();
        internal static TournamentRound Parse(JsonNode o) => new TournamentRound
        {
            Index = J.Int(o, "index"), Final = J.Bool(o, "final"), Done = J.Bool(o, "done"), StartAtMs = J.Long(o, "startAtMs"), Heats = J.List(o, "heats", TournamentHeat.Parse),
        };
    }

    public sealed class TournamentStanding
    {
        public string PlayerId, DisplayName;
        /// <summary>Shared ranks for players knocked out in the same round at the same place (1-2-3-3-5).</summary>
        public int Rank, ReachedRound;
        public int? Place;
        public bool Final, NoShow;
        internal static TournamentStanding Parse(JsonNode o) => new TournamentStanding
        {
            PlayerId = J.Str(o, "playerId"), DisplayName = J.Str(o, "displayName"), Rank = J.Int(o, "rank"), ReachedRound = J.Int(o, "reachedRound"),
            Place = J.IntN(o, "place"), Final = J.Bool(o, "final"), NoShow = J.Bool(o, "noShow"),
        };
    }

    public sealed class TournamentDetail
    {
        public TournamentSummary Summary;
        public string Description, CancelReason;
        public List<string> TrackIds = new List<string>();
        public int FieldSize, AdvancePerHeat, MinEntrants;
        public int? StatCap;
        public List<string> EntryClassIds;
        public int EntryMinRankedRaces;
        public List<TournamentPrize> Prizes = new List<TournamentPrize>();
        public List<TournamentRound> Rounds = new List<TournamentRound>();
        /// <summary>Null until the tournament is decided.</summary>
        public List<TournamentStanding> Standings;
        internal static TournamentDetail Parse(JsonNode o)
        {
            var entry = J.Opt(o, "entry");
            return new TournamentDetail
            {
                Summary = TournamentSummary.Parse(o), Description = J.Str(o, "description"), CancelReason = J.Str(o, "cancelReason"),
                TrackIds = J.List(o, "trackIds", x => x.AsString()), FieldSize = J.Int(o, "fieldSize"), AdvancePerHeat = J.Int(o, "advancePerHeat"), MinEntrants = J.Int(o, "minEntrants"),
                StatCap = J.IntN(o, "statCap"), EntryClassIds = J.Opt(entry, "classIds") == null ? null : J.List(entry, "classIds", x => x.AsString()),
                EntryMinRankedRaces = J.Int(entry, "minRankedRaces"), Prizes = J.List(o, "prizes", TournamentPrize.Parse), Rounds = J.List(o, "rounds", TournamentRound.Parse),
                Standings = J.Opt(o, "standings") == null ? null : J.List(o, "standings", TournamentStanding.Parse),
            };
        }
    }

    /// <summary>Your heat in a tournament (GET /v1/tournaments/:id/me).</summary>
    public sealed class MyTournamentHeat
    {
        public int Round;
        public bool Final;
        public string HeatId, RaceId, Status, TrackId;
        public long StartAtMs;
        /// <summary>Set while the heat is racing: join it like any race (also shown by GET /v1/match/status).</summary>
        public RaceAssignment Assignment;
        public int? Place;
        public bool? Advanced;
        internal static MyTournamentHeat Parse(JsonNode o) => o == null ? null : new MyTournamentHeat
        {
            Round = J.Int(o, "round"), Final = J.Bool(o, "final"), HeatId = J.Str(o, "heatId"), RaceId = J.Str(o, "raceId"), Status = J.Str(o, "status"), TrackId = J.Str(o, "trackId"),
            StartAtMs = J.Long(o, "startAtMs"), Assignment = RaceAssignment.Parse(J.Opt(o, "assignment")), Place = J.IntN(o, "place"),
            Advanced = J.Opt(o, "advanced") == null ? (bool?)null : J.Bool(o, "advanced"),
        };
    }

    public sealed class MyTournament
    {
        public string TournamentId, Status, HorseId;
        public bool Registered, Eliminated, PrizePaid;
        public MyTournamentHeat Heat;
        public TournamentStanding Standing;
        public Reward Prize;
        internal static MyTournament Parse(JsonNode o) => new MyTournament
        {
            TournamentId = J.Str(o, "tournamentId"), Status = J.Str(o, "status"), HorseId = J.Str(o, "horseId"), Registered = J.Bool(o, "registered"),
            Eliminated = J.Bool(o, "eliminated"), PrizePaid = J.Bool(o, "prizePaid"), Heat = MyTournamentHeat.Parse(J.Opt(o, "heat")),
            Standing = J.Opt(o, "standing") == null ? null : TournamentStanding.Parse(J.Opt(o, "standing")),
            Prize = J.Opt(o, "prize") == null ? null : Reward.Parse(J.Opt(o, "prize")),
        };
    }

    public sealed class TournamentHistoryEntry
    {
        public string TournamentId, Name;
        public int Rank;
        public long At;
        public Reward Reward;
        internal static TournamentHistoryEntry Parse(JsonNode o) => new TournamentHistoryEntry
        {
            TournamentId = J.Str(o, "tournamentId"), Name = J.Str(o, "name"), Rank = J.Int(o, "rank"), At = J.Long(o, "at"),
            Reward = J.Opt(o, "reward") == null ? null : Reward.Parse(J.Opt(o, "reward")),
        };
        internal static List<TournamentHistoryEntry> ParseList(JsonNode o) => J.List(o, "history", Parse);
    }
}
