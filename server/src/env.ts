/** Worker bindings (wrangler.toml). */
export interface Env {
  RACE_ROOM: DurableObjectNamespace;
  PLAYER: DurableObjectNamespace;
  MATCHMAKER: DurableObjectNamespace;
  ACCOUNTING: DurableObjectNamespace;
  REPLAYS: R2Bucket;
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
}
