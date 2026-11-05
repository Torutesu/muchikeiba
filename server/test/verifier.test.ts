import { describe, expect, it } from 'vitest';
import { HttpVerifierClient } from '../src/domain/verifier.js';
import { RaceRoomCore } from '../src/domain/raceRoom.js';
import { seededRng } from '../src/domain/rng.js';
import { makeConfig } from './helpers.js';

const log = () => new RaceRoomCore(makeConfig(1), 0, { verifySampleRate: 0, resultWaitMs: 1, rng: seededRng(1) }).replayLog();

describe('HttpVerifierClient', () => {
  it('posts the replay log to /verify and validates the answer', async () => {
    let seen: { url: string; body: unknown } | null = null;
    const fetcher = (async (url: string, init: RequestInit) => {
      seen = { url, body: JSON.parse(String(init.body)) };
      return new Response(JSON.stringify({ resultHash: 'a'.repeat(64), order: [0], finishTicks: [10], checksums: { '20': '0123456789abcdef' } }));
    }) as unknown as typeof fetch;
    const out = await new HttpVerifierClient('https://v.example/', fetcher).verify(log());
    expect(seen!.url).toBe('https://v.example/verify');
    expect(out.order).toEqual([0]);
  });
  it('sends the shared bearer token only when configured', async () => {
    const auths: (string | null)[] = [];
    const fetcher = (async (_url: string, init: RequestInit) => {
      auths.push(new Headers(init.headers).get('authorization'));
      return new Response(JSON.stringify({ resultHash: 'a'.repeat(64), order: [0], finishTicks: [10], checksums: {} }));
    }) as unknown as typeof fetch;
    await new HttpVerifierClient('https://v', fetcher, 1000, 's3cret-token').verify(log());
    await new HttpVerifierClient('https://v', fetcher).verify(log());
    expect(auths).toEqual(['Bearer s3cret-token', null]);
  });
  it('rejects malformed verifier output and HTTP errors', async () => {
    const bad = (async () => new Response(JSON.stringify({ resultHash: 'zz', order: [], finishTicks: [1], checksums: {} }))) as unknown as typeof fetch;
    await expect(new HttpVerifierClient('https://v', bad).verify(log())).rejects.toThrow();
    const err = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch;
    await expect(new HttpVerifierClient('https://v', err).verify(log())).rejects.toThrow(/500/);
  });
});
