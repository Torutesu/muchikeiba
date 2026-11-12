// Node check of the round 8 engine and logic paths used by unity.html (docs/planning/06, REQ-UXP-001..005):
//  1) tutorial with its TutorialDirector (REQ-UXS-004): 0 whips → close 2nd, 2 whips in the last 300 m → 1st,
//     attempt 3 → assisted 1st; the rival is slot 1; RaceDebrief / RaceResultModel come back with the result
//  2) a beginner race built by the server's buildRaceConfig runs in WASM with ruleset 1.3.0 unique skills
//     (skill events reach the HUD) and returns the debrief line
//  3) shop display data has no 「倍」 wording; offers, pass screen, consent, partner grant and the deletion block
// usage: node tools/figma-prototype/test/round8.test.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const store = {};
globalThis.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
createRequire(import.meta.url)(join(here, '..', 'site', 'js', 'logic.js'));
const L = globalThis.MuchiLogic;

const { dotnet } = await import(join(here, '..', 'site', 'engine', '_framework', 'dotnet.js'));
const { getAssemblyExports, getConfig } = await dotnet.create();
const ex = (await getAssemblyExports(getConfig().mainAssemblyName)).MuchiRace;
const ruleset = readFileSync(join(root, 'contracts', 'ruleset-params.default.json'), 'utf8');
const commentary = readFileSync(join(root, 'engine', 'Muchi.Client', 'Resources', 'Muchi', 'commentary-ja.json'), 'utf8');
assert.strictEqual(ex.Init(ruleset, commentary), '1.3.0');

function ride(info, rider) {
  let t = 1000, last, prev;
  const skills = [];
  for (let i = 0; i < 40000; i++) {
    prev = last;
    rider(last, prev);
    last = JSON.parse(ex.Frame(t));
    skills.push(...(last.skillEvents ?? []));
    t += 16;
    if (last.done) break;
  }
  return { info, last, skills };
}

// ---- 1) tutorial director
const whipTimes = (n) => { let used = 0; return (f) => { if (f && f.remainingM <= 280 && f.remainingM >= 120 && used < n && f.remainingM <= 280 - used * 70) { ex.Spur(); used++; } }; };
const t0 = ride(JSON.parse(ex.StartTutorial(1)), () => {});
assert.strictEqual(t0.info.rivalSlot, 1, 'rival is slot 1');
assert.strictEqual(t0.last.result.place, 2, 'no whip → 2nd');
assert.ok(t0.last.result.tutorialRetry && t0.last.result.nextAttempt === 2);
assert.ok(t0.last.result.line.length > 0, 'debrief line on a loss');
assert.strictEqual(t0.last.order[0], 1, 'the rival won');
const t1 = ride(JSON.parse(ex.StartTutorial(1)), whipTimes(1));
assert.strictEqual(t1.last.result.place, 2, 'one whip → 2nd');
const t2 = ride(JSON.parse(ex.StartTutorial(2)), whipTimes(2));
assert.strictEqual(t2.last.result.place, 1, 'two whips in the last 300 m → 1st');
assert.strictEqual(t2.last.result.headline, '差し切った！');
assert.strictEqual(t2.last.tutorial.countedWhips, 2);
const t3 = ride(JSON.parse(ex.StartTutorial(3)), () => {});
assert.strictEqual(t3.last.result.place, 1, 'attempt 3 is assisted');
assert.ok(t3.last.tutorial.assisted);
console.log('tutorial: 0 whips', t0.last.result.place + '着', JSON.stringify(t0.last.result.line), '/ 2 whips', t2.last.result.place + '着', JSON.stringify(t2.last.result.line), '/ attempt 3 assisted', t3.last.result.place + '着');

// ---- 3a) onboarding on the real rules
assert.ok((await L.bootstrap()).ok);
assert.ok((await L.recordConsent()).ok, 'consent recorded');
assert.strictEqual((await L.view()).consent.required, false, 'consent no longer required');
const bad = await L.grantPartner('abc');
assert.ok(!bad.ok && bad.code === 'INVALID_NAME');
const g = await L.grantPartner('いっせん');
assert.ok(g.ok && g.value.horse.name === 'イッセン', 'partner granted (hiragana → katakana)');
assert.strictEqual(g.value.horse.templateId, L.partnerTemplate.id, 'the ridden horse (t_partner) is the partner');
assert.ok(!(await L.grantPartner('アカツキ')).ok, 'partner is granted once');

