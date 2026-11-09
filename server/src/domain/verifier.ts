import { verifierOutputSchema, type ReplayLog, type VerifierOutput } from './schemas.js';

/** Re-simulation service (C# Muchi.Verifier, contracts/protocol.md §8). */
export interface VerifierClient {
  verify(log: ReplayLog): Promise<VerifierOutput>;
}

/** The request header that asks the verifier for `skillsFired` (REQ-ACH-002); engine/Muchi.Verifier VerifyService.SkillsHeader. */
export const VERIFY_SKILLS_HEADER = 'x-muchi-verify-skills';

export class HttpVerifierClient implements VerifierClient {
  /**
   * `authToken` is the shared secret the verifier checks (`Authorization: Bearer <VERIFIER_AUTH_SECRET>`);
   * the Worker gets it as the `VERIFIER_TOKEN` secret. Omitted only for local development.
   */
  constructor(private readonly baseUrl: string, private readonly fetcher: typeof fetch = (i, init) => fetch(i, init), private readonly timeoutMs = 10_000, private readonly authToken?: string) {}
  async verify(log: ReplayLog): Promise<VerifierOutput> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (this.authToken) headers.authorization = `Bearer ${this.authToken}`;
      // R11 skillsFired is opt-in (docs/ops/deploy.md §7.1): a verifier sends it only to a server that asks, so a new
      // verifier can always be deployed before the server (the old server's strict schema never sees the key)
      headers[VERIFY_SKILLS_HEADER] = '1';
      const res = await this.fetcher(`${this.baseUrl.replace(/\/$/, '')}/verify`, {
        method: 'POST', headers, body: JSON.stringify(log), signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`verifier HTTP ${res.status}: ${await res.text()}`);
      return verifierOutputSchema.parse(await res.json());
    } finally {
      clearTimeout(t);
    }
  }
}
