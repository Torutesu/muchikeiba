// Node check of the round 23 pedigree paths used by index.html (REQ-PED-*, contracts/protocol.md §71), on the real server
// code bundled into site/js/logic.js: the partner's tree (template parents → 記録なし, a founder), the demo family bred by the
// real breedWith (a brother × sister pair: the shared ancestors equal the breeding's inbreeding count, the hints come from
// the preview), another trainer's stallion (「他のトレーナーの馬」, no owner id anywhere), the bloodline list (every line,
// no reward, no completion), English through the prototype's catalog, and the KPI rows on the server's client-event schema.
// usage: node tools/figma-prototype/test/round23-pedigree.test.mjs
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
const JP = /[぀-ヿ㐀-鿿]/;
const nodes = (n, out = []) => { if (!n) return out; out.push(n); nodes(n.sire, out); nodes(n.dam, out); return out; };

await L.bootstrap();
await L.grantPartner?.('ミドリノカゼ');
const me = await L.view();
const partner = me.horses.find((h) => h.status === 'active') ?? me.horses[0];
if (partner) {
  const t = (await L.pedigree.view(partner.id)).value;
  assert.strictEqual(t.v, 2);
  assert.strictEqual(t.relation, 'self');
  if (partner.templateId) assert.ok(nodes(t).filter((n) => n.gen > 0).every((n) => n.rec === null && n.recordText === '記録なし'), 'template parents are names only (記録なし)');
}
// the demo family (once): brother × sister and a foal by another trainer's stallion
const d = (await L.pedigree.demo()).value;
const again = (await L.pedigree.demo()).value;
assert.deepStrictEqual(again, d, 'the demo family is made once');
const pair = (await L.pedigree.pair(d.sireId, d.damId)).value;
assert.ok(pair.inbreeding.count > 0, 'brother × sister share ancestors');
assert.strictEqual(pair.sharedKeys.length, pair.inbreeding.count, 'shared ancestors = the inbreeding count of the breeding');
const pv = (await L.breedingPreview(d.sireId, d.damId)).value;
assert.strictEqual(pv.inbreedingCount, pair.inbreeding.count, 'the preview counts the same ancestors');
for (const h of pair.hints.filter((x) => x.kind === 'style')) assert.ok(Object.values(pv.styles).map((p) => p * 10).includes(h.permille), 'style chances are the preview\'s');
assert.ok(pair.hints.some((h) => h.kind === 'inbreeding' && h.value === pair.inbreeding.count));
assert.ok(nodes(pair.sire).some((n) => n.shared) && nodes(pair.dam).some((n) => n.shared), 'both trees highlight the shared ancestors');
const stud = (await L.pedigree.view(d.studFoalId)).value;
assert.deepStrictEqual(stud.sire.lent, { ownerName: null, label: '他のトレーナーの馬' }, 'another trainer\'s stallion: no name');
assert.strictEqual(stud.sire.rec.source, 'snapshot', 'the stallion from the birth snapshot');
assert.ok(!JSON.stringify(stud).includes('demo_ped_owner'), 'no owner id in the tree');
assert.ok(stud.sharedKeys.every((k) => !k.includes('demo_ped_owner')));
// bloodlines: every line in master order, counts, nick partners, no reward / completion
const lines = (await L.pedigree.bloodlines()).value;
assert.strictEqual(lines.lines.length, 7);
assert.ok(lines.lines.find((l) => l.id === 'akatsuki').count >= 3);
assert.ok(lines.lines.some((l) => l.count === 0), 'empty lines are listed too');
assert.ok(!/reward|complete|freeCoins|達成|コンプ/.test(JSON.stringify(lines).replace('系統の数で報酬はありません。', '')), 'no reward or completion state');
// English: the pair's hints and line names come in English from their pairs; the server's other texts through the catalog
const en = (await L.pedigree.pair(d.sireId, d.damId, 'en')).value;
for (const h of en.hints) assert.ok(!/[぀-ヿ㐀-鿿]/.test(h.hintText.replace(/[ァ-ヶー・]+/g, '')), `hint in English: ${h.hintText}`);
assert.strictEqual(en.line.lineName, 'Akatsuki line');
for (const s of ['記録なし', '他のトレーナーの馬', '出走なし', '系統の数で報酬はありません。', '確率と数は配合の規則のとおりです。', '名前は非公開', '近親：共通の祖先2頭（能力の基準 −100）', '3代以内に共通の祖先はいません', '父の母の父', '共通の祖先はシアンの枠']) {
  const t = L.l10n.translate(s);
  assert.ok(t && !JP.test(t), `English for 「${s}」: ${t}`);
}
assert.ok(!/今だけ|残りわずか|お得|倍|通常価格|オッズ|賭/.test(JSON.stringify([pair, lines, stud])), 'no urgency, shop or betting wording');
// KPI rows on the server's schema (no ids)
assert.deepStrictEqual((await L.pedigree.kpi('pedigree_view', { source: 'breeding', relation: 'self', shared: 2 })).value, { name: 'pedigree_view', s1: 'breeding', s2: 'self', count: 2 });
assert.deepStrictEqual((await L.pedigree.kpi('bloodline_view', { source: 'pedigree', lines: 7 })).value, { name: 'bloodline_view', s1: 'pedigree', value: 7 });
assert.strictEqual((await L.pedigree.kpi('pedigree_view', { source: 'breeding', relation: 'self', shared: 2, horseId: 'h1' })).ok, false, 'no ids in the row');
console.log('round 23 pedigree OK');
