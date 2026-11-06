using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;
using Muchi.Engine;

namespace Muchi.Game
{
    // View models for the screens that used to be "LOCAL ONLY" (care/feed, course looks, private-room
    // conditions) and for the social/competitive screens Codex builds next (friends, teams, events, time
    // attack, leaderboards). Each model loads from the server when the backend is online and falls back to
    // local data (or an explanatory message) offline. Screens bind to the public fields and call the async
    // actions from the main thread; nothing here touches UnityEngine.

    /// <summary>Mapping between Codex's screen cards (by index) and server ids.</summary>
    public static class ScreenIds
    {
        /// <summary>Care screen cards: GRAIN &amp; APPLE, HAY &amp; CARROT, FRESH WATER.</summary>
        public static readonly string[] CareActions = { "grain_apple", "hay_carrot", "fresh_water" };
        /// <summary>Course look cards: GREENFIELD TURF, SPRING MEADOW, AUTUMN GOLD.</summary>
        public static readonly string[] CourseLooks = { "greenfield", "spring_meadow", "autumn_gold" };
        /// <summary>Conditions screen: weather cards SUNNY, CLOUDY, RAIN, MORNING FOG.</summary>
        public static readonly string[] Weather = { "sunny", "cloudy", "rain", "fog" };
        /// <summary>Ground buttons FIRM, GOOD, SOFT, HEAVY → turf going names (the server maps them to dirt steps).</summary>
        public static readonly string[] Ground = { "firm", "good", "yielding", "soft" };
        /// <summary>The same four buttons on a dirt course (REQ-RACE-034 dirt going names).</summary>
        public static readonly string[] DirtGround = { "fast", "good", "muddy", "sloppy" };
        public static readonly int[] TemperaturesC = { 14, 18, 22, 26 };
        public static readonly int[] WindsKmh = { 0, 5, 10, 15 };

        public static int IndexOf(string[] ids, string id, int fallback = 0)
        {
            int i = Array.IndexOf(ids, id);
            return i >= 0 ? i : fallback;
        }
    }

    /// <summary>Common "what to show" state of a screen model.</summary>
    public abstract class ScreenModel
    {
        protected readonly GameBackend B;
        protected readonly IKeyValueStore Kv;
        /// <summary>The data shown came from the server.</summary>
        public bool Online { get; protected set; }
        /// <summary>Last message for the screen (server error text, offline notice); null when none.</summary>
        public string Message { get; protected set; }

        protected ScreenModel(GameBackend backend, IKeyValueStore store) { B = backend ?? throw new ArgumentNullException(nameof(backend)); Kv = store ?? new MemoryKeyValueStore(); }

        protected bool ServerAvailable => B.Online && B.Api != null;

        protected ActionResult Fail(ApiException e) { Message = e.Message; return ActionResult.Error(e.WireCode + "  /  " + e.Message); }
        protected ActionResult Offline(string what) { Message = "OFFLINE  /  " + what; return ActionResult.Error(Message); }
    }

    // ------------------------------------------------------------------------------------- care / bond

    /// <summary>Stable care screen (REQ-BOND-*): bond level of the partner and the three care cards.</summary>
    public sealed class CareModel : ScreenModel
    {
        public const string KeyLocalFeed = "muchi.care.feed";
        public string HorseId;
        public BondView Bond;
        /// <summary>Offline: the card chosen locally (index into <see cref="ScreenIds.CareActions"/>).</summary>
        public int LocalFeed;

        public CareModel(GameBackend backend, IKeyValueStore store) : base(backend, store) { }

        public int Level => Bond?.Level ?? 1;
        public bool AffectsRankedStats => false; // REQ-BOND-005: always false; shown in the UI copy

        /// <summary>Card index of today's focus (server focus online, local choice offline).</summary>
        public int SelectedCard => Bond?.Focus != null ? ScreenIds.IndexOf(ScreenIds.CareActions, ActionForFocus(Bond.Focus), LocalFeed) : LocalFeed;

        private string ActionForFocus(string focus) => Bond?.Actions.FirstOrDefault(a => a.Focus == focus)?.Id;

