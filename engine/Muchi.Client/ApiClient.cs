using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Net;

namespace Muchi.Client
{
    public enum StorePlatform { Apple, Google, Fake }

    public enum PassTrack { Free, Premium }

    public enum PushPlatform { Ios, Android }

    public sealed class ApiClientOptions
    {
        /// <summary>e.g. "https://api.example.com" (no trailing slash needed).</summary>
        public string BaseUrl;
        /// <summary>Development only (server DEV_MODE=1): send x-dev-user instead of a Firebase token.</summary>
        public string DevUserId;
        public RetryPolicy Retry = new RetryPolicy();
    }

    /// <summary>
    /// Typed client for every player-facing endpoint in server/README.md (server/src/http/app.ts).
    /// - Writes that the server de-duplicates carry an Idempotency-Key that is generated once per call and
    ///   reused for every retry of that call. Pass your own key to survive an app restart (e.g. a pending draw).
    /// - Only safe requests are retried (GET, idempotent writes, keyed writes), on network errors, 5xx and 429.
    /// - A 401 refreshes the Firebase token once and resends.
    /// - Failures throw <see cref="ApiException"/> subclasses (see Errors.cs).
    /// </summary>
    public sealed class ApiClient
    {
        private readonly IHttp _http;
        private readonly IAuthTokenProvider _auth;
        private readonly IDelay _delay;
        private readonly IIdGenerator _ids;
        private readonly ApiClientOptions _opt;

        public ApiClient(IHttp http, IAuthTokenProvider auth, ApiClientOptions options, IDelay delay = null, IIdGenerator ids = null)
        {
            _http = http ?? throw new ArgumentNullException(nameof(http));
            _auth = auth;
            _opt = options ?? throw new ArgumentNullException(nameof(options));
            _delay = delay ?? TaskDelay.Instance;
            _ids = ids ?? new GuidIdGenerator();
            if (_auth == null && string.IsNullOrEmpty(_opt.DevUserId)) throw new ArgumentException("an IAuthTokenProvider is required unless DevUserId is set");
        }

        public string BaseUrl => _opt.BaseUrl?.TrimEnd('/') ?? "";

        /// <summary>WebSocket URL for a race assignment (http→ws, https→wss).</summary>
        public string RaceWebSocketUrl(RaceAssignment a)
        {
            string b = BaseUrl;
            if (b.StartsWith("https://", StringComparison.OrdinalIgnoreCase)) b = "wss://" + b.Substring(8);
            else if (b.StartsWith("http://", StringComparison.OrdinalIgnoreCase)) b = "ws://" + b.Substring(7);
            return b + a.WsPath;
        }

        public string NewIdempotencyKey() => _ids.NewId();

        // ------------------------------------------------------------------ player

        public Task<bool> HealthAsync(CancellationToken ct = default)
            => Call("GET", "/v1/health", null, false, null, true, o => J.Bool(o, "ok"), ct);

        /// <summary>
        /// Active remote-config version (REQ-OPS-005). Cache master data (banners, odds…) per <see cref="ConfigInfo.Hash"/>
        /// and refetch it when the hash changes. Public, no auth.
        /// </summary>
        public Task<ConfigInfo> GetConfigAsync(CancellationToken ct = default)
            => Call("GET", "/v1/config", null, false, null, true, ConfigInfo.Parse, ct);

        /// <summary>Creates the player on first use and returns the state. Safe to call on every launch.</summary>
        public Task<PlayerView> BootstrapAsync(CancellationToken ct = default)
            => Call("POST", "/v1/player/bootstrap", JsonNode.Obj(), true, null, true, PlayerView.Parse, ct);

        public Task<PlayerView> GetPlayerAsync(CancellationToken ct = default)
            => Call("GET", "/v1/player", null, true, null, true, PlayerView.Parse, ct);

        /// <summary>Registers the birth month before the first purchase (REQ-PUR-002).</summary>
        public Task<AgeResult> SetAgeAsync(int birthYear, int birthMonth, bool guardianConsent, CancellationToken ct = default)
        {
            var b = JsonNode.Obj();
            b.Set("birthYear", birthYear);
            b.Set("birthMonth", birthMonth);
            b.Set("guardianConsent", guardianConsent);
            return Call("PUT", "/v1/player/age", b, true, null, true, AgeResult.Parse, ct);
        }

