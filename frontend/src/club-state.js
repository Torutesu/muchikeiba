// Browser-only club ledger. No payment, server inventory or competitive ranking is written.
const KEY = "muchi-club-v1";
const object = v => v && typeof v === "object" && !Array.isArray(v) ? v : {};
const amount = v => Number.isSafeInteger(v) && v >= 0 ? v : 0;
export function readClub() {
  let raw; try { raw = object(JSON.parse(localStorage.getItem(KEY))); } catch { raw = {}; }
  return { items: Object.fromEntries(Object.entries(object(raw.items)).filter(([k,v]) => /^[a-z_]+$/.test(k) && amount(v) > 0)),
    receipts: object(raw.receipts), outfits: object(raw.outfits), purchases: object(raw.purchases),
    paid: amount(raw.paid), xp: Math.min(3000, amount(raw.xp)), completed: amount(raw.completed),
    freeLevels: Array.isArray(raw.freeLevels) ? raw.freeLevels.filter(x => Number.isInteger(x) && x >= 1 && x <= 30) : [],
    premiumLevels: Array.isArray(raw.premiumLevels) ? raw.premiumLevels.filter(x => Number.isInteger(x) && x >= 1 && x <= 30) : [],
    passUntil: amount(raw.passUntil), eventPoints: object(raw.eventPoints), eventClaims: object(raw.eventClaims),
    pendingEvent: typeof raw.pendingEvent === "string" ? raw.pendingEvent : null,
    race: raw.race && typeof raw.race.id === "string" ? raw.race : null };
}
const write = s => localStorage.setItem(KEY, JSON.stringify(s));
export function freeBalance() {
  const v = localStorage.getItem("muchi-coins");
  return v === null ? 1200 : amount(Number(v));
}
function apply(s, reward) {
  for (const item of reward.items || []) s.items[item.itemId] = amount(s.items[item.itemId]) + item.qty;
  if (reward.freeCoins) localStorage.setItem("muchi-coins", freeBalance() + reward.freeCoins);
}
export function grantReward(id, reward, { coins = true } = {}) {
  const s = readClub();
  if (s.receipts[id]) return false;
  apply(s, coins ? reward : { items: reward.items }); s.receipts[id] = true; write(s); return true;
}
export const outfits = {
  default: { label: "クラブの勝負服", art: null, color: null },
  costume_login: { label: "翼", art: "/campaign/art/silks-wings.svg", color: "#335e78", trim: "#f7f6f0" },
  costume_starter: { label: "稲妻", art: "/campaign/art/silks-lightning.svg", color: "#173f36", trim: "#e2c88e" },
  costume_season_limited: { label: "炎", art: "/campaign/art/silks-flame.svg", color: "#753b38", trim: "#e2c88e" },
};
export function equipped(index) {
  const s = readClub(), id = s.outfits[index];
  return outfits[id] && s.items[id] > 0 ? id : "default";
}
export function equip(index, id) {
  const s = readClub();
  if (!Number.isInteger(index) || index < 0 || index > 2 || !outfits[id] || (id !== "default" && !s.items[id])) return false;
  s.outfits[index] = id; write(s); return true;
}
export function simulateProduct(p) {
  const s = readClub();
  if (p.once && s.purchases[p.id]) return false;
  const bonus = p.kind === "coins" && !s.purchases[p.id] ? p.paidCoins : 0;
  apply(s, { items: p.items, freeCoins: bonus });
  s.paid += p.paidCoins; s.purchases[p.id] = amount(s.purchases[p.id]) + 1;
  if (p.kind === "season_pass") s.passUntil = Math.max(Date.now(), s.passUntil) + p.durationDays * 86400000;
  write(s); return true;
}
export function selectEvent(id) { const s = readClub(); s.pendingEvent = id; write(s); }
export function beginRace(event = null) {
  const s = readClub();
  if (event && (Date.now() < event.startAtMs || Date.now() >= event.endAtMs || freeBalance() < event.fee.freeCoins)) return false;
  if (event) localStorage.setItem("muchi-coins", freeBalance() - event.fee.freeCoins);
  s.race = { id: crypto.randomUUID(), event: event?.id || null, status: "running", started: Date.now() };
  s.pendingEvent = null; write(s); return true;
}
export function ensureRace() { const s = readClub(); if (!s.race || s.race.status !== "running") beginRace(); }
export function finishRace() { const s = readClub(); if (s.race?.status === "running") { s.race.status = "finished"; write(s); } }
export function settleRace(progression, events) {
  const s = readClub();
  if (s.race?.status !== "finished" || s.receipts["race:" + s.race.id]) return false;
  s.receipts["race:" + s.race.id] = true; s.race.status = "settled";
  s.xp = Math.min(progression.passXpPerLevel * progression.passMaxLevel, s.xp + progression.passXpPerRace); s.completed++;
  const event = events.find(e => e.id === s.race.event);
  if (event && s.race.started >= event.startAtMs && s.race.started < event.endAtMs) s.eventPoints[event.id] = amount(s.eventPoints[event.id]) + event.points.byPlace[0] + event.points.participation;
  write(s); return true;
}
export function claimPass(kind, progression) {
  const s = readClub(), premium = kind === "premium";
  if (!["free", "premium"].includes(kind) || (premium && s.passUntil <= Date.now())) return 0;
  const levels = premium ? s.premiumLevels : s.freeLevels, max = Math.min(progression.passMaxLevel, Math.floor(s.xp / progression.passXpPerLevel));
  let count = 0;
  for (let level = 1; level <= max; level++) if (!levels.includes(level)) { apply(s, progression.passRewards[kind].reward); levels.push(level); count++; }
  write(s); return count;
}
export function claimEvent(event, index) {
  const s = readClub(), m = event.milestones[index], id = `${event.id}:${index}`;
  if (!m || Date.now() < event.startAtMs || Date.now() >= event.endAtMs || amount(s.eventPoints[event.id]) < m.points || s.eventClaims[id]) return false;
  apply(s, m.reward); s.eventClaims[id] = true; write(s); return true;
}