        public CareAction Card(int index) => Bond?.Actions.FirstOrDefault(a => a.Id == ScreenIds.CareActions[index]);

        public async Task LoadAsync(string horseId = null, CancellationToken ct = default)
        {
            LocalFeed = int.TryParse(Kv.Get(KeyLocalFeed), NumberStyles.Integer, CultureInfo.InvariantCulture, out var f) ? Math.Max(0, Math.Min(2, f)) : 0;
            HorseId = horseId ?? B.Partner?.Id;
            Online = false; Message = null; Bond = null;
            if (!ServerAvailable || HorseId == null) { if (!ServerAvailable) Message = "OFFLINE  /  care is saved on this device only"; return; }
            try { Bond = await B.Api.GetBondAsync(HorseId, ct); Online = true; }
            catch (ApiException e) { Fail(e); }
        }

        /// <summary>Care with card <paramref name="index"/>. Online: a server care action (cooldown / daily limit apply).</summary>
        public async Task<ActionResult> CareAsync(int index, CancellationToken ct = default)
        {
            if (index < 0 || index >= ScreenIds.CareActions.Length) return ActionResult.Error("unknown care card");
            LocalFeed = index;
            Kv.Set(KeyLocalFeed, index.ToString(CultureInfo.InvariantCulture));
            if (!ServerAvailable || HorseId == null) return ActionResult.Success("SAVED ON THIS DEVICE");
            try
            {
                var r = await B.Api.CareAsync(HorseId, ScreenIds.CareActions[index], null, ct);
                Bond = r.Bond;
                Online = true;
                string reward = r.Rewards.Count > 0 ? "  /  REWARD ◎" + r.Rewards.Sum(x => x.FreeCoins) : "";
                Message = "+" + r.Gained + " BOND" + (r.LevelUp ? "  /  LEVEL " + Bond.Level + "!" : "") + reward;
                if (r.Rewards.Count > 0) await B.RefreshAsync(ct);
                return ActionResult.Success(Message);
            }
            catch (ApiException e) { return Fail(e); }
        }
    }

    // ------------------------------------------------------------------------------------- course looks

    /// <summary>Racecourse look themes (REQ-ROOM-001). Cosmetic, applied to the player's own screen only.</summary>
    public sealed class CourseLooksModel : ScreenModel
    {
        public const string KeyLocalCourse = "muchi.cosmetic.course";
        public Presets Presets;
        public int LocalEquipped;

        public CourseLooksModel(GameBackend backend, IKeyValueStore store) : base(backend, store) { }

        public int EquippedIndex => Presets != null ? ScreenIds.IndexOf(ScreenIds.CourseLooks, Presets.CourseLook ?? "greenfield") : LocalEquipped;
        public bool Owned(int index) => Presets != null ? Presets.OwnedCourseLooks.Contains(ScreenIds.CourseLooks[index]) : index == 0;
        /// <summary>Asset key of the equipped look (contracts/assets.md `scene/look/*`).</summary>
        public string EquippedKey => Presets?.CourseLookKey ?? AssetKeys.CourseLook(ScreenIds.CourseLooks[EquippedIndex]);

        public async Task LoadAsync(CancellationToken ct = default)
        {
            LocalEquipped = int.TryParse(Kv.Get(KeyLocalCourse), NumberStyles.Integer, CultureInfo.InvariantCulture, out var i) ? Math.Max(0, Math.Min(2, i)) : 0;
            Online = false; Message = null; Presets = null;
            if (!ServerAvailable) { Message = "OFFLINE  /  looks are saved on this device only"; return; }
            try { Presets = await B.Api.GetPresetsAsync(ct); Online = true; }
            catch (ApiException e) { Fail(e); }
        }

        public async Task<ActionResult> EquipAsync(int index, CancellationToken ct = default)
        {
            if (index < 0 || index >= ScreenIds.CourseLooks.Length) return ActionResult.Error("unknown course look");
            if (!ServerAvailable)
            {
                if (index != 0) return Offline("course themes need the server");
                LocalEquipped = 0; Kv.Set(KeyLocalCourse, "0");
                return ActionResult.Success();
            }
            try
            {
                Presets = await B.Api.SetCourseLookAsync(ScreenIds.CourseLooks[index], ct);
                LocalEquipped = index; Kv.Set(KeyLocalCourse, index.ToString(CultureInfo.InvariantCulture));
                Online = true; Message = null;
                return ActionResult.Success();
            }
            catch (ApiException e) { return Fail(e); }
        }
    }

