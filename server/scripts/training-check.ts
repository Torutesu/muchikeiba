// 調教 end to end against a running server (scripts/integration.sh, REQ-TRAIN-*, contracts/protocol.md §22):
//   tsx scripts/training-check.ts <base>
// A new player with the partner horse: GET /v1/training → start 坂路 → taps sent at once are refused (422: the server's
// clock says no time has passed) → after the mini-game's duration the same taps are re-scored on the server (great) →
// the horse carries the growth in GET /v1/player → the daily mission train1 is complete → the retry of the finish with the
// same key answers the same → the third session on the same horse is refused (2 per horse per game day).
export {};
const [base] = process.argv.slice(2);
if (!base) { console.error('usage: training-check.ts <base>'); process.exit(2); }

const user = `train_it_${Date.now().toString(36)}`;
const h = { 'x-dev-user': user, 'content-type': 'application/json' };
const fail = (m: string): never => { console.error('TRAINING CHECK FAILED: ' + m); process.exit(1); throw new Error(m); };
const post = (path: string, body: unknown, key?: string) => fetch(`${base}${path}`, { method: 'POST', headers: { ...h, ...(key ? { 'idempotency-key': key } : {}) }, body: JSON.stringify(body) });
const get = async <T>(path: string) => (await (await fetch(`${base}${path}`, { headers: h })).json()) as T;

await post('/v1/player/bootstrap', {});
const partner = await post('/v1/player/partner', { name: 'アイボウ' }, 'p1');
if (partner.status !== 200) fail('partner grant: ' + partner.status + ' ' + await partner.text());
type Horse = { horseId: string; trainedTotal: number };
const v = await get<{ enabled: boolean; slotsLeft: number; horses: Horse[]; rules: Record<string, boolean> }>('/v1/training');
if (!v.enabled || v.slotsLeft !== 3 || v.horses.length !== 1) fail('view: ' + JSON.stringify(v));
if (v.rules.fatigueAffectsRaces !== false || v.rules.rankedNormalized !== true || v.rules.paidBoosts !== false) fail('rules: ' + JSON.stringify(v.rules));
const hid = v.horses[0]!.horseId;
const st = await post('/v1/training/start', { horseId: hid, menuId: 'hill' }, 's1');
if (st.status !== 200) fail('start: ' + st.status + ' ' + await st.text());
const s = (await st.json()) as { session: { sessionId: string; beats: number[]; durationMs: number } };
const fast = await post(`/v1/training/${s.session.sessionId}/finish`, { taps: s.session.beats }, 'f0');
const fastBody = (await fast.json()) as { error?: { code: string } };
if (fast.status !== 422 || fastBody.error?.code !== 'TRAINING_INPUT_INVALID') fail('instant taps must be 422 TRAINING_INPUT_INVALID, got ' + fast.status + ' ' + JSON.stringify(fastBody));
await new Promise((r) => setTimeout(r, s.session.durationMs + 300));
const fin = await post(`/v1/training/${s.session.sessionId}/finish`, { taps: s.session.beats.map((b) => b + 15) }, 'f1');
if (fin.status !== 200) fail('finish: ' + fin.status + ' ' + await fin.text());
const r = (await fin.json()) as { grade: string; total: number; timing: { perfect: number }; trainedTotal: number };
if (r.grade !== 'great' || r.timing.perfect !== 5 || r.total <= 0) fail('result: ' + JSON.stringify(r));
const again = (await (await post(`/v1/training/${s.session.sessionId}/finish`, { taps: [] }, 'f1')).json()) as { total: number };
if (again.total !== r.total) fail('a retried finish must answer the same');
const pl = await get<{ horses: { id: string; trained?: Record<string, number> }[] }>('/v1/player');
const trained = pl.horses.find((x) => x.id === hid)?.trained ?? {};
if (Object.values(trained).reduce((a, n) => a + n, 0) !== r.trainedTotal) fail('the player view carries the growth: ' + JSON.stringify(trained));
const ms = await get<{ missions: { id: string; progress: number; target: number }[] }>('/v1/missions');
const train1 = ms.missions.find((x) => x.id === 'train1');
if (!train1 || train1.progress < train1.target) fail('daily mission train1: ' + JSON.stringify(train1));
const s2 = (await (await post('/v1/training/start', { horseId: hid, menuId: 'pool' }, 's2')).json()) as { session: { sessionId: string } };
await post(`/v1/training/${s2.session.sessionId}/finish`, { taps: [], skipped: true }, 'f2');
const third = await post('/v1/training/start', { horseId: hid, menuId: 'wood' }, 's3');
const thirdBody = (await third.json()) as { error?: { code: string } };
if (third.status !== 409 || thirdBody.error?.code !== 'TRAINING_LIMIT') fail('3rd session on one horse: ' + third.status + ' ' + JSON.stringify(thirdBody));
console.log(JSON.stringify({ ok: true, user, grade: r.grade, total: r.total, trainedTotal: r.trainedTotal, instant: fast.status, third: thirdBody.error?.code }));
