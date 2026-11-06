using System.IO;
using System.Linq;
using Muchi.Client;
using Muchi.Net;

namespace Muchi.Engine.Tests
{
    /// <summary>
    /// Round 8 client routes on the wire: onboarding (contracts/protocol.md §8.7) and monetization (§13). The
    /// response bodies below were produced by the real server code (PlayerService with the shipped master data),
    /// so their shapes match server/src/domain/onboarding.ts, accountDeletion.ts, shop.ts, pass.ts and rewards.ts.
    /// </summary>
    public class ApiClientRound8Tests
    {
        private readonly FakeHttp _http = new FakeHttp();
        private readonly FakeDelay _delay = new FakeDelay();
        private readonly ApiClient _api;

        public ApiClientRound8Tests()
        {
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test" };
            opt.Retry.Jitter = _ => 0;
            _api = new ApiClient(_http, new FakeAuth(), opt, _delay, new SeqIds());
        }

        private static string Canon(string json) => JsonNode.Parse(json).ToString();

        private HttpRequest Last(string method, string path, string body = null, string key = null)
        {
            var r = _http.Requests[_http.Requests.Count - 1];
            Assert.Equal(method, r.Method);
            Assert.Equal(path, r.Path);
            if (body == null) Assert.True(r.Body == null || r.Body == "{}", "unexpected body " + r.Body);
            else Assert.Equal(Canon(body), Canon(r.Body));
            if (key == null) Assert.False(r.Headers.ContainsKey("idempotency-key"));
            else Assert.Equal(key, r.Headers["idempotency-key"]);
            Assert.Equal("Bearer token", r.Headers["authorization"]);
            return r;
        }

        private async Task<T> Via<T>(System.Func<Task<T>> call, string body)
        {
            _http.Reply(200, body);
            return await call();
        }

        private const string Err409 = "{{\"error\":{{\"code\":\"{0}\",\"message\":\"x\"}}}}";
        private static string E(string code) => string.Format(Err409, code);