    // ------------------------------------------------------------------------------------- room conditions

    /// <summary>
    /// Private-room conditions (REQ-ROOM-002/003): stored on the server; friend rooms this player hosts race on
    /// them (course / ground / night) and show the weather, temperature and wind. Ranked races are unaffected.
    /// </summary>
    public sealed class RoomConditionsModel : ScreenModel
    {
        public const string KeyWeather = "muchi.race.weather", KeyGround = "muchi.race.surface", KeyTemperature = "muchi.race.temperature", KeyWind = "muchi.race.wind";
        /// <summary>"1" = the player has not picked a ground (the room uses the day's ground).</summary>
        public const string KeyGroundAuto = "muchi.race.surface.auto";
        public int Weather, Ground = 1, Temperature = 1, Wind;
        /// <summary>
        /// True until the player picks a ground: the room keeps the day's ground (going null on the server). Weather,
        /// temperature or wind changes never pin the ground.
        /// </summary>
        public bool GroundAuto = true;
        /// <summary>Course for the room (null = random). Night: null = automatic.</summary>
        public string TrackId;
        public bool? Night;

        public RoomConditionsModel(GameBackend backend, IKeyValueStore store) : base(backend, store) { }

        /// <summary>The player tapped a ground button (FIRM, GOOD, SOFT, HEAVY).</summary>
        public void SelectGround(int index) { Ground = Math.Max(0, Math.Min(3, index)); GroundAuto = false; }

        private int LocalInt(string k, int def) => int.TryParse(Kv.Get(k), NumberStyles.Integer, CultureInfo.InvariantCulture, out var v) ? Math.Max(0, Math.Min(3, v)) : def;
        private void SaveLocal()
        {
            Kv.Set(KeyWeather, Weather.ToString(CultureInfo.InvariantCulture)); Kv.Set(KeyGround, Ground.ToString(CultureInfo.InvariantCulture));
            Kv.Set(KeyTemperature, Temperature.ToString(CultureInfo.InvariantCulture)); Kv.Set(KeyWind, Wind.ToString(CultureInfo.InvariantCulture));
            Kv.Set(KeyGroundAuto, GroundAuto ? "1" : "0");
        }

        /// <summary>Dirt courses ("…_dirt_…", server/master/tracks.json) take dirt going names.</summary>
        public static bool IsDirtTrack(string trackId) => trackId != null && trackId.IndexOf("_dirt", StringComparison.Ordinal) >= 0;

        /// <summary>Going name for a ground button on this course (dirt courses: fast / good / muddy / sloppy).</summary>
        public static string GoingFor(int groundIndex, string trackId) => IsDirtTrack(trackId) ? ScreenIds.DirtGround[groundIndex] : ScreenIds.Ground[groundIndex];

        public RoomConditions ToConditions() => new RoomConditions
        {
            TrackId = TrackId, Going = GroundAuto ? null : GoingFor(Ground, TrackId), Night = Night, Weather = ScreenIds.Weather[Weather],
            TemperatureC = ScreenIds.TemperaturesC[Temperature], WindKmh = ScreenIds.WindsKmh[Wind],
        };

        private void From(RoomConditions c)
        {
            if (c == null) return;
            Weather = ScreenIds.IndexOf(ScreenIds.Weather, c.Weather);
            GroundAuto = c.Going == null;
            Ground = c.Going == null ? 1 : ScreenIds.IndexOf(ScreenIds.Ground, TurfStep(c.Going), 1);
            Temperature = Math.Max(0, Array.IndexOf(ScreenIds.TemperaturesC, c.TemperatureC));
            Wind = Math.Max(0, Array.IndexOf(ScreenIds.WindsKmh, c.WindKmh));
            TrackId = c.TrackId; Night = c.Night;
        }