        // ------------------------------------------------------------------ shop

        public Task<ProductList> GetProductsAsync(CancellationToken ct = default)
            => Call("GET", "/v1/shop/products", null, false, null, true, ProductList.Parse, ct);

        /// <summary>
        /// Per-player tokens to attach to the store purchase so receipts and store notifications map back to this player:
        /// pass AppleAppAccountToken as StoreKit 2 <c>appAccountToken</c>, GoogleObfuscatedAccountId as Play Billing
        /// <c>setObfuscatedAccountId</c>. Fetch once per session before the first purchase.
        /// </summary>
        public Task<StoreAccount> GetStoreAccountAsync(CancellationToken ct = default)
            => Call("GET", "/v1/shop/store-account", null, true, null, true, StoreAccount.Parse, ct);

        /// <summary>Ask before opening the store sheet. Throws <see cref="PurchaseBlockedException"/> when the purchase must not start.</summary>
        public Task<PurchaseIntent> PurchaseIntentAsync(string productId, CancellationToken ct = default)
        {
            var b = JsonNode.Obj();
            b.Set("productId", productId);
            return Call("POST", "/v1/shop/purchase-intent", b, true, null, true, PurchaseIntent.Parse, ct);
        }

        /// <summary>
        /// Sends a completed store receipt. The server de-duplicates by transaction id, so re-sending the same
        /// receipt (e.g. after a crash, before finishing the store transaction) is safe and returns Duplicate=true.
        /// </summary>
        public Task<PurchaseResult> PurchaseAsync(StorePlatform platform, string productId, string receipt, CancellationToken ct = default)
        {
            var b = JsonNode.Obj();
            b.Set("platform", platform == StorePlatform.Apple ? "apple" : platform == StorePlatform.Google ? "google" : "fake");
            b.Set("productId", productId);
            b.Set("receipt", receipt);
            return Call("POST", "/v1/shop/purchase", b, true, null, true, PurchaseResult.Parse, ct);
        }

        // ------------------------------------------------------------------ gacha

        public Task<List<Banner>> GetBannersAsync(CancellationToken ct = default)
            => Call("GET", "/v1/gacha/banners", null, false, null, true, o => J.List(o, "banners", Banner.Parse), ct);

        public Task<OddsDisclosure> GetOddsAsync(string bannerId, CancellationToken ct = default)
            => Call("GET", "/v1/gacha/" + Seg(bannerId) + "/odds", null, false, null, true, OddsDisclosure.Parse, ct);

        public Task<DrawResult> DrawAsync(string bannerId, int count, string idempotencyKey = null, CancellationToken ct = default)
        {
            if (count != 1 && count != 10) throw new ArgumentOutOfRangeException(nameof(count), "1 or 10");
            var b = JsonNode.Obj();
            b.Set("count", count);
            return Call("POST", "/v1/gacha/" + Seg(bannerId) + "/draw", b, true, idempotencyKey ?? NewIdempotencyKey(), true, DrawResult.Parse, ct);
        }

        /// <summary>The free tutorial 10-pull (once per player).</summary>
        public Task<DrawResult> TutorialDrawAsync(string idempotencyKey = null, CancellationToken ct = default)
            => Call("POST", "/v1/gacha/tutorial", JsonNode.Obj(), true, idempotencyKey ?? NewIdempotencyKey(), true, DrawResult.Parse, ct);

        public Task<PullResult> PityExchangeAsync(string bannerId, string templateId, string idempotencyKey = null, CancellationToken ct = default)
        {
            var b = JsonNode.Obj();
            b.Set("templateId", templateId);
            return Call("POST", "/v1/gacha/" + Seg(bannerId) + "/pity-exchange", b, true, idempotencyKey ?? NewIdempotencyKey(), true, PullResult.Parse, ct);
        }

        // ------------------------------------------------------------------ horses & breeding

        public Task<List<Horse>> GetHorsesAsync(CancellationToken ct = default)
            => Call("GET", "/v1/horses", null, true, null, true, o => J.List(o, "horses", Horse.Parse), ct);

