import { AppError } from './errors.js';
import { maxBondLevel } from './bond.js';
import { tierReached } from './collection.js';
import { effectiveSilks, type Silks } from './visuals.js';
import type { BannedSilksList } from './bannedSilks.js';
import { foldForCompare } from './horses.js';
import type { Master, Style, TitleCondition } from './master.js';
import type { PlayerState } from './player.js';
import { CMD } from './raceRoom.js';
import type { RaceStartConfig, ReplayLog } from './schemas.js';

/** What the server can tell about one human's ride from the confirmed input log (REQ-STAT-002). */
export interface RaceDetails {
  trackId: string;
  style: Style;
  /** Finish tick (absolute, tick 0 = race clock start) when known (verifier output or agreeing reports). */
  finishTick: number | null;
  /** First START at/after the gate opened, minus the gate tick. null = never pressed START. */
  startReactionTicks: number | null;
  whips: number;
  /** Two whips inside the diminishing window (spamming). */
  whipMashed: boolean;
  /** The CPU rode for this player at some point (disconnect takeover): skill stats are not credited. */
  cpuAssisted: boolean;
  /** REQ-ACH-002: the rider's unique skill fired (agreeing client reports; absent = unknown). */
  skillFired?: boolean;
  /** REQ-ASSIST-007: かんたん操作 rode this race (the rider's own `res.assist`; KPI only, never shown to others). */
  assist?: 'whip' | 'full';
}

export function raceDetailsFor(config: RaceStartConfig, log: ReplayLog, slot: number, finishTick: number | null): RaceDetails {
  const entrant = config.entrants.find((e) => e.slot === slot);
  if (!entrant) throw new AppError('NOT_FOUND', `slot ${slot}`);
  const gate = Number(config.ruleset.gateOpenTick ?? 0);
  const window = Number(config.ruleset.whipDiminishWindowTicks ?? 0);
  let startReactionTicks: number | null = null;
  let whips = 0;
  let whipMashed = false;
  let lastWhip: number | null = null;
  let cpuAssisted = false;
  for (const [tick, s, cmd] of log.inputs) {
    if (s !== slot) continue;
    if (cmd & CMD.CPU_TAKEOVER) cpuAssisted = true;
    if (startReactionTicks === null && cmd & CMD.START && tick >= gate) startReactionTicks = tick - gate;
    if (cmd & CMD.WHIP && (finishTick === null || tick <= finishTick)) {
      whips++;
      if (lastWhip !== null && tick - lastWhip < window) whipMashed = true;
      lastWhip = tick;
    }
  }
  return { trackId: config.track.id, style: entrant.horse.style, finishTick, startReactionTicks, whips, whipMashed, cpuAssisted };
}

export const isWhipPerfectWin = (place: number, d: RaceDetails) => place === 1 && !d.cpuAssisted && d.whips >= 3 && !d.whipMashed;

/** REQ-STAT-001: fold one confirmed (non-tutorial) race into the player's statistics. */
export function applyStats(s: PlayerState, place: number, d: RaceDetails) {
  const st = s.stats;
  st.races++;
  if (place === 1) st.wins++;
  if (place >= 1 && place <= 3) st.top3++;
  const bs = (st.byStyle[d.style] ??= { races: 0, wins: 0 });
  bs.races++;
  if (place === 1) bs.wins++;
  const bt = (st.byTrack[d.trackId] ??= { races: 0, wins: 0, bestFinishTick: null });
  bt.races++;
  if (place === 1) bt.wins++;
  if (d.finishTick !== null && d.finishTick >= 0 && !d.cpuAssisted && (bt.bestFinishTick === null || d.finishTick < bt.bestFinishTick)) bt.bestFinishTick = d.finishTick;
  if (isWhipPerfectWin(place, d)) st.whipPerfectWins++;
  if (d.startReactionTicks !== null && !d.cpuAssisted) {
    if (st.bestStartReactionTicks === null || d.startReactionTicks < st.bestStartReactionTicks) st.bestStartReactionTicks = d.startReactionTicks;
    if (d.startReactionTicks <= 1) st.perfectStarts++;
  }
}

function classIndex(m: Master, id: string) { return m.progression.classes.findIndex((c) => c.id === id); }