        internal const string Consent = @"{""termsVersion"":""2026-11-01"",""privacyVersion"":""2026-11-01"",""consentedAt"":1795575600000,""current"":{""termsVersion"":""2026-11-01"",""privacyVersion"":""2026-11-01""},""required"":false}";
        internal const string Partner = @"{""horse"":{""id"":""h1"",""templateId"":""t_partner"",""name"":""アイボウ"",""rarity"":""SR"",""sex"":""male"",""style"":""sashi"",""distMinM"":1600,""distMaxM"":2400,""surface"":""turf"",""line"":""akatsuki"",""base"":{""speed"":700,""stamina"":680,""burst"":720,""guts"":620,""temper"":600},""awakening"":0,""bornAt"":1795575600000,""status"":""active"",""sireId"":null,""damId"":null,""sireName"":""ハジマリノカゼ"",""damName"":""アサツユヒメ"",""named"":true,""appearance"":{""coat"":""chestnut"",""face"":""blaze"",""legs"":[""none"",""none"",""sock"",""none""],""mane"":""normal"",""build"":""standard""}}}";
        internal const string LoginBeginner = @"{""day"":1,""track"":""beginner"",""reward"":{""day"":1,""freeCoins"":50},""beginnerDaysLeft"":6}";
        internal const string Missions = @"{""missions"":[{""id"":""race3"",""kind"":""races"",""target"":3,""reward"":{""freeCoins"":20},""progress"":3,""claimed"":false},{""id"":""win1"",""kind"":""wins"",""target"":1,""reward"":{""freeCoins"":30},""progress"":1,""claimed"":false},{""id"":""top3x2"",""kind"":""top3"",""target"":2,""reward"":{""items"":[{""itemId"":""breeding_material"",""qty"":1}]},""progress"":1,""claimed"":false}],""beginner"":{""completed"":false,""steps"":[{""id"":""bm_scout"",""step"":1,""kind"":""gacha"",""target"":1,""progress"":0,""reward"":{""freeCoins"":50},""claimed"":false,""locked"":false,""claimable"":false},{""id"":""bm_silks"",""step"":2,""kind"":""silks"",""target"":1,""progress"":0,""reward"":{""freeCoins"":50},""claimed"":false,""locked"":true,""claimable"":false},{""id"":""bm_care"",""step"":3,""kind"":""care"",""target"":1,""progress"":0,""reward"":{""freeCoins"":50},""claimed"":false,""locked"":true,""claimable"":false},{""id"":""bm_ranked_top3"",""step"":4,""kind"":""ranked_top3"",""target"":1,""progress"":1,""reward"":{""items"":[{""itemId"":""gacha_ticket"",""qty"":1}]},""claimed"":false,""locked"":true,""claimable"":false}]},""season"":{""seasonId"":""2026-11"",""missions"":[{""id"":""sm_races10"",""kind"":""ranked_races"",""target"":10,""progress"":6,""reward"":{""passXp"":100},""claimed"":false,""available"":true,""claimable"":false},{""id"":""sm_races30"",""kind"":""ranked_races"",""target"":30,""progress"":6,""reward"":{""passXp"":200},""claimed"":false,""available"":true,""claimable"":false},{""id"":""sm_wins5"",""kind"":""wins"",""target"":5,""progress"":1,""reward"":{""passXp"":150},""claimed"":false,""available"":true,""claimable"":false},{""id"":""sm_top3_15"",""kind"":""top3"",""target"":15,""progress"":1,""reward"":{""passXp"":150},""claimed"":false,""available"":true,""claimable"":false},{""id"":""sm_promotion"",""kind"":""promotion_line"",""target"":300,""progress"":70,""reward"":{""passXp"":300},""claimed"":false,""available"":true,""claimable"":false}]},""firstWinBonus"":{""modes"":[""ranked""],""byWin"":[30,20,10],""winsToday"":1,""remaining"":2,""next"":20}}";
        internal const string Products = @"{""products"":[{""id"":""coin_160"",""kind"":""coins"",""name"":""コイン100"",""tab"":""coins"",""storeType"":""consumable"",""priceYen"":160,""paidCoins"":100,""autoRenew"":false,""contents"":[{""type"":""paid_coins"",""qty"":100,""label"":""有償コイン100枚""}],""firstPurchaseBonus"":{""coins"":100,""currency"":""free"",""label"":""はじめての購入時のみ：無償コイン100枚をプレゼント""},""oneTime"":false,""oneTimeScope"":null,""period"":null,""noticeKeys"":[""shop.paid_first"",""shop.first_purchase_bonus"",""legal.tokushoho"",""legal.shikin_kessai""]},{""id"":""stable_allowance_30d"",""kind"":""allowance"",""name"":""厩舎手当（30日）"",""tab"":""recommended"",""storeType"":""consumable"",""priceYen"":480,""paidCoins"":100,""allowance"":{""days"":30,""dailyFreeCoins"":30},""autoRenew"":false,""contents"":[{""type"":""paid_coins"",""qty"":100,""label"":""有償コイン100枚""},{""type"":""daily_free_coins"",""qty"":30,""days"":30,""total"":900,""label"":""30日間、毎日 無償コイン30枚（1日1回受け取り）""}],""firstPurchaseBonus"":null,""oneTime"":false,""oneTimeScope"":null,""period"":{""kind"":""days"",""days"":30},""noticeKeys"":[""shop.paid_first"",""shop.no_auto_renew"",""shop.allowance_daily_claim"",""shop.allowance_no_stack"",""legal.tokushoho"",""legal.shikin_kessai""]},{""id"":""season_pass_plus"",""kind"":""season_pass"",""name"":""シーズンパス＋"",""tab"":""pass"",""storeType"":""consumable"",""priceYen"":2400,""paidCoins"":0,""pass"":{""levels"":10},""items"":[{""itemId"":""costume_season_limited"",""qty"":1},{""itemId"":""tack_bridle_pass_plus"",""qty"":1}],""autoRenew"":false,""contents"":[{""type"":""pass_premium"",""levels"":30,""reward"":{""freeCoins"":50,""items"":[{""itemId"":""breeding_material"",""qty"":1}]},""label"":""シーズンパス有料ライン 全30段（各段：無償コイン50枚＋配合素材×1）""},{""type"":""pass_levels"",""qty"":10,""label"":""パスのレベル＋10（購入時）""},{""type"":""item"",""itemId"":""costume_season_limited"",""qty"":1,""label"":""シーズン限定勝負服の柄「炎」×1""},{""type"":""item"",""itemId"":""tack_bridle_pass_plus"",""qty"":1,""label"":""限定馬具「シーズンパス＋の頭絡」×1""}],""firstPurchaseBonus"":null,""oneTime"":false,""oneTimeScope"":null,""period"":{""kind"":""season""},""noticeKeys"":[""shop.paid_first"",""shop.no_auto_renew"",""shop.pass_season_only"",""shop.pass_auto_grant"",""legal.tokushoho"",""legal.shikin_kessai""]},{""id"":""promo_pack_B"",""kind"":""promotion"",""name"":""昇級記念パック（B級）"",""tab"":""recommended"",""storeType"":""non_consumable"",""priceYen"":1500,""paidCoins"":1020,""once"":true,""classId"":""B"",""items"":[{""itemId"":""costume_promo_b"",""qty"":1}],""autoRenew"":false,""contents"":[{""type"":""paid_coins"",""qty"":1020,""label"":""有償コイン1,020枚""},{""type"":""item"",""itemId"":""costume_promo_b"",""qty"":1,""label"":""B級昇級記念の勝負服の柄×1""}],""firstPurchaseBonus"":null,""oneTime"":true,""oneTimeScope"":""class"",""period"":null,""noticeKeys"":[""shop.paid_first"",""shop.one_time_per_class"",""legal.tokushoho"",""legal.shikin_kessai""]}],""notices"":{""shop.paid_first"":""有償コインから先に使われます"",""shop.first_purchase_bonus"":""コインのパックは、はじめて購入したときだけ、同じ枚数の無償コインをプレゼントします（パックごとに1回）""},""legalLinks"":[{""key"":""legal.tokushoho"",""title"":""特定商取引法に基づく表記""},{""key"":""legal.shikin_kessai"",""title"":""資金決済法に基づく表示""},{""key"":""shop.paid_first"",""title"":""有償コインの使用順""}],""notice"":""有償コインから先に使われます""}";
        internal const string IntentCoin = @"{""product"":{""id"":""coin_160"",""kind"":""coins"",""name"":""コイン100"",""tab"":""coins"",""storeType"":""consumable"",""priceYen"":160,""paidCoins"":100},""monthSpentYen"":0,""monthlyLimitYen"":null,""remainingYen"":null,""firstPurchaseBonus"":{""coins"":100,""currency"":""free"",""label"":""はじめての購入時のみ：無償コイン100枚をプレゼント""}}";
        internal const string IntentPass = @"{""product"":{""id"":""season_pass_plus"",""kind"":""season_pass"",""name"":""シーズンパス＋"",""tab"":""pass"",""storeType"":""consumable"",""priceYen"":2400,""paidCoins"":0,""pass"":{""levels"":10},""items"":[{""itemId"":""costume_season_limited"",""qty"":1},{""itemId"":""tack_bridle_pass_plus"",""qty"":1}]},""monthSpentYen"":0,""monthlyLimitYen"":null,""remainingYen"":null,""firstPurchaseBonus"":null,""pass"":{""seasonId"":""2026-11"",""endsAt"":1796050800000,""remainingDays"":6,""lastWeek"":true,""autoRenew"":false,""levels"":10}}";
        internal const string IntentAllowance = @"{""product"":{""id"":""stable_allowance_30d"",""kind"":""allowance"",""name"":""厩舎手当（30日）"",""tab"":""recommended"",""storeType"":""consumable"",""priceYen"":480,""paidCoins"":100,""allowance"":{""days"":30,""dailyFreeCoins"":30}},""monthSpentYen"":0,""monthlyLimitYen"":null,""remainingYen"":null,""firstPurchaseBonus"":null,""allowance"":{""days"":30,""dailyFreeCoins"":30,""autoRenew"":false}}";
        internal const string Offers = @"{""offers"":[{""id"":""starter_pack"",""productId"":""starter_pack"",""touchpoint"":""T2"",""placement"":""popup"",""reason"":""first_4th_or_worse"",""triggeredAt"":1795575600000,""viewedAt"":null,""showPopup"":true,""endsAt"":null,""remainingDays"":null},{""id"":""season_pass_2026_11"",""productId"":""season_pass"",""touchpoint"":""T3"",""placement"":""popup"",""reason"":""pass_level_up"",""triggeredAt"":1795575600000,""viewedAt"":null,""showPopup"":true,""endsAt"":1796050800000,""remainingDays"":6},{""id"":""season_pass_2026_11_plus"",""productId"":""season_pass_plus"",""touchpoint"":""T3"",""placement"":""recommended"",""reason"":""pass_level_up"",""triggeredAt"":1795575600000,""viewedAt"":null,""showPopup"":false,""endsAt"":1796050800000,""remainingDays"":6},{""id"":""stable_allowance_30d"",""productId"":""stable_allowance_30d"",""touchpoint"":""shop"",""placement"":""recommended"",""reason"":null,""triggeredAt"":null,""viewedAt"":null,""showPopup"":false,""endsAt"":null,""remainingDays"":null}],""firstPurchase"":{""available"":true,""productIds"":[""coin_160"",""coin_480"",""coin_800"",""coin_1500"",""coin_2400"",""coin_3800"",""coin_5000"",""coin_10000""],""noticeKey"":""shop.first_purchase_bonus""},""allowance"":{""active"":false,""claimedToday"":false,""queued"":null}}";
        internal const string Viewed = @"{""offerId"":""starter_pack"",""viewedAt"":1795575600000}";
        internal const string Allowance = @"{""active"":true,""productId"":""stable_allowance_30d"",""startDate"":""2026-11-25"",""endDate"":""2026-12-24"",""day"":1,""days"":30,""daysLeft"":30,""dailyFreeCoins"":30,""claimedToday"":false,""claimedDays"":0,""queued"":null}";
        internal const string AllowanceClaim = @"{""freeCoins"":30,""active"":true,""productId"":""stable_allowance_30d"",""startDate"":""2026-11-25"",""endDate"":""2026-12-24"",""day"":1,""days"":30,""daysLeft"":30,""dailyFreeCoins"":30,""claimedToday"":true,""claimedDays"":1,""queued"":null,""wallet"":{""paid"":100,""free"":195,""total"":295,""debt"":0}}";
        internal const string SeasonPass = @"{""seasonId"":""2026-11"",""level"":11,""xp"":1120,""xpPerLevel"":100,""maxLevel"":30,""xpToNextLevel"":80,""racesToNextLevel"":4,""active"":true,""expiresAt"":1796050800000,""seasonEndsAt"":1796050800000,""remainingDays"":6,""lastWeek"":true,""autoRenew"":false,""boostLevels"":10,""owned"":[""season_pass_plus""],""purchasable"":[],""claimed"":{""free"":[],""premium"":[]},""rewards"":{""free"":{""every"":1,""reward"":{""freeCoins"":10}},""premium"":{""every"":1,""reward"":{""freeCoins"":50,""items"":[{""itemId"":""breeding_material"",""qty"":1}]}}},""autoGrantAtSeasonEnd"":true,""lastSeason"":null}";
        internal const string Ticket10 = @"{""itemId"":""gacha_ticket_10"",""bannerId"":""standard"",""result"":{""templateId"":""t_kurogane"",""rarity"":""SR"",""horseId"":""h2"",""duplicate"":false,""material"":0,""guaranteed"":false,""appearance"":{""coat"":""bay"",""face"":""star_stripe"",""legs"":[""none"",""stocking"",""none"",""none""],""mane"":""normal"",""build"":""compact""}},""results"":[{""templateId"":""t_kurogane"",""rarity"":""SR"",""horseId"":""h2"",""duplicate"":false,""material"":0,""guaranteed"":false,""appearance"":{""coat"":""bay"",""face"":""star_stripe"",""legs"":[""none"",""stocking"",""none"",""none""],""mane"":""normal"",""build"":""compact""}},{""templateId"":""t_yukimi"",""rarity"":""R"",""horseId"":""h3"",""duplicate"":false,""material"":0,""guaranteed"":false,""appearance"":{""coat"":""dark_bay"",""face"":""none"",""legs"":[""none"",""none"",""sock"",""none""],""mane"":""normal"",""build"":""rangy""}},{""templateId"":""t_kazamidori"",""rarity"":""R"",""horseId"":""h4"",""duplicate"":false,""material"":0,""guaranteed"":false,""appearance"":{""coat"":""dark_bay"",""face"":""none"",""legs"":[""none"",""none"",""none"",""none""],""mane"":""dark"",""build"":""standard""}}],""pityPoints"":10,""remaining"":0}";
        internal const string DeleteStep1 = @"{""status"":""confirm_required"",""confirmToken"":""del_18p8ego1t2zgdr19mlpdi1syr9z0"",""expiresAt"":1795576200000,""cancelWindowDays"":14,""forfeit"":{""paidCoins"":100,""freeCoins"":195,""horses"":8,""items"":2,""allowanceDays"":29,""seasonPass"":true},""notice"":""削除を確定すると14日後にアカウントと全てのデータが削除されます。期間内は取り消せます。有償コイン・無償コイン・馬・アイテム・厩舎手当の残りの日数・シーズンパスは全て失われ、払い戻しはありません。購入の記録は法令に基づき、個人を特定できない形で保存します。""}";
        internal const string DeleteStep2 = @"{""status"":""scheduled"",""requestedAt"":1795575600000,""deleteAt"":1796785200000}";
        internal const string Player = @"{""id"":""u1"",""wallet"":{""paid"":100,""free"":195,""total"":295,""debt"":0},""consent"":{""termsVersion"":""2026-11-01"",""privacyVersion"":""2026-11-01"",""consentedAt"":1795575600000,""current"":{""termsVersion"":""2026-11-01"",""privacyVersion"":""2026-11-01""},""required"":false},""unlocks"":{""day"":1,""races"":6,""rankedRaces"":6,""breedings"":0,""features"":[{""key"":""race"",""unlocked"":true,""by"":""always"",""races"":null,""days"":null,""rankedRaces"":null,""breedings"":null},{""key"":""missions"",""unlocked"":true,""by"":""races"",""races"":2,""days"":null,""rankedRaces"":null,""breedings"":null},{""key"":""breeding"",""unlocked"":false,""by"":null,""races"":8,""days"":2,""rankedRaces"":null,""breedings"":null},{""key"":""stud"",""unlocked"":false,""by"":null,""races"":null,""days"":null,""rankedRaces"":null,""breedings"":3}]},""experiments"":{""assignments"":{},""values"":{}},""deletion"":{""status"":""scheduled"",""requestedAt"":1795575600000,""deleteAt"":1796785200000},""flags"":{""tutorialGachaUsed"":false,""partnerHorseId"":""h1""},""loginBonus"":{""streakDay"":0,""lastClaimDate"":""2026-11-25"",""beginnerDay"":1},""seasonPass"":{""expiresAt"":1796050800000,""xp"":1120,""claimed"":{""free"":[],""premium"":[]},""seasonId"":""2026-11"",""boostXp"":1000}}";
        internal const string DeletionCancelled = @"{""status"":""none"",""requestedAt"":null,""deleteAt"":null}";
        // ------------------------------------------------------------------ onboarding (§8.7)

