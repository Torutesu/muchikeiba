using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;

namespace Muchi.Game
{
    /// <summary>One row of the tournament list (大会一覧).</summary>
    public sealed class TournamentRow
    {
        public string Id, Name, Status;
        /// <summary>Japanese status chip: 受付前 / 受付中 / 開催中 / 表彰中 / 終了 / 中止.</summary>
        public string StatusLabel;
        public long RegistrationClosesAtMs, StartsAtMs;
        public int Entrants, MaxEntrants;
        public bool CanRegister;
    }

    public sealed class TournamentsModel
    {
        public bool LocalOnly;
        public string Notice;
        public List<TournamentRow> Rows = new List<TournamentRow>();
    }

    /// <summary>One heat in the bracket view.</summary>
    public sealed class BracketHeat
    {
        public string Title, RaceId, Status;
        public bool Watchable;
        /// <summary>Runner names (in finish order once the heat has a result; "▶" marks those who advance).</summary>
        public List<string> Lines = new List<string>();
    }

    public sealed class TournamentDetailModel
    {
        public bool LocalOnly;
        public string Notice;
        public TournamentDetail Detail;
        public List<BracketHeat> Heats = new List<BracketHeat>();
        /// <summary>"1位 B", "2位 A"… once decided.</summary>
        public List<string> Standings = new List<string>();
        public MyTournament Me;
        /// <summary>Your heat is racing now: join with this (also offered by match status).</summary>
        public RaceAssignment JoinNow => Me?.Heat?.Assignment;
    }

    /// <summary>One row of the "watch" screen (観戦).</summary>
    public sealed class WatchRow
    {
        public string RaceId, Title, Mode;
        public string Subtitle;
        public int DelayMs;
        public bool Friends;
    }

    public sealed class WatchModel
    {
        public bool LocalOnly;
        public string Notice;
        public List<WatchRow> Rows = new List<WatchRow>();
    }

    /// <summary>
    /// Tournaments (REQ-TOUR-*) and spectating (REQ-SPEC-*) for Codex's screens. Offline, both screens say so and offer
    /// nothing to join (tournaments and live races only exist on the server).
    /// </summary>
    public sealed class TournamentsBackend
    {
        private readonly GameBackend _b;
        public TournamentsBackend(GameBackend backend) { _b = backend ?? throw new ArgumentNullException(nameof(backend)); }

        public const string OfflineNotice = "OFFLINE  /  大会と観戦はオンラインのみ";

        public static string StatusLabel(string s) =>
            s == "scheduled" ? "受付前" : s == "registration" ? "受付中" : s == "running" ? "開催中" : s == "paying" ? "表彰中" : s == "finished" ? "終了" : s == "cancelled" ? "中止" : "-";

        public static string ModeLabel(string mode) => mode == "tournament" ? "大会" : mode == "event" ? "イベント" : mode == "friend" ? "フレンド" : "ランク戦";

        public async Task<TournamentsModel> ListAsync(CancellationToken ct = default)
        {
            if (!_b.Online) return new TournamentsModel { LocalOnly = true, Notice = OfflineNotice };
            try
            {
                var list = await _b.Api.GetTournamentsAsync(ct);
                return new TournamentsModel
                {
                    Rows = list.Select(t => new TournamentRow
                    {
                        Id = t.Id, Name = t.Name, Status = t.Status, StatusLabel = StatusLabel(t.Status), RegistrationClosesAtMs = t.RegistrationClosesAtMs,
                        StartsAtMs = t.StartsAtMs, Entrants = t.Entrants, MaxEntrants = t.MaxEntrants, CanRegister = t.Status == "registration" && t.Entrants < t.MaxEntrants,
                    }).ToList(),
                };
            }
            catch (ApiException e) { return new TournamentsModel { LocalOnly = true, Notice = e.WireCode + "  /  " + e.Message }; }
        }

