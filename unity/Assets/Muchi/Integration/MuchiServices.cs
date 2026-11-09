using System;
using Muchi.Client;
using Muchi.Game;
using UnityEngine;

namespace Muchi.Unity
{
    /// <summary>
    /// Composition root for the Unity app: settings, API client, backend, analytics and the data files the
    /// engine packages ship in Resources. Screens (MuchiApp) only talk to <see cref="Backend"/>.
    ///
    /// Settings: Assets/Resources/Muchi/server-config.json, overridable per device with PlayerPrefs
    /// "muchi.server.baseUrl" / "muchi.server.offline" (= "1"). Auth: "local" uses x-dev-user (server must run with
    /// DEV_MODE=1, i.e. `npm run dev`); staging/production need <see cref="FirebaseTokens"/> set before
    /// <see cref="Create"/> (Firebase SDK not integrated yet — without it the app runs offline).
    /// </summary>
    public static class MuchiServices
    {
        public const string ConfigResource = "Muchi/server-config";
        public const string RulesetResource = "Muchi/ruleset-params.default";     // engine/Muchi.Client/Resources
        public const string CommentaryResource = "Muchi/commentary-ja";            // engine/Muchi.Client/Resources
        public const string CommentaryEnResource = "Muchi/commentary-en";          // REQ-L10N-012
        public const string CommentaryPacksResource = "Muchi/commentary-packs";    // REQ-CMT-001: 実況パック (copy of server/master)
        public const string UiEnResource = "Muchi/ui-en";                          // REQ-L10N-010: client-built texts
        public const string ServerEnResource = "Muchi/server-en";                  // REQ-L10N-011: names in race configs, cached server texts
        /// <summary>The language preference the settings screen toggles (same key as Runtime/LocaleService).</summary>
        public const string LanguagePref = "muchi.language";
        public const string PartnerCatalogResource = "Models/Partners/catalog";    // Codex's art catalog

        /// <summary>Firebase ID token source for staging/production (set by the Firebase integration).</summary>
        public static IAuthTokenProvider FirebaseTokens;

        public static GameBackend Backend { get; private set; }
        public static AnalyticsClient Analytics { get; private set; }
        public static CommentaryTemplates Commentary { get; private set; }
        /// <summary>REQ-CMT-*: the commentary packs the device can speak (null when the resource is missing).</summary>
        public static CommentaryPackCatalog CommentaryPacks { get; private set; }

        /// <summary>
        /// REQ-CMT-002/009: the templates a race (or a spectated race / replay) speaks — the viewer's equipped pack over the
        /// current language's standard commentary; the standard when the pack is unknown here. The tutorial speaks the
        /// standard anyway.
        /// </summary>
        public static CommentaryTemplates RaceCommentary()
            => CommentaryPackModel.TemplatesFor(Commentary, CommentaryPacks, CommentaryPackModel.EquippedOf(Backend, Store));
        public static PartnerCatalog Partners { get; private set; }
        public static readonly PlayerPrefsStore Store = new PlayerPrefsStore();

        public static long NowMs => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        public static GameBackend Create()
        {
            if (Backend != null) return Backend;
            var settings = LoadSettings();
            // REQ-L10N-009..012: English tables, the saved language, commentary in that language
            foreach (var r in new[] { ServerEnResource, UiEnResource }) if (LoadText(r) is string t) Loc.LoadEnglish(t);
            Loc.SetLocale(Store.Get(LanguagePref));
            Commentary = LoadText(Loc.IsEnglish ? CommentaryEnResource : CommentaryResource) is string c ? CommentaryTemplates.Parse(c) : null;
            CommentaryPacks = LoadText(CommentaryPacksResource) is string cp ? CommentaryPackCatalog.Parse(cp) : null;
            Partners = LoadText(PartnerCatalogResource) is string p ? PartnerCatalog.Parse(p) : null;
            string rulesetJson = LoadText(RulesetResource) ?? throw new InvalidOperationException("Resources/" + RulesetResource + ".json missing (com.muchi.client package not imported?)");
            var ruleset = RaceFactory.ParseRuleset(rulesetJson);

            ApiClient api = null;
            if (!settings.OfflineOnly)
            {
                var options = new ApiClientOptions { BaseUrl = settings.BaseUrl, Locale = Loc.Current };
                IAuthTokenProvider auth = null;
                if (settings.UsesDevAuth) options.DevUserId = DevUserId(settings);
                else auth = FirebaseTokens;
                if (auth != null || !string.IsNullOrEmpty(options.DevUserId))
                    api = new ApiClient(new UnityHttp(settings.BaseUrl, settings.RequestTimeoutMs), auth, options);
                else
                    settings.OfflineOnly = true; // no way to authenticate yet
            }
            Backend = new GameBackend(settings, api, new WebSocketTransportFactory(), Store, ruleset);
            if (api != null)
                Analytics = new AnalyticsClient(api, new AnalyticsOptions { Platform = Application.platform == RuntimePlatform.Android ? "android" : "ios", AppVersion = Application.version }, Store, NowMs);
            return Backend;
        }

        /// <summary>
        /// REQ-L10N-009: switch the language at runtime (settings toggle): texts the client builds, server texts on the
        /// next request (Accept-Language), commentary from the next race, push language on the next device registration.
        /// </summary>
        public static void SetLanguage(string locale)
        {
            Loc.SetLocale(locale);
            Store.Set(LanguagePref, Loc.Current);
            if (Backend?.Api != null) Backend.Api.Locale = Loc.Current;
            Commentary = LoadText(Loc.IsEnglish ? CommentaryEnResource : CommentaryResource) is string c ? CommentaryTemplates.Parse(c) : Commentary;
        }

        public static GameSettings LoadSettings()
        {
            var s = GameSettings.Parse(LoadText(ConfigResource));
            string url = Store.Get("muchi.server.baseUrl");
            if (!string.IsNullOrEmpty(url)) s.BaseUrl = url;
            if (Store.Get("muchi.server.offline") == "1") s.OfflineOnly = true;
            return s;
        }

        private static string DevUserId(GameSettings s)
        {
            if (!string.IsNullOrEmpty(s.DevUserId)) return s.DevUserId;
            string id = Store.Get("muchi.dev.user");
            if (string.IsNullOrEmpty(id)) { id = "unity_" + Guid.NewGuid().ToString("N").Substring(0, 12); Store.Set("muchi.dev.user", id); }
            return id;
        }

        private static string LoadText(string resource)
        {
            var t = Resources.Load<TextAsset>(resource);
            return t == null ? null : t.text;
        }

        /// <summary>Call every frame (flushes analytics on its own schedule).</summary>
        public static void Tick()
        {
            try { Analytics?.Update(NowMs); } catch (Exception e) { Debug.LogWarning("analytics: " + e.Message); }
        }

        public static void Track(AnalyticsEvent e)
        {
            try { Analytics?.Track(e); } catch (Exception ex) { Debug.LogWarning("analytics: " + ex.Message); }
        }
    }
}