        /// <summary>Katakana 2–9 characters. Throws <see cref="ValidationException"/> with INVALID_NAME or NG_NAME.</summary>
        public Task<Horse> NameHorseAsync(string horseId, string name, CancellationToken ct = default)
        {
            var b = JsonNode.Obj();
            b.Set("name", name);
            return Call("PUT", "/v1/horses/" + Seg(horseId) + "/name", b, true, null, true, Horse.Parse, ct);
        }

        public Task<Horse> AwakenAsync(string horseId, string idempotencyKey = null, CancellationToken ct = default)
            => Call("POST", "/v1/horses/" + Seg(horseId) + "/awaken", JsonNode.Obj(), true, idempotencyKey ?? NewIdempotencyKey(), true, Horse.Parse, ct);

        /// <summary>Not retried automatically: a lost response followed by a resend would report HORSE_NOT_ACTIVE.</summary>
        public Task<Horse> RetireAsync(string horseId, CancellationToken ct = default)
            => Call("POST", "/v1/horses/" + Seg(horseId) + "/retire", JsonNode.Obj(), true, null, false, Horse.Parse, ct);

        public Task<PedigreeNode> GetPedigreeAsync(string horseId, CancellationToken ct = default)
            => Call("GET", "/v1/horses/" + Seg(horseId) + "/pedigree", null, true, null, true, PedigreeNode.Parse, ct);

        public Task<BreedingPreview> BreedingPreviewAsync(string sireId, string damId, CancellationToken ct = default)
            => Call("POST", "/v1/breeding/preview", Pair(sireId, damId), true, null, true, BreedingPreview.Parse, ct);

        public Task<BreedResult> BreedAsync(string sireId, string damId, string idempotencyKey = null, CancellationToken ct = default)
            => Call("POST", "/v1/breeding", Pair(sireId, damId), true, idempotencyKey ?? NewIdempotencyKey(), true, BreedResult.Parse, ct);

        // ------------------------------------------------------------------ rewards

        public Task<LoginBonusResult> ClaimLoginBonusAsync(string idempotencyKey = null, CancellationToken ct = default)
            => Call("POST", "/v1/rewards/login-bonus", JsonNode.Obj(), true, idempotencyKey ?? NewIdempotencyKey(), true, LoginBonusResult.Parse, ct);

        public Task<List<Mission>> GetMissionsAsync(CancellationToken ct = default)
            => Call("GET", "/v1/missions", null, true, null, true, o => J.List(o, "missions", Mission.Parse), ct);

        public Task<Reward> ClaimMissionAsync(string missionId, string idempotencyKey = null, CancellationToken ct = default)
            => Call("POST", "/v1/missions/" + Seg(missionId) + "/claim", JsonNode.Obj(), true, idempotencyKey ?? NewIdempotencyKey(), true, Reward.Parse, ct);

        public Task<SeasonPassView> GetSeasonPassAsync(CancellationToken ct = default)
            => Call("GET", "/v1/season-pass", null, true, null, true, SeasonPassView.Parse, ct);

        public Task<Reward> ClaimSeasonPassAsync(PassTrack track, int level, string idempotencyKey = null, CancellationToken ct = default)
        {
            var b = JsonNode.Obj();
            b.Set("track", track == PassTrack.Premium ? "premium" : "free");
            b.Set("level", level);
            return Call("POST", "/v1/season-pass/claim", b, true, idempotencyKey ?? NewIdempotencyKey(), true, Reward.Parse, ct);
        }

        // ------------------------------------------------------------------ matchmaking & races

        /// <summary>Joins the ranked queue. Poll <see cref="GetMatchStatusAsync"/> until Matched.</summary>
        public Task<MatchStatus> EnqueueRankedAsync(string horseId, CancellationToken ct = default)
            => Call("POST", "/v1/match/enqueue", HorseBody(horseId), true, null, false, MatchStatus.Parse, ct);

        public Task<MatchStatus> CancelMatchAsync(CancellationToken ct = default)
            => Call("POST", "/v1/match/cancel", JsonNode.Obj(), true, null, true, MatchStatus.Parse, ct);

