// Economy report (docs/spec/balance-targets.md E-*): `npm run economy [days]`
import { loadMaster } from '../src/domain/master.js';
import { PERSONAS, simulateAll } from '../src/sim/economy.js';

const days = Number(process.argv[2] ?? 90);
const res = await simulateAll(loadMaster(), days);
console.log('| persona | 稼働日 | 円 | 遊びで得た無償コイン/日 | 引いた回数/月 | SSR/月 | 天井到達(日目) | 天井交換 | 配合素材 | ガチャ券 |');
console.log('|---|---|---|---|---|---|---|---|---|---|');
for (const p of PERSONAS) {
  const r = res[p.id]!;
  console.log(`| ${p.label} | ${r.activeDays.toFixed(0)} | ${r.yenSpent.toFixed(0)} | ${r.freeCoinsPerActiveDay.toFixed(0)} | ${r.pullsPerMonth.toFixed(1)} | ${r.ssrPerMonth.toFixed(2)} | ${r.firstPityDay?.toFixed(0) ?? '-'} | ${r.pityExchanges.toFixed(1)} | ${r.breedingMaterial.toFixed(0)} | ${r.gachaTickets.toFixed(0)} |`);
}