        [Fact]
        public async Task ConsentIsRetriedAndAVersionMismatchIsTyped()
        {
            _http.Fail(new IOException("reset")).Reply(200, Consent);
            var c = await _api.RecordConsentAsync("2026-11-01", "2026-11-01");
            Last("POST", "/v1/player/consent", "{\"termsVersion\":\"2026-11-01\",\"privacyVersion\":\"2026-11-01\"}");
            Assert.Equal(2, _http.Requests.Count); // idempotent: retried
            Assert.False(c.Required);
            Assert.Equal("2026-11-01", c.Current.TermsVersion);
            Assert.Equal(1795575600000L, c.ConsentedAt);

            _http.Reply(409, E("CONSENT_VERSION_MISMATCH"));
            var e = await Assert.ThrowsAsync<ConflictException>(() => _api.RecordConsentAsync("old", "2026-11-01"));
            Assert.Equal(ApiErrorCode.ConsentVersionMismatch, e.Code);
        }

        [Fact]
        public async Task PartnerIsKeyedAndRetriedWithTheSameKey()
        {
            _http.Reply(503, E("INTERNAL")).Reply(200, Partner);
            var h = await _api.GrantPartnerAsync("アイボウ");
            Last("POST", "/v1/player/partner", "{\"name\":\"アイボウ\"}", "key1");
            Assert.All(_http.Requests, r => Assert.Equal("key1", r.Headers["idempotency-key"]));
            Assert.Equal("t_partner", h.TemplateId);
            Assert.Equal("アイボウ", h.Name);
            Assert.True(h.Named);
            Assert.Equal("SR", h.Rarity);

            _http.Reply(409, E("PARTNER_ALREADY_GRANTED"));
            var e = await Assert.ThrowsAsync<ConflictException>(() => _api.GrantPartnerAsync("ニバンメ", "mine"));
            Assert.Equal(ApiErrorCode.PartnerAlreadyGranted, e.Code);
            Last("POST", "/v1/player/partner", "{\"name\":\"ニバンメ\"}", "mine");
        }