        public Task<MatchStatus> GetMatchStatusAsync(CancellationToken ct = default)
            => Call("GET", "/v1/match/status", null, true, null, true, MatchStatus.Parse, ct);

        public Task<FriendRoom> CreateFriendRoomAsync(string horseId, CancellationToken ct = default)
            => Call("POST", "/v1/friend-rooms", HorseBody(horseId), true, null, false, FriendRoom.Parse, ct);

        public Task<FriendRoom> JoinFriendRoomAsync(string passphrase, string horseId, CancellationToken ct = default)
            => Call("POST", "/v1/friend-rooms/" + Seg(passphrase) + "/join", HorseBody(horseId), true, null, false, FriendRoom.Parse, ct);

        /// <summary>Host only. Returns the host's seat; other members get theirs from <see cref="GetMatchStatusAsync"/>.</summary>
        public Task<RaceAssignment> StartFriendRoomAsync(string passphrase, CancellationToken ct = default)
            => Call("POST", "/v1/friend-rooms/" + Seg(passphrase) + "/start", JsonNode.Obj(), true, null, false, RaceAssignment.Parse, ct);

        /// <summary>Online tutorial race (1 human + 11 weak CPUs).</summary>
        public Task<RaceAssignment> StartTutorialRaceAsync(string horseId, CancellationToken ct = default)
            => Call("POST", "/v1/race/tutorial", HorseBody(horseId), true, null, false, RaceAssignment.Parse, ct);

        /// <summary>Reports a suspicious race: the server re-computes it.</summary>
        public Task<bool> ReportRaceAsync(string raceId, CancellationToken ct = default)
            => Call("POST", "/v1/race/" + Seg(raceId) + "/report", JsonNode.Obj(), true, null, true, o => J.Bool(o, "ok"), ct);

        // ------------------------------------------------------------------ profile, titles, stats (REQ-STAT/TITLE/SOCIAL)

        /// <summary>Display name shown to friends and on leaderboards (NG-list checked; throws ValidationException NG_NAME).</summary>
        public Task<string> SetDisplayNameAsync(string displayName, CancellationToken ct = default)
        {
            var b = JsonNode.Obj();
            b.Set("displayName", displayName);
            return Call("PUT", "/v1/player/profile", b, true, null, true, o => J.Str(o, "displayName"), ct);
        }

        public Task<TitleList> GetTitlesAsync(CancellationToken ct = default)
            => Call("GET", "/v1/titles", null, true, null, true, TitleList.Parse, ct);

        /// <summary>Equip an unlocked title, or pass null to clear it.</summary>
        public Task<string> EquipTitleAsync(string titleId, CancellationToken ct = default)
        {
            var b = JsonNode.Obj();
            if (titleId == null) b.Set("titleId", JsonNode.Null()); else b.Set("titleId", titleId);
            return Call("PUT", "/v1/player/title", b, true, null, true, o => J.Str(o, "titleId"), ct);
        }

        public Task<PlayerStats> GetStatsAsync(CancellationToken ct = default)
            => Call("GET", "/v1/stats", null, true, null, true, PlayerStats.Parse, ct);

        // ------------------------------------------------------------------ leaderboards (REQ-LB)

        /// <summary>The player's rank in the current season (null fields until the next snapshot).</summary>
        public Task<MyRank> GetMyRankAsync(CancellationToken ct = default)
            => Call("GET", "/v1/leaderboards/me", null, true, null, true, MyRank.Parse, ct);

        /// <summary>
        /// A published snapshot. <paramref name="seasonId"/> is "yyyy-mm" or "current";
        /// <paramref name="board"/> is "class-S"/"class-A"/…, "rating", or "index".
        /// </summary>
        public Task<LeaderboardFile> GetLeaderboardAsync(string seasonId, string board, CancellationToken ct = default)
            => Call("GET", "/v1/leaderboards/" + Seg(seasonId) + "/" + Seg(board), null, false, null, true, LeaderboardFile.Parse, ct);

        // ------------------------------------------------------------------ friends (REQ-SOCIAL)
        // The server treats repeated friend operations as no-ops (already requested / already friends / nothing to
        // remove), so they are all retried on transient failures.

