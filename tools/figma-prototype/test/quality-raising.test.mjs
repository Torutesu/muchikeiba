// Node check of the quality-pass raising & breeding paths used by index.html (docs/quality/raising-breeding.md, contracts/protocol.md
// Q1), on the real server code bundled into site/js/logic.js: 馬カード after days of training (layers, stage, leaning, career,
// read-only), the per-menu training outlook equal to the start preview, the breeding preview's exact rarity odds, a breeding and
// the foal's generation / skill origin, and nothing granted by any of it.
// usage: node tools/figma-prototype/test/quality-raising.test.mjs
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert';

const here = dirname(fileURLToPath(import.meta.url));
const store = {};
Object.defineProperties(store, {
  getItem: { value: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null) },
  setItem: { value: (k, v) => { store[k] = String(v); } },
  removeItem: { value: (k) => { delete store[k]; } },
});
globalThis.localStorage = store;
createRequire(import.meta.url)(join(here, '..', 'site', 'js', 'logic.js'));
const L = globalThis.MuchiLogic;
const KEYS = ['speed', 'stamina', 'burst', 'guts', 'temper'];

// 1) 馬カード after 12 days of training and a race a day
await L.seedRaising(12);
let v = await L.view();
const pid = v.flags.partnerHorseId;
const snap = (x) => JSON.stringify({ horses: x.horses, wallet: x.wallet, items: x.items, materials: x.materials });
const before = snap(await L.view());
const p = (await L.horseProfile(pid)).value;
assert.strictEqual(snap(await L.view()), before, 'the horse card writes nothing');
const h = v.horses.find((x) => x.id === pid);
for (const s of p.stats) {
  assert.strictEqual(s.base + s.awakening + s.trained, s.race, `${s.key}: layers add up`);
  assert.strictEqual(s.trained, h.trained?.[s.key] ?? 0, `${s.key}: the training layer is the horse's growth`);
}
assert.ok(p.growth.trainedTotal > 30, `the partner grew over 12 days (${p.growth.trainedTotal})`);
assert.ok(p.growth.stage >= 1, 'a stage past 新馬');
assert.ok(p.leaning && KEYS.includes(p.leaning.stat), 'a leaning stat');
assert.ok(p.career.races >= 12, 'the career counts the races settled with the horse');
assert.strictEqual(p.totals.ranked <= p.totals.cap, true, 'ranked never above the class cap');
assert.strictEqual(p.lineage.generation, 1, 'a scouted partner is generation 1');

// 2) the training outlook is exactly what start previews
L.setDayOffset(7 + 12); // the next game day: fresh slots
const tv = (await L.training()).value;
const other = tv.horses.find((x) => !x.blocked);
assert.ok(other, 'a horse that can still train today');
const hill = other.menus.find((m) => m.id === 'hill');
assert.ok(hill.outlook && hill.outlook.max >= hill.outlook.min, 'the hill outlook');
const st = await L.trainingStart(other.horseId, 'hill');
assert.ok(st.ok, st.message);
assert.deepStrictEqual([st.value.preview.min, st.value.preview.max], [hill.outlook.min, hill.outlook.max], 'outlook = start preview');
await L.trainingFinish(st.value.session.sessionId, [], true);

// 3) breeding: the preview's rarity odds, a breeding, the foal's lineage
await L.seedBreeding();
v = await L.view();
const wallet = { ...v.wallet };
const sire = v.horses.find((x) => x.status === 'retired' && x.sex === 'male');
const dam = v.horses.find((x) => x.status === 'retired' && x.sex === 'female');
assert.ok(sire && dam, 'a retired pair');
const pv = (await L.breedingPreview(sire.id, dam.id)).value;
assert.strictEqual(pv.rarity.R + pv.rarity.SR + pv.rarity.SSR, 1_000_000, 'the rarity odds add up to one million');
const b = await L.breed(sire.id, dam.id);
assert.ok(b.ok, b.message);
const foal = b.value.foal;
for (const k of KEYS) assert.ok(foal.base[k] >= pv.stats[k].min && foal.base[k] <= pv.stats[k].max, `${k}: the foal lands in the previewed range`);
if (pv.rarity[foal.rarity] === 0) assert.fail(`the foal's rarity ${foal.rarity} had a 0 chance in the preview`);
const fp = (await L.horseProfile(foal.id)).value;
assert.strictEqual(fp.lineage.generation, 2, 'the foal is generation 2');
assert.strictEqual(fp.lineage.bred, true);
if (foal.skillId) assert.ok(['sire', 'dam'].includes(fp.lineage.skillFrom), 'the skill came from a parent');
const after = (await L.view()).wallet;
assert.deepStrictEqual([after.free, after.paid], [wallet.free, wallet.paid], 'breeding and the card grant no coins');
// English for the new screens' game-layer lines
const en = (t) => L.l10n?.translate ? L.l10n.translate(t) : null;
if (en('第2世代') !== null) assert.strictEqual(en('第2世代'), 'Generation 2');
console.log(`quality raising OK — stage ${p.growth.stage} (${p.growth.trainedTotal}/${p.growth.potential}), leaning ${p.leaning.stat}, foal ${foal.rarity} gen ${fp.lineage.generation}, SR+ ${(pv.rarity.SR + pv.rarity.SSR) / 1e4}%`);
