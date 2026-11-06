// Economy report (docs/spec/balance-targets.md E-*): `npm run economy [days] [session start HH:MM JST]`
// e.g. `npm run economy 90 03:30` plays every session across the 04:00 game-day rollover (REQ-DAY-001).
import { loadMaster } from '../src/domain/master.js';
import { PERSONAS, simulateAll } from '../src/sim/economy.js';

const days = Number(process.argv[2] ?? 90);
const [hh, mm] = (process.argv[3] ?? '12:00').split(':').map(Number) as [number, number];
const res = await simulateAll(loadMaster(), days, [1, 2, 3], hh * 60 + (mm ?? 0));
console.log('| persona | 稼働日 | 円 | 遊びで得た無償コイン/日 | 引いた回数/月 | SSR/月 | 天井到達(日目) | 天井交換 | 配合素材 | ガチャ券 | 初勝利ボーナス/日 | 厩舎手当/日 | 初心者ミッション（段・コイン） | シーズンミッションXP | 招待（コイン・券） |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const p of PERSONAS) {
  const r = res[p.id]!;
  console.log(`| ${p.label} | ${r.activeDays.toFixed(0)} | ${r.yenSpent.toFixed(0)} | ${r.freeCoinsPerActiveDay.toFixed(0)} | ${r.pullsPerMonth.toFixed(1)} | ${r.ssrPerMonth.toFixed(2)} | ${r.firstPityDay?.toFixed(0) ?? '-'} | ${r.pityExchanges.toFixed(1)} | ${r.breedingMaterial.toFixed(0)} | ${r.gachaTickets.toFixed(0)} | ${(r.firstWinCoins / Math.max(1, r.activeDays)).toFixed(1)} | ${(r.allowanceCoins / Math.max(1, r.activeDays)).toFixed(1)} | ${r.beginnerSteps.toFixed(1)}・${r.beginnerCoins.toFixed(0)} | ${r.seasonMissionXp.toFixed(0)} | ${r.inviteCoins.toFixed(0)}・${r.inviteTickets.toFixed(0)} |`);
}

// REQ-INV-*: E11 (inviter at the counted cap ÷ free daily player) and E1 for an invited player
const f = res.f2p!.pullsPerMonth;
console.log(`\nE5 ${(res.light!.pullsPerMonth / f).toFixed(2)}  E10 ${(res.allowance!.pullsPerMonth / f).toFixed(2)}  E11 招待上限 ÷ 無課金 ${(res.f2p_inviter!.pullsPerMonth / f).toFixed(2)}  E1(招待された) ${res.f2p_invited!.pullsPerMonth.toFixed(1)}`);