        public async Task<TournamentDetailModel> DetailAsync(string tournamentId, CancellationToken ct = default)
        {
            if (!_b.Online) return new TournamentDetailModel { LocalOnly = true, Notice = OfflineNotice };
            try
            {
                var d = await _b.Api.GetTournamentAsync(tournamentId, ct);
                MyTournament me = null;
                try { me = await _b.Api.GetMyTournamentAsync(tournamentId, ct); } catch (ApiException) { /* signed out or not found: show the bracket only */ }
                var m = new TournamentDetailModel { Detail = d, Me = me };
                foreach (var r in d.Rounds)
                {
                    foreach (var h in r.Heats)
                    {
                        int idx = int.TryParse(h.Id?.Split('-').LastOrDefault(), out var n) ? n : 0;
                        var bh = new BracketHeat
                        {
                            Title = r.Final ? "決勝" : (r.Index + 1) + "回戦 第" + (idx + 1) + "組",
                            RaceId = h.RaceId, Status = h.Status, Watchable = h.Status == "created" && h.RaceId != null,
                        };
                        if (h.Results != null) bh.Lines = h.Results.Select(x => (x.Advanced ? "▶ " : "  ") + (x.Place.HasValue ? x.Place.Value + "着 " : "") + x.DisplayName + (x.NoShow ? "（不参加）" : "")).ToList();
                        else bh.Lines = h.DisplayNames.ToList();
                        m.Heats.Add(bh);
                    }
                }
                if (d.Standings != null) m.Standings = d.Standings.Select(s => s.Rank + "位 " + s.DisplayName).ToList();
                return m;
            }
            catch (ApiException e) { return new TournamentDetailModel { LocalOnly = true, Notice = e.WireCode + "  /  " + e.Message }; }
        }

        /// <summary>Register the partner (or change horse). NOT_ELIGIBLE explains why (class, ranked_races, style…).</summary>
        public async Task<ActionResult> RegisterAsync(string tournamentId, CancellationToken ct = default)
        {
            if (!_b.Online) return ActionResult.Error("OFFLINE");
            var partner = _b.Partner;
            if (partner == null) return ActionResult.Error("NO PARTNER  /  finish the first scout");
            try
            {
                var me = await _b.Api.RegisterTournamentAsync(tournamentId, partner.Id, ct);
                return me.Registered ? ActionResult.Success("エントリーしました") : ActionResult.Error("not registered");
            }
            catch (ApiException e) { return ActionResult.Error(e.WireCode + "  /  " + e.Message); }
        }

        public async Task<ActionResult> UnregisterAsync(string tournamentId, CancellationToken ct = default)
        {
            if (!_b.Online) return ActionResult.Error("OFFLINE");
            try { return await _b.Api.UnregisterTournamentAsync(tournamentId, ct) ? ActionResult.Success("エントリーを取り消しました") : ActionResult.Error("not registered"); }
            catch (ApiException e) { return ActionResult.Error(e.WireCode + "  /  " + e.Message); }
        }

        /// <summary>REQ-TOUR-009: join your running heat (null + message when there is none).</summary>
        public async Task<(IRaceDriver driver, string message)> JoinHeatAsync(string tournamentId, CancellationToken ct = default)
        {
            if (!_b.Online) return (null, "OFFLINE");
            try
            {
                var me = await _b.Api.GetMyTournamentAsync(tournamentId, ct);
                var a = me.Heat?.Assignment;
                if (a == null) return (null, me.Heat == null ? "NO HEAT YET" : "HEAT NOT RUNNING");
                return (_b.Connect(a), null);
            }
            catch (ApiException e) { return (null, e.WireCode + "  /  " + e.Message); }
        }

        // ------------------------------------------------------------------ spectating

        public async Task<WatchModel> LiveAsync(CancellationToken ct = default)
        {
            if (!_b.Online) return new WatchModel { LocalOnly = true, Notice = OfflineNotice };
            try
            {
                var l = await _b.Api.GetLiveRacesAsync(ct);
                var rows = new List<WatchRow>();
                foreach (var r in l.Friends) rows.Add(Row(r, true));
                foreach (var r in l.Featured) rows.Add(Row(r, false));
                return new WatchModel { Rows = rows, Notice = rows.Count == 0 ? "いま観戦できるレースはありません" : null };
            }
            catch (ApiException e) { return new WatchModel { LocalOnly = true, Notice = e.WireCode + "  /  " + e.Message }; }
        }

        private static WatchRow Row(LiveRace r, bool friends) => new WatchRow
        {
            RaceId = r.RaceId, Mode = r.Mode, DelayMs = r.DelayMs, Friends = friends,
            Title = r.Title ?? ModeLabel(r.Mode),
            Subtitle = (friends && r.Friends.Count > 0 ? "フレンド出走 " + r.Friends.Count + "人 / " : "") + r.Players + "人" + (r.DelayMs > 0 ? " / " + (r.DelayMs / 1000) + "秒遅れ" : " / ライブ"),
        };

        /// <summary>Watch a race (a heat from the bracket or a row of the watch screen).</summary>
        public async Task<(IRaceDriver driver, string message)> WatchAsync(string raceId, CancellationToken ct = default)
        {
            if (!_b.Online) return (null, "OFFLINE");
            try { return (_b.ConnectSpectator(await _b.Api.SpectateAsync(raceId, ct)), null); }
            catch (ApiException e) { return (null, e.WireCode + "  /  " + e.Message); }
        }
    }
}