        /// <summary>Dirt going names to the matching turf step for the four ground buttons (display only; saving maps back via <see cref="GoingFor"/>).</summary>
        public static string TurfStep(string going)
        {
            switch (going) { case "fast": return "firm"; case "muddy": return "yielding"; case "sloppy": return "soft"; default: return going; }
        }

        public async Task LoadAsync(CancellationToken ct = default)
        {
            Weather = LocalInt(KeyWeather, 0); Ground = LocalInt(KeyGround, 1); Temperature = LocalInt(KeyTemperature, 1); Wind = LocalInt(KeyWind, 0);
            GroundAuto = Kv.Get(KeyGroundAuto) != "0";
            Online = false; Message = null;
            if (!ServerAvailable) { Message = "OFFLINE  /  saved on this device only"; return; }
            try { From((await B.Api.GetPresetsAsync(ct)).Room); Online = true; }
            catch (ApiException e) { Fail(e); }
        }

        /// <summary>Saves the current selection (server when online, always locally too).</summary>
        public async Task<ActionResult> SaveAsync(CancellationToken ct = default)
        {
            SaveLocal();
            if (!ServerAvailable) return ActionResult.Success("SAVED ON THIS DEVICE");
            try
            {
                From((await B.Api.SetRoomConditionsAsync(ToConditions(), ct)).Room);
                Online = true; Message = null;
                return ActionResult.Success("SAVED  /  your friend rooms race on these conditions");
            }
            catch (ApiException e) { return Fail(e); }
        }

        public async Task<ActionResult> ResetAsync(CancellationToken ct = default)
        {
            Weather = 0; Ground = 1; GroundAuto = true; Temperature = 1; Wind = 0; TrackId = null; Night = null;
            SaveLocal();
            if (!ServerAvailable) return ActionResult.Success();
            try { await B.Api.ClearRoomConditionsAsync(ct); Online = true; return ActionResult.Success("AUTOMATIC CONDITIONS"); }
            catch (ApiException e) { return Fail(e); }
        }
    }

    // ------------------------------------------------------------------------------------- friends

    public sealed class FriendsModel : ScreenModel
    {
        public string MyCode;
        public FriendList List = new FriendList();

        public FriendsModel(GameBackend backend) : base(backend, null) { }

        public async Task LoadAsync(CancellationToken ct = default)
        {
            Online = false; Message = null;
            if (!ServerAvailable) { Message = "OFFLINE  /  friends need the server"; return; }
            try
            {
                MyCode = await B.Api.GetFriendCodeAsync(ct);
                List = await B.Api.GetFriendsAsync(ct);
                Online = true;
            }
            catch (ApiException e) { Fail(e); }
        }

        private async Task<ActionResult> Do(Func<Task> op, string done, CancellationToken ct)
        {
            if (!ServerAvailable) return Offline("friends need the server");
            try { await op(); await LoadAsync(ct); return ActionResult.Success(done); }
            catch (ApiException e) { return Fail(e); }
        }

        public Task<ActionResult> SendAsync(string friendCode, CancellationToken ct = default) => Do(() => B.Api.SendFriendRequestAsync(friendCode, ct), "REQUEST SENT", ct);
        public Task<ActionResult> AcceptAsync(string fromId, CancellationToken ct = default) => Do(() => B.Api.AcceptFriendRequestAsync(fromId, ct), "NOW FRIENDS", ct);
        public Task<ActionResult> DeclineAsync(string fromId, CancellationToken ct = default) => Do(() => B.Api.DeclineFriendRequestAsync(fromId, ct), "DECLINED", ct);
        public Task<ActionResult> CancelAsync(string toId, CancellationToken ct = default) => Do(() => B.Api.CancelFriendRequestAsync(toId, ct), "CANCELLED", ct);
        public Task<ActionResult> RemoveAsync(string friendId, CancellationToken ct = default) => Do(() => B.Api.RemoveFriendAsync(friendId, ct), "REMOVED", ct);
    }

    // ------------------------------------------------------------------------------------- teams (支部)

    public sealed class TeamsModel : ScreenModel
    {
        public MyTeam Mine;
        public List<TeamSummary> Search = new List<TeamSummary>();

