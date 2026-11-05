import { verifierOutputSchema, type ReplayLog, type VerifierOutput } from './schemas.js';

/** Re-simulation service (C# Muchi.Verifier, contracts/protocol.md §8). */
export interface VerifierClient {
  verify(log: ReplayLog): Promise<VerifierOutput>;
}

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
