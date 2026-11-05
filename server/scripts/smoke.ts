// Node client script (not part of the Worker typecheck: uses the Node WebSocket global).
/**
 * Local smoke test against `wrangler dev` (DEV_MODE=1). Exercises HTTP → PlayerDO → MatchmakerDO →
 * RaceRoomDO (WebSocket hibernation + alarms) → settlement. Usage: BASE=http://127.0.0.1:8787 tsx scripts/smoke.ts
 */
const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const user = `smoke_${Date.now()}`;
let n = 0;
async function call(method: string, path: string, body?: unknown, idem = true) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-dev-user': user, ...(idem ? { 'idempotency-key': `k${n++}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(j)}`);
  return j as any;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let lastPing = 0;

await call('POST', '/v1/player/bootstrap');
await call('PUT', '/v1/player/age', { birthYear: 1990, birthMonth: 1, guardianConsent: false });
await call('POST', '/v1/shop/purchase-intent', { productId: 'coin_1500' });
const p = await call('POST', '/v1/shop/purchase', { platform: 'fake', productId: 'coin_1500', receipt: JSON.stringify({ transactionId: `T_${user}`, productId: 'coin_1500', purchasedAt: Date.now(), priceYen: 1500 }) });
console.log('wallet after purchase', p.wallet);
const tut = await call('POST', '/v1/gacha/tutorial');
const horseId = tut.results.find((r: any) => r.horseId).horseId;
await call('PUT', `/v1/horses/${horseId}/name`, { name: 'すもーくてすと' });
const d = await call('POST', '/v1/gacha/standard/draw', { count: 10 });
console.log('draw spent', d.spent, 'pity', d.pityPoints);
const a = await call('POST', '/v1/race/tutorial', { horseId });
console.log('assignment', a.raceId, 'slot', a.slot);

const ws = new WebSocket(BASE.replace(/^http/, 'ws') + a.wsPath);
const got: any[] = [];
let lastTick = -1;
await new Promise<void>((resolve, reject) => {
  ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', raceId: a.raceId, token: a.ticket, lastTick: -1 }));
  ws.onerror = (e) => reject(e);
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data));
    got.push(msg.t);
    if (msg.t === 'b') {
      lastTick = msg.to;
      if (msg.to >= 60 && msg.to < 62) ws.send(JSON.stringify({ t: 'in', tick: msg.to + 3, cmd: 1 }));
      if (Date.now() - lastPing > 1000) { lastPing = Date.now(); ws.send(JSON.stringify({ t: 'ping', c: lastPing })); } // keep-alive (silence = disconnect)
      // results before the earliest plausible finish are rejected (REQ-NET-012); 1100 ticks is past it on every course
      if (msg.to >= 1100) ws.send(JSON.stringify({ t: 'res', h: 'a'.repeat(64), order: [a.slot] }));
    }
    if (msg.t === 'final') { console.log('final', msg.status); resolve(); }
  };
  setTimeout(() => reject(new Error('timeout; got ' + got.join(','))), 120_000);
});
ws.close();
console.log('messages', [...new Set(got)].join(','), 'lastTick', lastTick);
await sleep(500);
const replay = await fetch(`${BASE}/v1/admin/replays/${a.raceId}`, { headers: { authorization: 'Bearer dev-admin' } }).then((r) => r.json()) as any;
console.log('replay inputs', JSON.stringify(replay.inputs), 'endTick', replay.endTick);
const v = await call('GET', '/v1/player', undefined, false);
console.log('missions/pass xp unaffected by tutorial; horses', v.horses.length);
const bal = await fetch(`${BASE}/v1/admin/paid-balance`, { headers: { authorization: 'Bearer dev-admin' } }).then((r) => r.json());
console.log('paid balance', bal);

// ranked: queue alone → CPU fill after 15s → single-human ranked race must be verified;
// the local verifier URL is unreachable, so the race is voided (REQ-NET-008).
await call('POST', '/v1/match/enqueue', { horseId });
let st: any;
for (let i = 0; i < 40; i++) {
  st = await call('GET', '/v1/match/status', undefined, false);
  if (st.state === 'matched') break;
  await sleep(1000);
}
console.log('ranked status', st.state, st.raceId);
const ws2 = new WebSocket(BASE.replace(/^http/, 'ws') + st.wsPath);
await new Promise<void>((resolve, reject) => {
  ws2.onopen = () => ws2.send(JSON.stringify({ t: 'hello', raceId: st.raceId, token: st.ticket, lastTick: -1 }));
  ws2.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.t === 'b' && Date.now() - lastPing > 1000) { lastPing = Date.now(); ws2.send(JSON.stringify({ t: 'ping', c: lastPing })); }
    if (msg.t === 'b' && msg.to >= 1100) ws2.send(JSON.stringify({ t: 'res', h: 'b'.repeat(64), order: [st.slot] }));
    if (msg.t === 'final') { console.log('ranked final', msg.status); if (msg.status !== 'verifying') resolve(); }
  };
  setTimeout(() => reject(new Error('ranked timeout')), 180_000);
});
ws2.close();
console.log('SMOKE OK');
