import { verifierOutputSchema, type ReplayLog, type VerifierOutput } from './schemas.js';

/** Re-simulation service (C# Muchi.Verifier, contracts/protocol.md §8). */
export interface VerifierClient {
  verify(log: ReplayLog): Promise<VerifierOutput>;
}

export class HttpVerifierClient implements VerifierClient {
  constructor(private readonly baseUrl: string, private readonly fetcher: typeof fetch = (i, init) => fetch(i, init), private readonly timeoutMs = 10_000) {}
  async verify(log: ReplayLog): Promise<VerifierOutput> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetcher(`${this.baseUrl.replace(/\/$/, '')}/verify`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(log), signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`verifier HTTP ${res.status}: ${await res.text()}`);
      return verifierOutputSchema.parse(await res.json());
    } finally {
      clearTimeout(t);
    }
  }
}