        public Task<FriendList> GetFriendsAsync(CancellationToken ct = default)
            => Call("GET", "/v1/friends", null, true, null, true, FriendList.Parse, ct);

        /// <summary>Your 9-digit friend code.</summary>
        public Task<string> GetFriendCodeAsync(CancellationToken ct = default)
            => Call("GET", "/v1/friends/code", null, true, null, true, o => J.Str(o, "code"), ct);

        /// <summary>Send a request by friend code. If they already asked you, you become friends immediately (Status "friends").</summary>
        public Task<FriendOpResult> SendFriendRequestAsync(string friendCode, CancellationToken ct = default)
        {
            var b = JsonNode.Obj();
            b.Set("code", friendCode);
            return Call("POST", "/v1/friends/requests", b, true, null, true, FriendOpResult.Parse, ct);
        }

        public Task<FriendOpResult> AcceptFriendRequestAsync(string fromId, CancellationToken ct = default)
            => Call("POST", "/v1/friends/requests/" + Seg(fromId) + "/accept", JsonNode.Obj(), true, null, true, FriendOpResult.Parse, ct);

        public Task<bool> DeclineFriendRequestAsync(string fromId, CancellationToken ct = default)
            => Call("POST", "/v1/friends/requests/" + Seg(fromId) + "/decline", JsonNode.Obj(), true, null, true, o => J.Bool(o, "ok"), ct);

        /// <summary>Withdraw a request you sent.</summary>
        public Task<bool> CancelFriendRequestAsync(string toId, CancellationToken ct = default)
            => Call("DELETE", "/v1/friends/requests/" + Seg(toId), null, true, null, true, o => J.Bool(o, "ok"), ct);

        public Task<bool> RemoveFriendAsync(string friendId, CancellationToken ct = default)
            => Call("DELETE", "/v1/friends/" + Seg(friendId), null, true, null, true, o => J.Bool(o, "ok"), ct);

        /// <summary>Invite a friend to a friend room you are in (NOT_ELIGIBLE if not a member or not friends).</summary>
        public Task<bool> InviteToFriendRoomAsync(string passphrase, string friendId, CancellationToken ct = default)
        {
            var b = JsonNode.Obj();
            b.Set("friendId", friendId);
            return Call("POST", "/v1/friend-rooms/" + Seg(passphrase) + "/invite", b, true, null, true, o => J.Bool(o, "ok"), ct);
        }

        // ------------------------------------------------------------------ push notifications (REQ-PUSH)
        // All push calls are idempotent on the server (same token / same settings), so they are retried.

        /// <summary>Register this device's FCM token (call on every app start and whenever FCM rotates the token).</summary>
        public Task<int> RegisterPushDeviceAsync(string fcmToken, PushPlatform platform, CancellationToken ct = default)
        {
            var b = JsonNode.Obj();
            b.Set("token", fcmToken);
            b.Set("platform", platform == PushPlatform.Ios ? "ios" : "android");
            return Call("PUT", "/v1/push/devices", b, true, null, true, o => J.Int(o, "devices"), ct);
        }

        /// <summary>Remove a token (logout, or the user turned notifications off in the OS).</summary>
        public Task<int> UnregisterPushDeviceAsync(string fcmToken, CancellationToken ct = default)
        {
            var b = JsonNode.Obj();
            b.Set("token", fcmToken);
            return Call("POST", "/v1/push/devices/unregister", b, true, null, true, o => J.Int(o, "removed"), ct);
        }

        /// <summary>Current settings plus the FCM topics to (un)subscribe — apply <see cref="PushPreferences.SubscribeTopics"/> after every call.</summary>
        public Task<PushPreferences> GetPushPreferencesAsync(CancellationToken ct = default)
            => Call("GET", "/v1/push/preferences", null, true, null, true, PushPreferences.Parse, ct);

        /// <summary>Change only what is set in <paramref name="patch"/>. Returns the full settings and the topics to apply.</summary>
        public Task<PushPreferences> SetPushPreferencesAsync(PushPreferencesPatch patch, CancellationToken ct = default)
            => Call("PUT", "/v1/push/preferences", patch.ToJson(), true, null, true, PushPreferences.Parse, ct);