        [Fact]
        public async Task AccountDeletionTwoStepsAndCancel()
        {
            _http.Reply(200, DeleteStep1);
            var s1 = await _api.RequestAccountDeletionAsync();
            Last("DELETE", "/v1/player");
            Assert.True(s1.ConfirmRequired);
            Assert.StartsWith("del_", s1.ConfirmToken);
            Assert.Equal(14, s1.CancelWindowDays);
            Assert.Equal(100, s1.Forfeit.PaidCoins);
            Assert.Equal(195, s1.Forfeit.FreeCoins);
            Assert.Equal(29, s1.Forfeit.AllowanceDays);
            Assert.True(s1.Forfeit.SeasonPass);
            Assert.Contains("厩舎手当", s1.Notice);

            _http.Requests.Clear();
            _http.Fail(new IOException("timeout")).Reply(200, DeleteStep2);
            var s2 = await _api.ConfirmAccountDeletionAsync(s1.ConfirmToken);
            Last("DELETE", "/v1/player", "{\"confirmToken\":\"" + s1.ConfirmToken + "\"}");
            Assert.Equal(2, _http.Requests.Count); // scheduling again returns the schedule: retried
            Assert.True(s2.Scheduled);
            Assert.Equal(1796785200000L, s2.DeleteAt);

            _http.Requests.Clear();
            _http.Reply(409, E("DELETION_CONFIRM_INVALID"));
            var bad = await Assert.ThrowsAsync<ConflictException>(() => _api.ConfirmAccountDeletionAsync("del_x"));
            Assert.Equal(ApiErrorCode.DeletionConfirmInvalid, bad.Code);

            _http.Reply(200, DeletionCancelled);
            var c = await _api.CancelAccountDeletionAsync();
            Last("POST", "/v1/player/deletion/cancel");
            Assert.False(c.Scheduled);
            Assert.Null(c.DeleteAt);

            // step 1 and cancel are not idempotent: never retried
            _http.Requests.Clear();
            _http.Fail(new IOException("reset"));
            await Assert.ThrowsAsync<NetworkException>(() => _api.RequestAccountDeletionAsync());
            _http.Fail(new IOException("reset"));
            await Assert.ThrowsAsync<NetworkException>(() => _api.CancelAccountDeletionAsync());
            Assert.Equal(2, _http.Requests.Count);

            // the run has started: irreversible, a distinct code (QA r8)
            _http.Requests.Clear();
            _http.Reply(409, E("DELETION_IN_PROGRESS"));
            var started = await Assert.ThrowsAsync<ConflictException>(() => _api.CancelAccountDeletionAsync());
            Assert.Equal(ApiErrorCode.DeletionInProgress, started.Code);
        }

