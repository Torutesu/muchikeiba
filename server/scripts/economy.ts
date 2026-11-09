// Economy report (docs/spec/balance-targets.md E-*): `npm run economy [days] [session start HH:MM JST]`
// e.g. `npm run economy 90 03:30` plays every session across the 04:00 game-day rollover (REQ-DAY-001).
import { loadMaster } from '../src/domain/master.js';
import { PERSONAS, simulateAll } from '../src/sim/economy.js';

const days = Number(process.argv[2] ?? 90);
const [hh, mm] = (process.argv[3] ?? '12:00').split(':').map(Number) as [number, number];
const res = await simulateAll(loadMaster(), days, [1, 2, 3], hh * 60 + (mm ?? 0));
console.log('| persona | 稼働日 | 円 | 遊びで得た無償コイン/日 | 引いた回数/月 | SSR/月 | 天井到達(日目) | 天井交換 | 配合素材 | ガチャ券 | 初勝利ボーナス/日 | 厩舎手当/日 | 初心者ミッション（段・コイン） | シーズンミッションXP | 招待（コイン・券） | 復帰期間 | 広告（回/日・無償コイン/日） | 実績（段・無償コイン） |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const p of PERSONAS) {
  const r = res[p.id]!;
  console.log(`| ${p.label} | ${r.activeDays.toFixed(0)} | ${r.yenSpent.toFixed(0)} | ${r.freeCoinsPerActiveDay.toFixed(0)} | ${r.pullsPerMonth.toFixed(1)} | ${r.ssrPerMonth.toFixed(2)} | ${r.firstPityDay?.toFixed(0) ?? '-'} | ${r.pityExchanges.toFixed(1)} | ${r.breedingMaterial.toFixed(0)} | ${r.gachaTickets.toFixed(0)} | ${(r.firstWinCoins / Math.max(1, r.activeDays)).toFixed(1)} | ${(r.allowanceCoins / Math.max(1, r.activeDays)).toFixed(1)} | ${r.beginnerSteps.toFixed(1)}・${r.beginnerCoins.toFixed(0)} | ${r.seasonMissionXp.toFixed(0)} | ${r.inviteCoins.toFixed(0)}・${r.inviteTickets.toFixed(0)} | ${r.comebackWindows.toFixed(1)} | ${(r.adViews / Math.max(1, r.activeDays)).toFixed(2)}・${(r.adCoins / Math.max(1, r.activeDays)).toFixed(1)} | ${r.achievementTiers.toFixed(1)}・${r.achievementCoins.toFixed(0)} |`);
}

// ratios against the free daily player: E5 (pass), E10 (daily pack), E11 (inviter at the counted cap), E13 (all rewarded ads)
const f = res.f2p!.pullsPerMonth;
console.log(`\nE5 ${(res.light!.pullsPerMonth / f).toFixed(2)}  E10 ${(res.allowance!.pullsPerMonth / f).toFixed(2)}  E11 招待上限 ÷ 無課金 ${(res.f2p_inviter!.pullsPerMonth / f).toFixed(2)}（SSR/月 ${res.f2p_inviter!.ssrPerMonth.toFixed(2)}）  E13 広告 ÷ 無課金 ${(res.ads!.pullsPerMonth / f).toFixed(2)}  E1(招待された) ${res.f2p_invited!.pullsPerMonth.toFixed(1)}`);

// REQ-CB-010 (E12): a returner's catch-up never exceeds what a daily free player earned in the days the returner missed
const lapsed = PERSONAS.find((p) => p.lapse)!;
const cb = res[lapsed.id]!;
const daily = res.f2p!;
const missed = lapsed.lapse!.days;
const dailyXpPerDay = (daily.seasonMissionXp + daily.activeDays * lapsed.racesPerDay * loadMaster().progression.passXpPerRace) / daily.activeDays;
console.log('');
console.log(`| 復帰（${missed}日休み） | 期間 | 復帰ログボ＋ミッション（コイン換算） | 毎日遊ぶ無課金が${missed}日で得た無償コイン | 追いつきパスXP | 毎日遊ぶ無課金が${missed}日で得たパスXP |`);
console.log('|---|---|---|---|---|---|');
console.log(`| ${lapsed.label} | ${cb.comebackWindows.toFixed(1)} | ${cb.comebackValue.toFixed(0)} | ${(daily.freeCoinsPerActiveDay * missed).toFixed(0)} | ${cb.comebackXp.toFixed(0)} | ${(dailyXpPerDay * missed).toFixed(0)} |`);

// REQ-TRAIN-* (E15): training growth is time-gated and the same for everyone; in ranked it can only narrow the paid/free gap
const classes = loadMaster().progression.classes;
console.log('');
console.log(`| persona | 調教（回/稼働日） | 伸び（合計/稼働日） | ${classes.map((c) => `${c.id}級（上限${c.statCap}）調教なし→あり`).join(' | ')} |`);
console.log(`|---|---|---|${classes.map(() => '---').join('|')}|`);
for (const p of PERSONAS) {
  const r = res[p.id]!;
  console.log(`| ${p.label} | ${(r.trainingSessions / Math.max(1, r.activeDays)).toFixed(2)} | ${(r.trainedPoints / Math.max(1, r.activeDays)).toFixed(2)} | ${classes.map((c) => `${r.rankedTotalByClass[c.id]!.untrained.toFixed(0)}→${r.rankedTotalByClass[c.id]!.trained.toFixed(0)}`).join(' | ')} |`);
}
const gap = (a: string, b: string, cls: string, key: 'trained' | 'untrained') => res[a]!.rankedTotalByClass[cls]![key] - res[b]!.rankedTotalByClass[cls]![key];
const perDay = (id: string) => res[id]!.trainedPoints / Math.max(1, res[id]!.activeDays);
console.log(`\nE15 中課金−無課金のランク戦能力差（正規化後、調教なし→あり）: ${classes.map((c) => `${c.id} ${gap('medium', 'f2p', c.id, 'untrained').toFixed(0)}→${gap('medium', 'f2p', c.id, 'trained').toFixed(0)}`).join('  ')}  伸び/稼働日 中課金÷無課金 ${(perDay('medium') / perDay('f2p')).toFixed(2)}`);

// REQ-BOX-013: the gift box changes routing only — what arrived is claimed on the next active day, nothing expires
console.log('');
console.log('| persona | プレゼントボックス 受け取り（件） | 期限切れ（件） |');
console.log('|---|---|---|');
for (const p of PERSONAS) { const r = res[p.id]!; console.log(`| ${p.label} | ${r.giftsClaimed.toFixed(1)} | ${r.giftsExpired.toFixed(1)} |`); }