        // ------------------------------------------------------------------ analytics (REQ-KPI)

        /// <summary>
        /// Sends one batch of client analytics events (max 50). Not retried here — <see cref="AnalyticsClient"/>
        /// keeps unsent events and decides when to try again. Throws <see cref="RateLimitedException"/> on 429.
        /// </summary>
        public Task<AnalyticsIngestResult> SendAnalyticsAsync(string platform, string appVersion, IReadOnlyList<AnalyticsEvent> events, CancellationToken ct = default)
        {
            var b = JsonNode.Obj();
            b.Set("platform", platform);
            b.Set("appVersion", appVersion);
            var arr = JsonNode.Arr();
            foreach (var e in events) arr.Add(e.ToJson());
            b.Set("events", arr);
            return Call("POST", "/v1/analytics/events", b, true, null, false, AnalyticsIngestResult.Parse, ct);
        }

        // ------------------------------------------------------------------ time attack & ghosts (REQ-TA)

        /// <summary>
        /// Start a time attack: the server issues the config (seed, track, ruleset, normalised horse) and a
        /// short-lived token. Consumes one of today's attempts, so it is NOT retried automatically.
        /// </summary>
        public Task<TimeAttackSession> StartTimeAttackAsync(string trackId, string horseId, CancellationToken ct = default)
        {
            var b = JsonNode.Obj();
            b.Set("trackId", trackId);
            b.Set("horseId", horseId);
            return Call("POST", "/v1/time-attack/start", b, true, null, false, TimeAttackSession.Parse, ct);
        }

        /// <summary>
        /// Submit a finished run: only the recorded inputs and the result hash are sent; the server re-simulates
        /// the config it issued. Retried safely (the server returns the stored result for a repeated submit).
        /// Throws ConflictException TA_RESULT_MISMATCH when the re-simulation differs (tampered/desynced client).
        /// </summary>
        public Task<TimeAttackResult> SubmitTimeAttackAsync(TimeAttackSession session, OfflineRace race, CancellationToken ct = default)
        {
            if (session == null) throw new ArgumentNullException(nameof(session));
            if (race == null || !race.IsFinished) throw new InvalidOperationException("the race has not finished");
            return SubmitTimeAttackAsync(session, race.RecordedInputs, race.ResultHash, ct);
        }

        public Task<TimeAttackResult> SubmitTimeAttackAsync(TimeAttackSession session, IReadOnlyList<Muchi.Engine.InputRecord> inputs, string resultHash, CancellationToken ct = default)
        {
            var b = JsonNode.Obj();
            b.Set("sessionId", session.SessionId);
            b.Set("token", session.Token);
            b.Set("resultHash", resultHash);
            var arr = JsonNode.Arr();
            foreach (var r in inputs)
            {
                var t = JsonNode.Arr();
                t.Add(JsonNode.Num(r.Tick));
                t.Add(JsonNode.Num(r.Slot));
                t.Add(JsonNode.Num(r.Cmd));
                arr.Add(t);
            }
            b.Set("inputs", arr);
            if (session.ConfigJson != null) b.Set("config", session.ConfigJson);
            return Call("POST", "/v1/time-attack/submit", b, true, null, true, TimeAttackResult.Parse, ct);
        }

        /// <summary>Your season / all-time best, attempts left today, milestones and rank on a track.</summary>
        public Task<TimeAttackMe> GetTimeAttackMeAsync(string trackId, CancellationToken ct = default)
            => Call("GET", "/v1/time-attack/" + Seg(trackId) + "/me", null, true, null, true, TimeAttackMe.Parse, ct);

        /// <summary>Ghost candidates for a track: top runs, friends' bests, or your own best (this season unless given).</summary>
        public Task<GhostList> GetGhostsAsync(string trackId, GhostKind kind = GhostKind.Top, string seasonId = null, CancellationToken ct = default)
        {
            string k = kind == GhostKind.Friends ? "friends" : kind == GhostKind.Me ? "me" : "top";
            string q = "?kind=" + k + (seasonId != null ? "&seasonId=" + Uri.EscapeDataString(seasonId) : "");
            return Call("GET", "/v1/time-attack/" + Seg(trackId) + "/ghosts" + q, null, true, null, true, GhostList.Parse, ct);
        }