        public TeamsModel(GameBackend backend) : base(backend, null) { }

        public bool InTeam => Mine?.Team != null;

        public async Task LoadAsync(CancellationToken ct = default)
        {
            Online = false; Message = null;
            if (!ServerAvailable) { Message = "OFFLINE  /  teams need the server"; return; }
            try { Mine = await B.Api.GetMyTeamAsync(ct); Online = true; }
            catch (ApiException e) { Fail(e); }
        }

        public async Task<ActionResult> SearchAsync(string query, CancellationToken ct = default)
        {
            if (!ServerAvailable) return Offline("teams need the server");
            try { Search = await B.Api.SearchTeamsAsync(query ?? "", ct); return ActionResult.Success(); }
            catch (ApiException e) { return Fail(e); }
        }

        private async Task<ActionResult> Do(Func<Task> op, string done, CancellationToken ct)
        {
            if (!ServerAvailable) return Offline("teams need the server");
            try { await op(); await LoadAsync(ct); return ActionResult.Success(done); }
            catch (ApiException e) { return Fail(e); }
        }

        public Task<ActionResult> CreateAsync(string name, TeamJoinPolicy policy, CancellationToken ct = default) => Do(() => B.Api.CreateTeamAsync(name, policy, null, ct), "TEAM CREATED", ct);
        public Task<ActionResult> JoinAsync(string teamId, CancellationToken ct = default) => Do(() => B.Api.JoinTeamAsync(teamId, ct), "JOIN SENT", ct);
        public Task<ActionResult> LeaveAsync(CancellationToken ct = default) => Do(() => B.Api.LeaveTeamAsync(ct), "LEFT THE TEAM", ct);
        public Task<ActionResult> ApproveAsync(string playerId, CancellationToken ct = default) => Do(() => B.Api.ApproveTeamRequestAsync(playerId, ct), "APPROVED", ct);
        public Task<ActionResult> DeclineAsync(string playerId, CancellationToken ct = default) => Do(() => B.Api.DeclineTeamRequestAsync(playerId, ct), "DECLINED", ct);
        public Task<ActionResult> KickAsync(string playerId, CancellationToken ct = default) => Do(() => B.Api.KickTeamMemberAsync(playerId, ct), "REMOVED", ct);
        public Task<ActionResult> TransferAsync(string playerId, CancellationToken ct = default) => Do(() => B.Api.TransferTeamLeadershipAsync(playerId, ct), "LEADER CHANGED", ct);
    }

    // ------------------------------------------------------------------------------------- 支部対抗シーズン

    /// <summary>
    /// Team league screen (REQ-LEAGUE-005): my division table, this week's matchup and the weekly record; after the
    /// season, the final place, its reward and the division for next season. Other divisions come from the public board.
    /// </summary>
    public sealed class LeagueModel : ScreenModel
    {
        public MyLeague Mine;
        public LeagueBoard Board;

        public LeagueModel(GameBackend backend) : base(backend, null) { }

        public bool InTeam => Mine?.TeamId != null;
        /// <summary>In a team that has taken part this season (a team joins its division with its first week).</summary>
        public bool InLeague => Mine?.DivisionId != null;

        /// <summary>Header: "二部  2位 / 6" — or why there is no table yet.</summary>
        public string Headline
        {
            get
            {
                if (Mine == null) return Message ?? "";
                if (!InTeam) return "支部に入ると支部対抗シーズンに参加できます";
                if (!InLeague) return "今週の対戦の組み合わせを待っています";
                return Mine.DivisionName + "  " + (Mine.Place?.ToString(CultureInfo.InvariantCulture) ?? "-") + "位 / " + Mine.Table.Count;
            }
        }

        /// <summary>This week's card: "vs みなと会  120 - 80" (live scores are season-point growth so far; shown after the week).</summary>
        public string ThisWeekLine
        {
            get
            {
                var w = Mine?.ThisWeek;
                if (w == null) return null;
                if (w.Bye) return "今週は不戦（対戦相手なし）";
                return "vs " + (w.OpponentName ?? w.Opponent ?? "?");
            }
        }

