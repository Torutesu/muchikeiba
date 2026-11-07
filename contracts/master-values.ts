// Runtime-only master values, shared by server and browser. No I/O or validation dependency.
import type {
  BannerDef,
  HorseTemplate,
  PoolEntry,
  Rarity,
  RawBanner,
} from '../server/src/domain/master.js';
import { AppError } from '../server/src/domain/errors.js';
export const RARITY_ORDER: Rarity[] = ['R', 'SR', 'SSR'];
export const STAT_KEYS: ('speed' | 'stamina' | 'burst' | 'guts' | 'temper')[] =
  ['speed', 'stamina', 'burst', 'guts', 'temper'];
export const PPM_TOTAL = 1_000_000;
/** Splits `total` ppm across ids evenly; remainder goes to the first ids (deterministic). */
function split(ids: string[], total: number): PoolEntry[] {
  if (ids.length === 0) return [];
  const base = Math.floor(total / ids.length);
  let rem = total - base * ids.length;
  return ids.map((templateId) => ({
    templateId,
    ppm: base + (rem-- > 0 ? 1 : 0),
  }));
}

export function expandPool(
  templates: HorseTemplate[],
  rates: Partial<Record<Rarity, number>>,
  pickup?: { templateId: string; ppm: number },
): PoolEntry[] {
  const out: PoolEntry[] = [];
  for (const r of RARITY_ORDER) {
    const total = rates[r] ?? 0;
    if (total === 0) continue;
    const ids = templates.filter((t) => t.rarity === r).map((t) => t.id);
    if (ids.length === 0)
      throw new AppError('CONFIG_INVALID', `no templates of rarity ${r}`);
    if (pickup && ids.includes(pickup.templateId)) {
      out.push({ templateId: pickup.templateId, ppm: pickup.ppm });
      out.push(
        ...split(
          ids.filter((id) => id !== pickup.templateId),
          total - pickup.ppm,
        ),
      );
    } else out.push(...split(ids, total));
  }
  return out;
}

export function buildBanner(
  raw: RawBanner,
  templates: HorseTemplate[],
): BannerDef {
  const pool =
    raw.pool === 'auto'
      ? expandPool(templates, raw.rates ?? {}, raw.pickup)
      : raw.pool;
  const guaranteePool =
    raw.guaranteePool ??
    expandPool(
      templates,
      raw.guaranteeRates ?? {},
      raw.pickup && {
        templateId: raw.pickup.templateId,
        ppm: Math.round(
          (raw.pickup.ppm * (raw.guaranteeRates?.SSR ?? 0)) /
            Math.max(1, raw.rates?.SSR ?? 1),
        ),
      },
    );
  const b: BannerDef = {
    id: raw.id,
    name: raw.name,
    currency: raw.currency,
    priceSingle: raw.priceSingle,
    priceTen: raw.priceTen,
    pityGroup: raw.pityGroup,
    pityTargets: raw.pityTargets,
    pool,
    guaranteePool,
  };
  if (raw.startAtMs !== undefined) b.startAtMs = raw.startAtMs;
  if (raw.endAtMs !== undefined) b.endAtMs = raw.endAtMs;
  return b;
}
