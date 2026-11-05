/**
 * Glicko-2 (Glickman 2012) with a multi-player race decomposed into pairwise games between
 * HUMANS only (REQ-RATE-001). CPU results never affect ratings.
 */
export interface Rating { r: number; rd: number; vol: number }
const SCALE = 173.7178;
const TAU = 0.5;
const EPS = 0.000001;

function g(phi: number) { return 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI)); }
function E(mu: number, muj: number, phij: number) { return 1 / (1 + Math.exp(-g(phij) * (mu - muj))); }

export interface Game { opponent: Rating; score: 0 | 0.5 | 1 }

export function updateRating(p: Rating, games: Game[]): Rating {
  const mu = (p.r - 1500) / SCALE;
  const phi = p.rd / SCALE;
  if (games.length === 0) {
    const phiStar = Math.sqrt(phi * phi + p.vol * p.vol);
    return { r: p.r, rd: Math.min(350, phiStar * SCALE), vol: p.vol };
  }
  let vInv = 0;
  let deltaSum = 0;
  for (const gm of games) {
    const muj = (gm.opponent.r - 1500) / SCALE;
    const phij = gm.opponent.rd / SCALE;
    const e = E(mu, muj, phij);
    vInv += g(phij) ** 2 * e * (1 - e);
    deltaSum += g(phij) * (gm.score - e);
  }
  const v = 1 / vInv;
  const delta = v * deltaSum;
  const a = Math.log(p.vol * p.vol);
  const f = (x: number) => (Math.exp(x) * (delta * delta - phi * phi - v - Math.exp(x))) / (2 * (phi * phi + v + Math.exp(x)) ** 2) - (x - a) / (TAU * TAU);
  let A = a;
  let B: number;
  if (delta * delta > phi * phi + v) B = Math.log(delta * delta - phi * phi - v);
  else {
    let k = 1;
    while (f(a - k * TAU) < 0) k++;
    B = a - k * TAU;
  }
  let fA = f(A);
  let fB = f(B);
  for (let i = 0; i < 100 && Math.abs(B - A) > EPS; i++) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) { A = B; fA = fB; } else { fA = fA / 2; }
    B = C;
    fB = fC;
  }
  const vol = Math.exp(A / 2);
  const phiStar = Math.sqrt(phi * phi + vol * vol);
  const phiNew = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const muNew = mu + phiNew * phiNew * deltaSum;
  return { r: muNew * SCALE + 1500, rd: Math.max(30, Math.min(350, phiNew * SCALE)), vol };
}

/**
 * `order` = finishing order of HUMAN player ids (CPU removed, earlier = better).
 * Every human pair is a game; each player is updated once with all their games.
 */
export function updateRace(ratings: Map<string, Rating>, order: string[]): Map<string, Rating> {
  const out = new Map<string, Rating>();
  for (let i = 0; i < order.length; i++) {
    const me = order[i]!;
    const games: Game[] = [];
    for (let j = 0; j < order.length; j++) {
      if (i === j) continue;
      games.push({ opponent: ratings.get(order[j]!)!, score: i < j ? 1 : 0 });
    }
    out.set(me, updateRating(ratings.get(me)!, games));
  }
  return out;
}