        /// <summary>Weekly record "○ ● △ − ·" (win, loss, draw, bye, not played yet).</summary>
        public string RecordLine => Mine == null ? "" : string.Join(" ", Mine.Matches.Select(m =>
            m.Outcome == "win" ? "○" : m.Outcome == "loss" ? "●" : m.Outcome == "draw" ? "△" : m.Outcome == "bye" ? "−" : "·"));

        /// <summary>After the season: "二部 1位 → 一部に昇格  /  600 コイン".</summary>
        public string FinalLine
        {
            get
            {
                var f = Mine?.Final;
                if (f == null) return null;
                string Name(string id) => Mine.Divisions.FirstOrDefault(d => d.Id == id)?.Name ?? id;
                int mv = f.Movement(Mine.Divisions);
                string move = mv > 0 ? Name(f.NextDivisionId) + "に昇格" : mv < 0 ? Name(f.NextDivisionId) + "に降格" : Name(f.NextDivisionId) + "に残留";
                string reward = f.Reward != null && f.Reward.FreeCoins > 0 ? "  /  " + f.Reward.FreeCoins.ToString(CultureInfo.InvariantCulture) + " コイン" : "";
                return Name(f.DivisionId) + " " + f.Place.ToString(CultureInfo.InvariantCulture) + "位 → " + move + reward;
            }
        }

        public async Task LoadAsync(CancellationToken ct = default)
        {
            Online = false; Message = null;
            if (!ServerAvailable) { Message = "OFFLINE  /  the team league needs the server"; return; }
            try { Mine = await B.Api.GetMyLeagueAsync(ct); Online = true; }
            catch (ApiException e) { Fail(e); }
        }

        /// <summary>Another division's table (tabs at the top of the screen).</summary>
        public async Task<ActionResult> DivisionAsync(string divisionId, CancellationToken ct = default)
        {
            if (!ServerAvailable) return Offline("the team league needs the server");
            try { Board = await B.Api.GetLeagueBoardAsync(divisionId, "current", ct); return ActionResult.Success(); }
            catch (NotFoundException) { Board = null; return ActionResult.Error("NO SNAPSHOT YET  /  tables are published every few minutes"); }
            catch (ApiException e) { return Fail(e); }
        }
    }

    // ------------------------------------------------------------------------------------- events

    public sealed class EventsModel : ScreenModel
    {
        public List<EventInfo> Events = new List<EventInfo>();
        public EventBoard Board;

        public EventsModel(GameBackend backend) : base(backend, null) { }

        public async Task LoadAsync(CancellationToken ct = default)
        {
            Online = false; Message = null;
            if (!ServerAvailable) { Message = "OFFLINE  /  events need the server"; return; }
            try { Events = await B.Api.GetEventsAsync(ct); Online = true; }
            catch (ApiException e) { Fail(e); }
        }

        public async Task<ActionResult> StandingsAsync(string eventId, CancellationToken ct = default)
        {
            if (!ServerAvailable) return Offline("events need the server");
            try { Board = await B.Api.GetEventLeaderboardAsync(eventId, ct); return ActionResult.Success(); }
            catch (ApiException e) { return Fail(e); }
        }

        /// <summary>Pays the fee (free coins or a ticket) and queues the partner; poll the race with the ranked flow.</summary>
        public async Task<ActionResult> EnterAsync(string eventId, CancellationToken ct = default)
        {
            if (!ServerAvailable) return Offline("events need the server");
            var partner = B.Partner;
            if (partner == null) return ActionResult.Error("NO PARTNER");
            try { var st = await B.Api.EnqueueEventAsync(eventId, partner.Id, null, ct); await B.RefreshAsync(ct); return ActionResult.Success(st); }
            catch (ApiException e) { return Fail(e); }
        }

        public async Task<ActionResult> LeaveQueueAsync(string eventId, CancellationToken ct = default)
        {
            if (!ServerAvailable) return Offline("events need the server");
            try { await B.Api.CancelEventQueueAsync(eventId, ct); await B.RefreshAsync(ct); return ActionResult.Success("LEFT THE QUEUE  /  fee refunded"); }
            catch (ApiException e) { return Fail(e); }
        }
    }