        [Fact]
        public async Task PlayerViewCarriesConsentUnlocksExperimentsDeletionAndPartner()
        {
            _http.Reply(200, Player);
            var v = await _api.GetPlayerAsync();
            Assert.False(v.Consent.Required);
            Assert.Equal("2026-11-01", v.Consent.Current.PrivacyVersion);
            Assert.Equal(1, v.Unlocks.Day);
            Assert.Equal(6, v.Unlocks.RankedRaces);
            Assert.True(v.Unlocks.IsUnlocked("race"));
            var missions = v.Unlocks.Features.Single(f => f.Key == "missions");
            Assert.True(missions.Unlocked);
            Assert.Equal("races", missions.By);
            Assert.Equal(2, missions.Races);
            var breeding = v.Unlocks.Features.Single(f => f.Key == "breeding");
            Assert.False(breeding.Unlocked);
            Assert.Null(breeding.By);
            Assert.Equal(2, breeding.Days);
            Assert.Equal(3, v.Unlocks.Features.Single(f => f.Key == "stud").Breedings);
            Assert.Empty(v.Experiments.Assignments);
            Assert.Null(v.Experiments.FirstWinBonus);
            Assert.True(v.Deletion.Scheduled);
            Assert.Equal(1796785200000L, v.Deletion.DeleteAt);
            Assert.Equal("h1", v.PartnerHorseId);
            Assert.Equal(1, v.LoginBeginnerDay);
            Assert.Equal(1000, v.SeasonPass.BoostXp);
        }