        /// <summary>Download one ghost (its verified replay log). <paramref name="entry"/> comes from <see cref="GetGhostsAsync"/>.</summary>
        public Task<Ghost> GetGhostAsync(GhostEntry entry, CancellationToken ct = default)
            => Call("GET", entry.Path, null, true, null, true, Ghost.Parse, ct);

        public Task<Ghost> GetGhostAsync(string seasonId, string trackId, string playerId, CancellationToken ct = default)
            => Call("GET", "/v1/time-attack/ghosts/" + Seg(seasonId) + "/" + Seg(trackId) + "/" + Seg(playerId), null, true, null, true, Ghost.Parse, ct);

        // ------------------------------------------------------------------ core

        private static string Seg(string s)
        {
            if (string.IsNullOrEmpty(s)) throw new ArgumentException("path segment is empty");
            return Uri.EscapeDataString(s);
        }

        private static JsonNode HorseBody(string horseId)
        {
            var b = JsonNode.Obj();
            b.Set("horseId", horseId);
            return b;
        }

        private static JsonNode Pair(string sireId, string damId)
        {
            var b = JsonNode.Obj();
            b.Set("sireId", sireId);
            b.Set("damId", damId);
            return b;
        }

        private async Task<T> Call<T>(string method, string path, JsonNode body, bool auth, string idemKey, bool safe, Func<JsonNode, T> parse, CancellationToken ct)
        {
            bool retryable = safe || method == "GET" || idemKey != null;
            bool refreshedToken = false;
            int attempt = 0;
            while (true)
            {
                ct.ThrowIfCancellationRequested();
                var req = new HttpRequest { Method = method, Path = path, Body = body?.ToString() };
                req.Headers["accept"] = "application/json";
                if (body != null) req.Headers["content-type"] = "application/json";
                if (idemKey != null) req.Headers["idempotency-key"] = idemKey;
                if (auth)
                {
                    if (!string.IsNullOrEmpty(_opt.DevUserId)) req.Headers["x-dev-user"] = _opt.DevUserId;
                    else req.Headers["authorization"] = "Bearer " + await _auth.GetTokenAsync(refreshedToken, ct).ConfigureAwait(false);
                }

                HttpResponse res;
                try
                {
                    res = await _http.SendAsync(req, ct).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (ct.IsCancellationRequested)
                {
                    throw;
                }
                catch (Exception e)
                {
                    if (retryable && attempt < _opt.Retry.MaxRetries)
                    {
                        await _delay.Delay(_opt.Retry.DelayFor(attempt++), ct).ConfigureAwait(false);
                        continue;
                    }
                    throw new NetworkException(method + " " + path + ": " + e.Message, e);
                }

                if (res.Status >= 200 && res.Status < 300)
                {
                    JsonNode node = string.IsNullOrWhiteSpace(res.Body) ? JsonNode.Null() : JsonNode.Parse(res.Body);
                    return parse(node);
                }

                if (res.Status == 401 && auth && string.IsNullOrEmpty(_opt.DevUserId) && !refreshedToken)
                {
                    refreshedToken = true;
                    continue;
                }

                if ((res.Status >= 500 || res.Status == 429) && retryable && attempt < _opt.Retry.MaxRetries)
                {
                    await _delay.Delay(_opt.Retry.DelayFor(attempt++), ct).ConfigureAwait(false);
                    continue;
                }

                throw ParseError(res);
            }
        }

        internal static ApiException ParseError(HttpResponse res)
        {
            string wire = null, message = null;
            try
            {
                var o = JsonNode.Parse(res.Body ?? "");
                var e = J.Opt(o, "error");
                wire = J.Str(e, "code");
                message = J.Str(e, "message");
            }
            catch (FormatException) { }
            if (wire == null) wire = res.Status >= 500 ? "INTERNAL" : res.Status == 401 ? "UNAUTHORIZED" : res.Status == 404 ? "NOT_FOUND" : "BAD_REQUEST";
            return ApiErrorCodes.Create(wire, message, res.Status);
        }
    }
}