export function conditionMet(m: Master, s: PlayerState, c: TitleCondition): boolean {
  const st = s.stats;
  switch (c.kind) {
    case 'races': return st.races >= c.value;
    case 'wins': return st.wins >= c.value;
    case 'top3': return st.top3 >= c.value;
    case 'perfectStarts': return st.perfectStarts >= c.value;
    case 'whipPerfectWins': return st.whipPerfectWins >= c.value;
    case 'winsByStyle': return (st.byStyle[c.style]?.wins ?? 0) >= c.value;
    case 'startReaction': return st.bestStartReactionTicks !== null && st.bestStartReactionTicks <= c.value;
    case 'trackWins': return (st.byTrack[c.trackId]?.wins ?? 0) >= c.value;
    case 'bestTime': {
      const b = st.byTrack[c.trackId]?.bestFinishTick;
      return b !== undefined && b !== null && b <= c.value;
    }
    case 'classReached': {
      const target = classIndex(m, c.classId);
      if (target < 0) return false;
      const reached = [s.season.classId, ...s.seasonHistory.flatMap((h) => [h.classId, h.nextClassId])];
      return reached.some((id) => classIndex(m, id) >= target);
    }
    case 'rating': return s.rating.rankedRaces > 0 && s.rating.r >= c.value;
    case 'bondLevel': return maxBondLevel(m, s) >= c.value;
    case 'achievement': return tierReached(s, c.achievementId, c.tier); // REQ-ACH-006
    case 'rivalWeeksWon': return (s.rival?.weeksWon ?? 0) >= c.value; // REQ-RIVAL-007
  }
}

/** REQ-TITLE-002: unlock every title whose condition holds. Idempotent (set semantics). Returns newly unlocked ids. */
export function evaluateTitles(m: Master, s: PlayerState): string[] {
  const added: string[] = [];
  for (const t of m.titles) {
    if (s.titles.includes(t.id)) continue;
    if (conditionMet(m, s, t.condition)) {
      s.titles.push(t.id);
      added.push(t.id);
    }
  }
  return added;
}

/** REQ-TITLE-003: equip one unlocked title (null = none). */
export function equipTitle(m: Master, s: PlayerState, titleId: string | null) {
  if (titleId !== null) {
    if (!m.titles.some((t) => t.id === titleId)) throw new AppError('NOT_FOUND', `title ${titleId}`);
    if (!s.titles.includes(titleId)) throw new AppError('NOT_ELIGIBLE', 'title not unlocked');
  }
  s.profile.titleId = titleId;
  return { titleId };
}

/** REQ-SOCIAL-006: display names: 1–12 characters after NFKC, no control characters/URLs, NG list applies. */
export function validateDisplayName(m: Master, raw: string): string {
  const name = raw.normalize('NFKC').trim().replace(/\s+/g, ' ');
  const len = [...name].length;
  if (len < 1 || len > 12) throw new AppError('INVALID_NAME', '1〜12文字');
  if (/[\p{C}]/u.test(name)) throw new AppError('INVALID_NAME', 'control characters');
  if (/https?:|www\.|\.(com|net|jp)\b/i.test(name)) throw new AppError('INVALID_NAME', 'no URLs');
  const f = foldForCompare(name);
  if (m.ng.exact.some((n) => foldForCompare(n) === f)) throw new AppError('NG_NAME');
  if (m.ng.contains.some((n) => f.includes(foldForCompare(n)))) throw new AppError('NG_NAME');
  return name;
}

export function setDisplayName(m: Master, s: PlayerState, raw: string) {
  s.profile.displayName = validateDisplayName(m, raw);
  return { displayName: s.profile.displayName };
}

/** What other players may see (friend list, leaderboards). Never includes wallet/purchase data. */
export interface PublicProfile {
  playerId: string; displayName: string; titleId: string | null; classId: string; rating: number;
  stats: { races: number; wins: number; top3: number }; lastSeenAt: number;
  /** REQ-ASSET-005 (absent in profiles pushed by older builds). */
  silks?: Silks;
  /** REQ-ITEM-006: equipped tack, so other players can render it (absent = default tack). */
  tack?: Partial<Record<'bridle' | 'saddlecloth', string>>;
}

export function publicProfile(s: PlayerState, banned?: BannedSilksList): PublicProfile {
  return {
    playerId: s.id, displayName: s.profile.displayName, titleId: s.profile.titleId, silks: effectiveSilks(s.profile.silks, `p:${s.id}`, banned), classId: s.season.classId,
    rating: Math.round(s.rating.r), stats: { races: s.stats.races, wins: s.stats.wins, top3: s.stats.top3 }, lastSeenAt: s.profile.lastSeenAt,
    ...(s.equipment && Object.keys(s.equipment.tack).length > 0 ? { tack: { ...s.equipment.tack } } : {}),
  };
}
