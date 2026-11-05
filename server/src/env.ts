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
  /** Overrides master progression.replayRetentionDays. */
  REPLAY_RETENTION_DAYS?: string;
}
