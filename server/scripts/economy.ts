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

// REQ-RIVAL-014 (E16): the weekly rival's fixed free coins over 90 days, against the 「3戦する」 cut (18 → 16 × 90 = 180; 16 → 15 went to the team goal, balance-targets 4.18)
console.log('');
console.log('| persona | ライバル 精算した週 | 勝った週 | 受け取った無償コイン（90日） |');
console.log('|---|---|---|---|');
for (const p of PERSONAS) { const r = res[p.id]!; console.log(`| ${p.label} | ${r.rivalWeeks.toFixed(1)} | ${r.rivalWins.toFixed(1)} | ${r.rivalCoins.toFixed(0)} |`); }
console.log(`\nE16 ライバル（無課金・毎日）の90日の受け取り ${res.f2p!.rivalCoins.toFixed(0)} ≤ 180`);

// REQ-EXCH-* (E17): the same 90 days with the event that has an exchange played (3 of the day's races) and its exchange spent
const evRes = await simulateAll(loadMaster(), days, [1, 2, 3], hh * 60 + (mm ?? 0), { events: true });
console.log('');
console.log('| persona | 引いた回数/月（イベントなし→あり） | SSR/月（なし→あり） | イベントのレース | イベントポイント | 交換：無償コイン | 券 | 馬 | 配合素材 | 飾り | 残りポイント→素材 |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|');
for (const p of PERSONAS) {
  const a = res[p.id]!, b = evRes[p.id]!;
  console.log(`| ${p.label} | ${a.pullsPerMonth.toFixed(1)}→${b.pullsPerMonth.toFixed(1)} | ${a.ssrPerMonth.toFixed(2)}→${b.ssrPerMonth.toFixed(2)} | ${b.eventRaces.toFixed(1)} | ${b.eventPoints.toFixed(0)} | ${b.exchangeCoins.toFixed(0)} | ${b.exchangeTickets.toFixed(2)} | ${b.exchangeHorses.toFixed(2)} | ${b.exchangeMaterial.toFixed(2)} | ${b.exchangeCosmetics.toFixed(2)} | ${b.leftoverMaterial.toFixed(2)} |`);
}
const fe = evRes.f2p!.pullsPerMonth;
console.log(`\nE17 イベントあり: E1 ${fe.toFixed(1)}  E2 ${evRes.f2p!.ssrPerMonth.toFixed(2)}  E4 ${evRes.f2p_casual!.pullsPerMonth.toFixed(1)}  E5 ${(evRes.light!.pullsPerMonth / fe).toFixed(2)}  E6 ${(evRes.medium!.pullsPerMonth / fe).toFixed(2)}`);

// REQ-WCH-* (E18): weekly challenges — every persona clears all 3 each week (upper bound); fixed, small, the same for everyone
console.log('');
console.log('| persona | 週替わりチャレンジ（初クリア） | 無償コイン | 無償コイン/日 | 配合素材 | バッジ | 無償コインの稼ぎに占める割合 |');
console.log('|---|---|---|---|---|---|---|');
for (const p of PERSONAS) {
  const r = res[p.id]!;
  console.log(`| ${p.label} | ${r.challengeClears.toFixed(1)} | ${r.challengeCoins.toFixed(0)} | ${(r.challengeCoins / Math.max(1, r.activeDays)).toFixed(2)} | ${r.challengeMaterial.toFixed(1)} | ${r.challengeBadges.toFixed(1)} | ${((100 * r.challengeCoins) / Math.max(1, r.freeCoinsEarned)).toFixed(2)}% |`);
}
console.log(`\nE18 E1 無課金 ${res.f2p!.pullsPerMonth.toFixed(1)}（40〜65）・E2 ${res.f2p!.ssrPerMonth.toFixed(2)}（1.2〜2.8）・招待された ${res.f2p_invited!.pullsPerMonth.toFixed(1)}/${res.f2p_invited!.ssrPerMonth.toFixed(2)}・招待上限 SSR ${res.f2p_inviter!.ssrPerMonth.toFixed(2)}・週4日 ${res.f2p_casual!.pullsPerMonth.toFixed(1)}`);

// REQ-TGOAL-* (E19): every persona joins a team on its beginner day; upper bound = the team reaches the top milestone every week
console.log('');
console.log('| persona | 共同目標の報酬（週） | 無償コイン（90日） | 配合素材（90日） | 引いた回数/月 | SSR/月 |');
console.log('|---|---|---|---|---|---|');
for (const p of PERSONAS) {
  const r = res[p.id]!;
  console.log(`| ${p.label} | ${r.teamGoalWeeks.toFixed(1)} | ${r.teamGoalCoins.toFixed(0)} | ${r.teamGoalMaterial.toFixed(1)} | ${r.pullsPerMonth.toFixed(1)} | ${r.ssrPerMonth.toFixed(2)} |`);
}
console.log(`\nE19 共同目標（最上段を毎週）を含めて E1 ${res.f2p!.pullsPerMonth.toFixed(1)}（40〜65）・E2 ${res.f2p!.ssrPerMonth.toFixed(2)}（1.2〜2.8）・招待上限 SSR/月 ${res.f2p_inviter!.ssrPerMonth.toFixed(2)}（≤2.8）`);

// REQ-CAREER-* (E20): 騎手の道 — every persona clears the whole career with every star (upper bound); once ever, the same for everyone
console.log('');
console.log('| persona | 騎手の道（初クリア） | 星 | 無償コイン | 配合素材 | りんごのおやつ | 引いた回数/月 | SSR/月 |');
console.log('|---|---|---|---|---|---|---|---|');
for (const p of PERSONAS) {
  const r = res[p.id]!;
  console.log(`| ${p.label} | ${r.careerClears.toFixed(1)} | ${r.careerStars.toFixed(1)} | ${r.careerCoins.toFixed(0)} | ${r.careerMaterial.toFixed(1)} | ${r.careerApples.toFixed(1)} | ${r.pullsPerMonth.toFixed(1)} | ${r.ssrPerMonth.toFixed(2)} |`);
}
console.log(`\nE20 騎手の道（全レース・全部の星）を含めて E1 ${res.f2p!.pullsPerMonth.toFixed(1)}（40〜65）・E2 ${res.f2p!.ssrPerMonth.toFixed(2)}（1.2〜2.8）・招待された ${res.f2p_invited!.pullsPerMonth.toFixed(1)}/${res.f2p_invited!.ssrPerMonth.toFixed(2)}・招待上限 SSR/月 ${res.f2p_inviter!.ssrPerMonth.toFixed(2)}（≤2.8）`);
