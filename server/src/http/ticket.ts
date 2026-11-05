import { AppError } from '../domain/errors.js';

/** Short-lived HMAC ticket that lets a player join one race slot over WebSocket (no JWT check in the room). */
export interface RaceTicket { raceId: string; slot: number; playerId: string; exp: number }

const enc = new TextEncoder();
const b64url = (b: ArrayBuffer | Uint8Array) => {
  const bytes = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = '';
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function key(secret: string) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function signTicket(t: RaceTicket, secret: string): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(t)));
  const sig = await crypto.subtle.sign('HMAC', await key(secret), enc.encode(body));
  return `${body}.${b64url(sig)}`;
}

export async function verifyTicket(token: string, secret: string, raceId: string, now: number): Promise<RaceTicket> {
  const [body, sig] = token.split('.');
  if (!body || !sig) throw new AppError('UNAUTHORIZED');
  const ok = await crypto.subtle.verify('HMAC', await key(secret), fromB64url(sig), enc.encode(body));
  if (!ok) throw new AppError('UNAUTHORIZED');
  const t = JSON.parse(new TextDecoder().decode(fromB64url(body))) as RaceTicket;
  if (t.raceId !== raceId || t.exp < now) throw new AppError('UNAUTHORIZED');
  return t;
}