        [Fact]
        public async Task ExperimentValuesAreTyped()
        {
            var x = (await Via(() => _api.GetPlayerAsync(), "{\"experiments\":" + "{\"assignments\":{\"ab_home_button\":\"b\"},\"values\":{\"homePrimaryButton\":\"ranked_promotion\",\"tutorialDistanceM\":600,\"firstWinBonus\":false,\"starterOfferTrigger\":\"fifth_race\",\"firstRankedTrackId\":null}}}")).Experiments;
            Assert.Equal("b", x.Assignments["ab_home_button"]);
            Assert.Equal("ranked_promotion", x.HomePrimaryButton);
            Assert.Equal(600, x.TutorialDistanceM);
            Assert.False(x.FirstWinBonus);
            Assert.Equal("fifth_race", x.StarterOfferTrigger);
            Assert.Null(x.FirstRankedTrackId);
        }

        [Fact]
        public async Task MissionBoardHasDailyBeginnerSeasonAndFirstWinBonus()
        {
            _http.Reply(200, Missions);
            var b = await _api.GetMissionBoardAsync();
            Last("GET", "/v1/missions");
            Assert.Equal(new[] { "race3", "win1", "top3x2" }, b.Missions.Select(x => x.Id).ToArray());
            Assert.Equal(20, b.Missions[0].Reward.FreeCoins);
            Assert.True(b.Missions[0].Claimable);
            Assert.False(b.Beginner.Completed);
            Assert.Equal("bm_scout", b.Beginner.Steps[0].Id);
            Assert.False(b.Beginner.Steps[0].Locked);
            Assert.True(b.Beginner.Steps[3].Locked);
            Assert.Equal(1, b.Beginner.Steps[3].Progress);
            Assert.Equal("gacha_ticket", b.Beginner.Steps[3].Reward.Items[0].ItemId);
            Assert.Equal("2026-11", b.Season.SeasonId);
            var promo = b.Season.Missions.Single(m => m.Id == "sm_promotion");
            Assert.Equal(300, promo.Target);
            Assert.Equal(300, promo.Reward.PassXp);
            Assert.True(promo.Available);
            Assert.Equal(new[] { "ranked" }, b.FirstWinBonus.Modes.ToArray());
            Assert.Equal(new[] { 30, 20, 10 }, b.FirstWinBonus.ByWin);
            Assert.Equal(1, b.FirstWinBonus.WinsToday);
            Assert.Equal(2, b.FirstWinBonus.Remaining);
            Assert.Equal(20, b.FirstWinBonus.Next);

            // the old daily-only call keeps working on the same body
            _http.Reply(200, Missions);
            Assert.Equal(3, (await _api.GetMissionsAsync()).Count);

            // a season mission is claimed on the same endpoint and pays pass XP
            _http.Reply(200, "{\"passXp\":100}");
            var r = await _api.ClaimMissionAsync("sm_races10");
            Last("POST", "/v1/missions/sm_races10/claim", null, "key1");
            Assert.Equal(100, r.PassXp);
        }

        [Fact]
        public async Task BeginnerLoginBonusTrackAndBroodmareReward()
        {
            _http.Reply(200, LoginBeginner);
            var r = await _api.ClaimLoginBonusAsync();
            Assert.True(r.IsBeginner);
            Assert.Equal(6, r.BeginnerDaysLeft);
            Assert.Equal(50, r.Reward.FreeCoins);
            var day2 = await Via(() => _api.ClaimLoginBonusAsync(), "{\"day\":2,\"track\":\"beginner\",\"reward\":{\"day\":2,\"broodmare\":\"t_broodmare\"},\"beginnerDaysLeft\":5}");
            Assert.Equal("t_broodmare", day2.Reward.Broodmare);
            var normal = await Via(() => _api.ClaimLoginBonusAsync(), "{\"day\":3,\"reward\":{\"freeCoins\":10}}");
            Assert.False(normal.IsBeginner); // older servers send no track
        }