    // ------------------------------------------------------------------------------------- leaderboards

    public sealed class LeaderboardModel : ScreenModel
    {
        public MyRank Mine;
        public LeaderboardFile Board;

        public LeaderboardModel(GameBackend backend) : base(backend, null) { }

        /// <summary>My rank plus one board ("class-C", "rating", "ta-&lt;trackId&gt;"…) of the current season.</summary>
        public async Task LoadAsync(string board = null, CancellationToken ct = default)
        {
            Online = false; Message = null;
            if (!ServerAvailable) { Message = "OFFLINE  /  rankings need the server"; return; }
            try
            {
                Mine = await B.Api.GetMyRankAsync(ct);
                // Always the server's current season: the cached player view can still name last month's season after
                // the JST month boundary, while /v1/leaderboards/me already uses the new one.
                const string season = "current";
                string b = board ?? "class-" + (Mine?.Standing?.ClassId ?? B.Player?.ClassId ?? "C");
                try { Board = await B.Api.GetLeaderboardAsync(season, b, ct); }
                catch (NotFoundException) { Board = null; Message = "NO SNAPSHOT YET  /  rankings are published every few minutes"; }
                Online = true;
            }
            catch (ApiException e) { Fail(e); }
        }
    }

    // ------------------------------------------------------------------------------------- time attack

    /// <summary>
    /// Time attack (REQ-TA-*): start a server session, race it locally with ghosts (TimeAttackRun), submit the
    /// inputs; the server re-simulates and records the time. Offline there is no session (practice instead).
    /// </summary>
    public sealed class TimeAttackModel : ScreenModel
    {
        public TimeAttackMe Me;
        public GhostList Ghosts;
        public TimeAttackRun Run;
        public TimeAttackResult Result;

        public TimeAttackModel(GameBackend backend) : base(backend, null) { }

        public async Task LoadAsync(string trackId, CancellationToken ct = default)
        {
            Online = false; Message = null;
            if (!ServerAvailable) { Message = "OFFLINE  /  time attack records need the server"; return; }
            try
            {
                Me = await B.Api.GetTimeAttackMeAsync(trackId, ct);
                Ghosts = await B.Api.GetGhostsAsync(trackId, GhostKind.Top, null, ct);
                Online = true;
            }
            catch (ApiException e) { Fail(e); }
        }

        /// <summary>Starts a session and returns a driver for the race screen; ghosts (up to <paramref name="ghostCount"/>) run beside the player.</summary>
        public async Task<(IRaceDriver driver, string message)> StartAsync(string trackId, int ghostCount = 1, CancellationToken ct = default)
        {
            if (!ServerAvailable) return (null, Offline("time attack records need the server").Message);
            var partner = B.Partner;
            if (partner == null) return (null, "NO PARTNER");
            try
            {
                var session = await B.Api.StartTimeAttackAsync(trackId, partner.Id, ct);
                Run = new TimeAttackRun(session);
                Result = null;
                foreach (var g in (Ghosts?.Ghosts ?? new List<GhostEntry>()).Take(Math.Max(0, ghostCount)))
                {
                    try { Run.AddGhost(await B.Api.GetGhostAsync(g, ct)); }
                    catch (ApiException) { /* a missing ghost never blocks the run */ }
                }
                return (new OfflineRaceDriver(Run.Race), null);
            }
            catch (ApiException e) { return (null, Fail(e).Message); }
        }

        /// <summary>Submit the finished run (server re-simulates; a retry returns the stored result).</summary>
        public async Task<ActionResult> SubmitAsync(CancellationToken ct = default)
        {
            if (Run == null || !Run.Race.IsFinished) return ActionResult.Error("the run has not finished");
            if (!ServerAvailable) return Offline("submitting needs the server");
            try
            {
                Result = await B.Api.SubmitTimeAttackAsync(Run.Session, Run.Race, ct);
                return ActionResult.Success(Result.TimeMs.HasValue ? HudModel.FormatTime(Result.TimeMs.Value) : "DID NOT FINISH");
            }
            catch (ApiException e) { return Fail(e); }
        }
    }
}