// ---- 2) beginner race from buildRaceConfig with unique skills
const v = await L.view();
const { config } = await L.raceConfig(g.value.horse.id, 'aoba_turf_1600');
assert.strictEqual(config.ruleset.rulesetVersion ?? JSON.parse(ruleset).rulesetVersion, L.tactics()?.modes?.ranked ? '1.4.0' : '1.3.0'); // quality pass: the prototype previews 1.4 in ranked
assert.ok(config.entrants.filter((e) => e.horse.skill).length >= 6, 'CPU horses race with their master skills');
const info = JSON.parse(ex.StartConfig(JSON.stringify(config), 'local'));
assert.strictEqual(info.distanceM, 1600);
assert.strictEqual(info.names[info.playerSlot], 'イッセン');
assert.ok(info.skills[info.playerSlot]?.name, 'partner has its unique skill');
const r = ride(info, (f) => { if (f && (!f.departed || (f.remainingM < 400 && f.whips > 0 && f.remainingM % 60 < 8))) ex.Spur(); });
assert.ok(r.last.done && r.last.result.place >= 1);
assert.ok(r.skills.length > 0, 'skill activations reach the HUD');
assert.ok(r.last.result.line && r.last.result.rows.some((x) => x.player), 'debrief + player row');
assert.ok(r.last.feel && typeof r.last.feel.level === 'string');
console.log('beginner 1600m:', r.last.result.place + '着/' + r.last.result.runners, JSON.stringify(r.last.result.line), 'skills fired:', r.skills.map((s) => s.horse + '「' + s.name + '」').join(' '));
const ap = await L.applyRace('t_race_1', r.last.result.place, 12, { trackId: 'aoba_turf_1600', style: 'sashi', finishTick: 1900, whips: 3 });
assert.ok(ap.ok);

// ---- 3b) shop / offers / pass
const shop = L.shopProducts();
const text = JSON.stringify(shop);
assert.ok(!/倍/.test(text), 'no 「倍」 wording in shop display data');
assert.ok(shop.products.some((p) => p.kind === 'starter') && shop.legalLinks.length >= 2);
const offers = await L.shopOffers();
assert.ok(offers.ok && offers.value.firstPurchase.available);
const pass = await L.passView();
assert.strictEqual(pass.maxLevel, 30);
assert.ok(pass.purchasable.includes('season_pass') && pass.purchasable.includes('season_pass_plus'));
// purchase-intent states: unregistered → registered adult → under 18 (guardian) → over the monthly limit
assert.strictEqual((await L.purchaseIntent('coin_160')).code, 'AGE_REQUIRED');
const y = new Date(L.now() + 9 * 3_600_000).getUTCFullYear(); // the JST year of the clock the age rules use (not the host's local year)
assert.ok((await L.setAge(y - 31, 1, false)).ok);
const ok = await L.purchaseIntent('coin_160');
assert.ok(ok.ok && ok.value.firstPurchaseBonus && !/倍/.test(ok.value.firstPurchaseBonus.label));
assert.ok((await L.setAge(y - 15, 1, true)).ok, 'age corrected toward younger with guardian consent');
assert.strictEqual((await L.purchaseIntent('coin_10000')).code, 'AGE_LIMIT_EXCEEDED');
// deletion pending blocks purchases and offers
const d1 = await L.requestDeletion(null);
assert.ok(d1.ok && d1.value.confirmToken);
assert.ok((await L.requestDeletion(d1.value.confirmToken)).ok);
assert.strictEqual((await L.purchaseIntent('coin_160')).code, 'DELETION_PENDING');
assert.strictEqual((await L.shopOffers()).code, 'DELETION_PENDING');
assert.ok((await L.cancelDeletion()).ok);
assert.ok((await L.shopOffers()).ok);

// ---- demo home states (REQ-UXP-002)
L.reset();
const day3 = await L.seedDemo(3, [2, 2, 2]);
assert.strictEqual(day3.unlocks.day, 3);
const unlocked = (vv, k) => vv.unlocks.features.find((f) => f.key === k).unlocked;
assert.ok(unlocked(day3, 'shop') && unlocked(day3, 'teams') && !unlocked(day3, 'time_attack'));
console.log('ROUND8 OK');
process.exit(0);