        [Fact]
        public async Task TenPullTicketReturnsEveryPull()
        {
            _http.Reply(200, Ticket10);
            var t = await _api.UseTicketAsync("gacha_ticket_10", "standard");
            Last("POST", "/v1/items/tickets/gacha_ticket_10/use", "{\"bannerId\":\"standard\"}", "key1");
            Assert.Equal(3, t.Results.Count);
            Assert.Equal(t.Result.HorseId, t.Results[0].HorseId);
            Assert.Equal(10, t.PityPoints);
            var single = await Via(() => _api.UseTicketAsync("gacha_ticket", "standard"), "{\"itemId\":\"gacha_ticket\",\"bannerId\":\"standard\",\"result\":{\"templateId\":\"t_a\",\"rarity\":\"R\"},\"pityPoints\":1,\"remaining\":0}");
            Assert.Single(single.Results);
        }

        // ------------------------------------------------------------------ monetization (§13)

        [Fact]
        public async Task ProductsCarryServerBuiltDisplayFields()
        {
            _http.Reply(200, Products);
            var l = await _api.GetProductsAsync();
            var coin = l.Products.Single(p => p.Id == "coin_160");
            Assert.Equal("コイン100", coin.Name);
            Assert.Equal("coins", coin.Tab);
            Assert.Equal("consumable", coin.StoreType);
            Assert.Equal("有償コイン100枚", coin.Contents[0].Label);
            Assert.Equal(100, coin.FirstPurchaseBonus.Coins);
            Assert.Equal("free", coin.FirstPurchaseBonus.Currency);
            Assert.Null(coin.Period);
            Assert.Contains("legal.tokushoho", coin.NoticeKeys);
            var al = l.Products.Single(p => p.Id == "stable_allowance_30d");
            Assert.Equal("daily_free_coins", al.Contents[1].Type);
            Assert.Equal(900, al.Contents[1].Total);
            Assert.Equal(30, al.Allowance.DailyFreeCoins);
            Assert.Equal("days", al.Period.Kind);
            Assert.Equal(30, al.Period.Days);
            var plus = l.Products.Single(p => p.Id == "season_pass_plus");
            Assert.Equal(10, plus.PassLevels);
            Assert.Equal("pass_premium", plus.Contents[0].Type);
            Assert.Equal(30, plus.Contents[0].Levels);
            Assert.Equal(50, plus.Contents[0].Reward.FreeCoins);
            Assert.Equal("season", plus.Period.Kind);
            Assert.False(plus.AutoRenew);
            var promo = l.Products.Single(p => p.Id == "promo_pack_B");
            Assert.True(promo.OneTime);
            Assert.Equal("class", promo.OneTimeScope);
            Assert.Equal("B", promo.ClassId);
            Assert.Equal("有償コインから先に使われます", l.Notices["shop.paid_first"]);
            Assert.Equal("legal.tokushoho", l.LegalLinks[0].Key);
        }

        [Fact]
        public async Task PurchaseIntentForCoinsPassAndAllowance()
        {
            _http.Reply(200, IntentCoin).Reply(200, IntentPass).Reply(200, IntentAllowance);
            var c = await _api.PurchaseIntentAsync("coin_160");
            Assert.Equal(100, c.FirstPurchaseBonus.Coins);
            Assert.Null(c.Pass);
            var p = await _api.PurchaseIntentAsync("season_pass_plus");
            Last("POST", "/v1/shop/purchase-intent", "{\"productId\":\"season_pass_plus\"}");
            Assert.Equal("2026-11", p.Pass.SeasonId);
            Assert.Equal(6, p.Pass.RemainingDays);
            Assert.True(p.Pass.LastWeek);
            Assert.Equal(10, p.Pass.Levels);
            Assert.Null(p.FirstPurchaseBonus);
            var a = await _api.PurchaseIntentAsync("stable_allowance_30d");
            Assert.Equal(30, a.Allowance.Days);
            Assert.False(a.Allowance.AutoRenew);

            _http.Reply(409, E("DELETION_PENDING"));
            var e = await Assert.ThrowsAsync<PurchaseBlockedException>(() => _api.PurchaseIntentAsync("stable_allowance_30d"));
            Assert.Equal(ApiErrorCode.DeletionPending, e.Code);
        }

