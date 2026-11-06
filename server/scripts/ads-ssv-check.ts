// Rewarded-ad SSV end to end against a running server (scripts/integration.sh):
//   tsx scripts/ads-ssv-check.ts keygen <dir>    writes <dir>/ssv-private.jwk, prints the ADS_SSV_KEYS value (public key)
//   tsx scripts/ads-ssv-check.ts check <base> <dir>
// The check signs AdMob-style callbacks with the private key (as the ad network would) and calls GET /v1/ads/ssv/admob:
// a signed callback reaches the player's object (rejected there: no session), a replay is answered the same way,
// a tampered or unsigned one is 401; GET /v1/ads explains why a brand-new player sees no offers (FTUE).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { signAdMobQuery } from '../src/ads/ssv.js';

const KEY_ID = '1001';
const [cmd, a1, a2] = process.argv.slice(2);

async function keygen(dir: string) {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  writeFileSync(join(dir, 'ssv-private.jwk'), JSON.stringify(await crypto.subtle.exportKey('jwk', kp.privateKey)));
  const spki = Buffer.from(await crypto.subtle.exportKey('spki', kp.publicKey)).toString('base64');
  console.log(JSON.stringify([{ keyId: KEY_ID, pem: `-----BEGIN PUBLIC KEY-----${spki}-----END PUBLIC KEY-----` }]));
}

async function check(base: string, dir: string) {
  const priv = await crypto.subtle.importKey('jwk', JSON.parse(readFileSync(join(dir, 'ssv-private.jwk'), 'utf8')), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const user = `ads_it_${Date.now().toString(36)}`;
  const h = { 'x-dev-user': user, 'content-type': 'application/json' };
  const fail = (m: string) => { console.error('ADS SSV CHECK FAILED: ' + m); process.exit(1); };
  await fetch(`${base}/v1/player/bootstrap`, { method: 'POST', headers: h, body: '{}' });
  const view = await (await fetch(`${base}/v1/ads`, { headers: h })).json() as { eligible: boolean; reason: string; placements: { rewardLabel: string }[] };
  if (view.eligible || view.reason !== 'ftue') fail('a new player must see no offers (ftue): ' + JSON.stringify(view));
  if (!view.placements.every((p) => /^(無償コイン|タイムアタック)\d+(枚|回)$/.test(p.rewardLabel))) fail('reward labels must be fixed amounts');
  const start = await fetch(`${base}/v1/ads/daily_coins/start`, { method: 'POST', headers: { ...h, 'idempotency-key': 'k1' }, body: '{}' });
  if (start.status !== 409) fail('start must be refused in the FTUE, got ' + start.status);
  const q = await signAdMobQuery({ adUnit: 'ca-app-pub-test/home', customData: 'ad_0000000000000000', timestamp: Date.now(), transactionId: `it_${user}`, userId: user, keyId: KEY_ID }, priv);
  const r1 = await fetch(`${base}/v1/ads/ssv/admob?${q}`);
  const b1 = await r1.json() as { status?: string };
  if (r1.status !== 200 || b1.status !== 'rejected') fail(`signed callback without a session: expected 200 rejected, got ${r1.status} ${JSON.stringify(b1)}`);
  const r2 = await fetch(`${base}/v1/ads/ssv/admob?${q}`);
  if (r2.status !== 200 || (await r2.json() as { status?: string }).status !== 'rejected') fail('a replayed callback must get the same answer');
  const r3 = await fetch(`${base}/v1/ads/ssv/admob?${q.replace(`user_id=${user}`, 'user_id=someone_else')}`);
  if (r3.status !== 401) fail('tampered callback must be 401, got ' + r3.status);
  const r4 = await fetch(`${base}/v1/ads/ssv/admob?${q.split('&signature=')[0]}`);
  if (r4.status !== 401) fail('unsigned callback must be 401, got ' + r4.status);
  const after = await (await fetch(`${base}/v1/player`, { headers: h })).json() as { wallet: { paid: number } };
  if (after.wallet.paid !== 0) fail('paid coins changed');
  console.log(JSON.stringify({ ok: true, user, reason: view.reason, signed: b1.status, tampered: r3.status, unsigned: r4.status }));
}

if (cmd === 'keygen' && a1) await keygen(a1);
else if (cmd === 'check' && a1 && a2) await check(a1, a2);
else { console.error('usage: ads-ssv-check.ts keygen <dir> | check <base> <dir>'); process.exit(2); }
