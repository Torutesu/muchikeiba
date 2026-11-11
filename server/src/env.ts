/** Worker bindings (wrangler.toml). */
export interface Env {
  RACE_ROOM: DurableObjectNamespace;
  PLAYER: DurableObjectNamespace;
  MATCHMAKER: DurableObjectNamespace;
  ACCOUNTING: DurableObjectNamespace;
  /** One per season: `lb:<seasonId>` (REQ-LB-*). */
  LEADERBOARD: DurableObjectNamespace;
  /** Friend codes + public profiles, sharded `dir:<n>` (REQ-SOCIAL-*). */
  DIRECTORY: DurableObjectNamespace;
  /** One per 支部, named by team id (REQ-TEAM-*). */
  TEAMS: DurableObjectNamespace;
  /** Singleton `global`: team search (REQ-TEAM-009). */
  TEAM_DIRECTORY: DurableObjectNamespace;
  /** One per event race, `ev:<eventId>`: standings, board snapshots, end-of-event rewards (REQ-EVENT-*). */
  EVENTS: DurableObjectNamespace;
  /** Singleton `global`: remote config versions, admin audit log, admin rate limits (REQ-OPS-*). */
  OPS?: DurableObjectNamespace;
  /** Singleton `global`: anti-cheat flags, moderation (quarantine/ban), race reports queue (REQ-OPS-03x). */
  INTEGRITY?: DurableObjectNamespace;
  /** Secret: JSON `[{"name":"alice","role":"admin","sha256":"<hex sha-256 of the token>"}]` (REQ-OPS-010). */
  ADMIN_TOKENS?: string;
  /** Optional Cloudflare Access for the admin API: team domain (`<team>.cloudflareaccess.com`), app AUD tag, and `{"email":"role"}`. */
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ACCESS_ROLES?: string;
  /** REQ-OPS-015: comma-separated origins of the ops console (tools/ops-console) allowed by CORS on /v1/admin/*. Not a secret. */
  ADMIN_CONSOLE_ORIGINS?: string;
  REPLAYS: R2Bucket;
  /** Public, CDN-cacheable JSON (leaderboard snapshots). */
  SNAPSHOTS: R2Bucket;
  VERIFIER_URL: string;
  /** Secret: shared bearer token for the C# verifier (= its VERIFIER_AUTH_SECRET). Unset only in local dev. */
  VERIFIER_TOKEN?: string;
  /** "local" | "staging" | "production" (wrangler.toml). DEV_MODE is refused unless this is "local". */
  ENVIRONMENT?: string;
  FIREBASE_PROJECT_ID: string;
  /**
   * REQ-TRF-011 (§54.7): secret — the Firebase project's service-account JSON key that signs custom tokens for 引き継ぎコード.
   * Unset => transfer codes report enabled: false (Apple / Google linking only). Rotation: docs/ops/deploy.md §8.
   */
  FIREBASE_AUTH_SERVICE_ACCOUNT_JSON?: string;
  TICKET_SECRET: string;
  ADMIN_TOKEN?: string;
  /** "1" enables the fake store and the x-dev-user header. Never set in production. */
  DEV_MODE?: string;
  VERIFY_SAMPLE_RATE?: string;
  /** REQ-DLV-002: public CDN base for asset files (R2 custom domain), no trailing slash. Not a secret; never stored in remote config. */
  ASSET_CDN_BASE?: string;
  /** REQ-SPEC-005: max spectators per race room (default 200). */
  SPECTATOR_LIMIT?: string;
  /** One per tournament `tour:<id>` plus the index `index` (REQ-TOUR-*). */
  TOURNAMENTS?: DurableObjectNamespace;
  /** REQ-CUP-*: one per hosted cup `cup:<cupId>` plus the join-code index shards `cupcode:<c>`. */
  CUPS?: DurableObjectNamespace;
  // ---- stores (server/README.md「ストア連携」). Unset => that store rejects every receipt.
  /** iOS bundle id. Enables Apple verification + App Store Server Notifications V2. */
  APPLE_BUNDLE_ID?: string;
  /** "0" rejects Sandbox/Xcode transactions. Default accepts them (App Review uses Sandbox) with priceYen 0. */
  APPLE_ACCEPT_SANDBOX?: string;
  /** Android package name. */
  GOOGLE_PACKAGE_NAME?: string;
  /** Secret: service-account JSON key with Play Console access to orders. */
  GOOGLE_SERVICE_ACCOUNT_JSON?: string;
  /** "0" rejects license-testing purchases. */
  GOOGLE_ACCEPT_TEST?: string;
  /** RTDN Pub/Sub push: audience set on the push subscription, and the service account it authenticates as. */
  GOOGLE_PUBSUB_AUDIENCE?: string;
  GOOGLE_PUBSUB_SERVICE_ACCOUNT?: string;
  /** Overrides master progression.replayRetentionDays. */
  REPLAY_RETENTION_DAYS?: string;
  // ---- push notifications (REQ-PUSH-*). Unset => messages are queued and dropped, nothing is sent.
  /** Firebase project id for FCM HTTP v1 (defaults to the service account's project_id). */
  FCM_PROJECT_ID?: string;
  /** Secret: service-account JSON with the Firebase Cloud Messaging API (falls back to GOOGLE_SERVICE_ACCOUNT_JSON). */
  FCM_SERVICE_ACCOUNT_JSON?: string;
  // ---- KPI analytics (REQ-KPI-*). Both required, otherwise no analytics are written.
  /** Workers Analytics Engine dataset (wrangler.toml [[analytics_engine_datasets]]). */
  ANALYTICS?: AnalyticsEngineDataset;
  /** Secret: salt for hashing player ids before they reach analytics (no PII). */
  KPI_SALT?: string;
  // ---- rewarded ads (REQ-AD-*, contracts/protocol.md §21). Unset => the SSV callback is NOT_FOUND and no ad reward is ever granted.
  /** URL of the ad network's public SSV key set (AdMob: its published verifier-keys JSON). Not a secret. */
  ADS_SSV_KEYS_URL?: string;
  /** Pinned key set instead of the URL: JSON `[{"keyId":"123","pem":"-----BEGIN PUBLIC KEY-----…"}]` (local dev / integration). */
  ADS_SSV_KEYS?: string;
  /** JSON `{"REWARDED_HOME":"<ad unit id>",…}`: callbacks from other ad units are rejected. Unset => the unit is not checked. */
  ADS_AD_UNITS?: string;
}