        [Fact]
        public async Task OffersAndOfferView()
        {
            _http.Reply(200, Offers);
            var o = await _api.GetShopOffersAsync();
            Last("GET", "/v1/shop/offers");
            var starter = o.Offers[0];
            Assert.Equal("T2", starter.Touchpoint);
            Assert.Equal("popup", starter.Placement);
            Assert.Equal("first_4th_or_worse", starter.Reason);
            Assert.True(starter.ShowPopup);
            Assert.Null(starter.EndsAt);
            var pass = o.Offers.Single(x => x.Id == "season_pass_2026_11");
            Assert.Equal(1796050800000L, pass.EndsAt);
            Assert.Equal(6, pass.RemainingDays);
            Assert.False(o.Offers.Single(x => x.Id == "season_pass_2026_11_plus").ShowPopup);
            Assert.Equal("shop", o.Offers.Last().Touchpoint);
            Assert.True(o.FirstPurchase.Available);
            Assert.Contains("coin_160", o.FirstPurchase.ProductIds);
            Assert.False(o.Allowance.Active);

            _http.Requests.Clear();
            _http.Fail(new IOException("reset")).Reply(200, Viewed);
            var v = await _api.MarkOfferViewedAsync("starter_pack");
            Last("POST", "/v1/shop/offers/starter_pack/view");
            Assert.Equal(2, _http.Requests.Count); // first time kept: retried
            Assert.Equal(1795575600000L, v.ViewedAt);

            _http.Reply(409, E("DELETION_PENDING"));
            var e = await Assert.ThrowsAsync<PurchaseBlockedException>(() => _api.GetShopOffersAsync());
            Assert.Equal(ApiErrorCode.DeletionPending, e.Code);
        }

        [Fact]
        public async Task AllowanceViewAndKeyedClaim()
        {
            _http.Reply(200, Allowance);
            var a = await _api.GetAllowanceAsync();
            Last("GET", "/v1/shop/allowance");
            Assert.True(a.CanClaim);
            Assert.Equal("2026-11-25", a.StartDate);
            Assert.Equal("2026-12-24", a.EndDate);
            Assert.Equal(30, a.DaysLeft);

            _http.Requests.Clear();
            _http.Reply(500, E("INTERNAL")).Reply(200, AllowanceClaim);
            var c = await _api.ClaimAllowanceAsync();
            Last("POST", "/v1/shop/allowance/claim", null, "key1");
            Assert.All(_http.Requests, r => Assert.Equal("key1", r.Headers["idempotency-key"]));
            Assert.Equal(30, c.FreeCoins);
            Assert.True(c.Allowance.ClaimedToday);
            Assert.Equal(1, c.Allowance.ClaimedDays);
            Assert.Equal(195, c.Wallet.Free);

            _http.Reply(409, E("ALREADY_CLAIMED"));
            Assert.Equal(ApiErrorCode.AlreadyClaimed, (await Assert.ThrowsAsync<ConflictException>(() => _api.ClaimAllowanceAsync())).Code);
            _http.Reply(409, E("DELETION_PENDING"));
            Assert.Equal(ApiErrorCode.DeletionPending, (await Assert.ThrowsAsync<PurchaseBlockedException>(() => _api.ClaimAllowanceAsync())).Code);

            var queued = await Via(() => _api.GetAllowanceAsync(), "{\"active\":false,\"claimedToday\":false,\"queued\":{\"startDate\":\"2026-12-25\",\"endDate\":\"2027-01-23\"}}");
            Assert.False(queued.CanClaim);
            Assert.Equal("2026-12-25", queued.Queued.StartDate);
        }

        [Fact]
        public async Task SeasonPassScreenFields()
        {
            _http.Reply(200, SeasonPass);
            var p = await _api.GetSeasonPassAsync();
            Assert.Equal("2026-11", p.SeasonId);
            Assert.Equal(11, p.Level);
            Assert.Equal(100, p.XpPerLevel);
            Assert.Equal(30, p.MaxLevel);
            Assert.Equal(80, p.XpToNextLevel);
            Assert.Equal(4, p.RacesToNextLevel);
            Assert.True(p.Active);
            Assert.Equal(1796050800000L, p.SeasonEndsAt);
            Assert.Equal(6, p.RemainingDays);
            Assert.True(p.LastWeek);
            Assert.False(p.AutoRenew);
            Assert.True(p.AutoGrantAtSeasonEnd);
            Assert.Equal(10, p.BoostLevels);
            Assert.Equal(new[] { "season_pass_plus" }, p.Owned.ToArray());
            Assert.Empty(p.Purchasable);
            Assert.Equal(10, p.FreeLine.Reward.FreeCoins);
            Assert.Equal(1, p.PremiumLine.Every);
            Assert.Equal("breeding_material", p.PremiumLine.Reward.Items[0].ItemId);
            Assert.Null(p.LastSeason);

            var last = (await Via(() => _api.GetSeasonPassAsync(), "{\"lastSeason\":{\"seasonId\":\"2026-10\",\"xp\":3000,\"level\":30,\"premium\":true,\"boostXp\":0,\"granted\":{\"free\":[1,2],\"premium\":[1]},\"autoGranted\":{\"free\":[29,30],\"premium\":[29,30]},\"autoFreeCoins\":120,\"at\":1793467800000}}")).LastSeason;
            Assert.Equal(new[] { 29, 30 }, last.AutoGrantedPremium);
            Assert.Equal(120, last.AutoFreeCoins);
        }
    }
}
