/**
 * REQ-SHORT-010 / REQ-GACHA-008 / REQ-ACH-008 (コンプガチャ防止): the ONE list of horse templates a player can get from a
 * paid random draw. Every comp-gacha check (collect missions of every kind, 図鑑・実績 sets) reads this function, so a new
 * random source added here is checked everywhere at once — and a source missing here is missing everywhere (one place to fix).
 *
 * Sources (all can be paid with paid coins, directly or through a product that contains them):
 * - every banner's normal table, its slot-10 guarantee table and its step-up final-slot tables;
 * - the banners' pity-exchange targets (exchanged for points that only paid pulls give);
 * - every random ticket: `single` / `ten` draw from the banners above; `srPlus` (the starter pack's SR以上確定券) draws from its
 *   own table — every non-gift template of its rarities, not a banner pool (QA R11).
 */
import { expandPool, type BannerDef, type HorseTemplate, type TicketDef } from './master.js';

export interface PaidRandomSource {
  gacha: { banners: BannerDef[] };
  items?: { tickets?: Record<string, TicketDef> };
  /** the srPlus ticket tables are built from these (required: a missing list would silently hide a source) */
  templates: HorseTemplate[];
}

export function paidRandomTemplates(m: PaidRandomSource): Set<string> {
  const out = new Set<string>();
  for (const b of m.gacha.banners) {
    for (const e of b.pool) out.add(e.templateId);
    for (const e of b.guaranteePool ?? []) out.add(e.templateId);
    for (const st of b.stepUp?.steps ?? []) for (const e of st.finalSlotPool ?? []) out.add(e.templateId);
    for (const t of b.pityTargets ?? []) out.add(t);
  }
  for (const t of Object.values(m.items?.tickets ?? {})) {
    // single / ten tickets draw from banners (covered above); srPlus has its own table
    if (t.kind === 'srPlus') for (const e of expandPool(m.templates, t.rates)) out.add(e.templateId);
  }
  return out;
}
