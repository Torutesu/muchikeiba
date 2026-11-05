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
  REPLAYS: R2Bucket;
  /** Public, CDN-cacheable JSON (leaderboard snapshots). */
  SNAPSHOTS: R2Bucket;
  VERIFIER_URL: string;
  FIREBASE_PROJECT_ID: string;
  TICKET_SECRET: string;
  ADMIN_TOKEN?: string;
  /** "1" enables the fake store and the x-dev-user header. Never set in production. */
  DEV_MODE?: string;
  VERIFY_SAMPLE_RATE?: string;
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
}
