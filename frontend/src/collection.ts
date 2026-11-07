/** The browser preview reuses server calculations; production authority remains the API. */
import templatesJSON from "../../server/master/horses.json";
import gachaJSON from "../../server/master/gacha.json";
import progression from "../../server/master/progression.json";
import nicks from "../../server/master/nicks.json";
import ng from "../../server/master/ng-names.json";
import { buildBanner, STAT_KEYS } from "../../contracts/master-values";
import {
  createHorseFromTemplate,
  effectiveStats,
  awaken,
  retire,
  breed,
  breedingPreview,
  pedigree,
  nameHorse,
  validateName,
} from "../../server/src/domain/horses";
import {
  drawGacha,
  drawTicket,
  oddsDisclosure,
  exchangePity,
} from "../../server/src/domain/gacha";
import { newPlayer } from "../../server/src/domain/player";
import { cryptoRng } from "../../server/src/domain/rng";
import { readClub, freeBalance, replaceDemoWallet } from "./club-state.js";
import type { Master, RawBanner } from "../../server/src/domain/master";
import type { PlayerState } from "../../server/src/domain/player";

const KEY = "muchi-collection-v1";
const templates = templatesJSON.templates;
export const collectionMaster = {
  templates,
  templateById: new Map(templates.map((t) => [t.id, t])),
  gacha: {
    ...gachaJSON,
    banners: gachaJSON.banners.map((b) =>
      buildBanner(b as RawBanner, templates as any),
    ),
  },
  progression,
  nicks,
  ng,
} as unknown as Master;
export const styleLabel = {
  nige: "逃げ",
  senko: "先行",
  sashi: "差し",
  oikomi: "追込",
};
export const surfaceLabel = { turf: "芝", dirt: "ダート", both: "芝・ダート" };
export function collection() {
  let s: PlayerState;
  try {
    s = JSON.parse(localStorage.getItem(KEY) || "null");
  } catch {
    s = null as any;
  }
  if (!s || !Array.isArray(s.horses) || !s.counters) {
    s = newPlayer("browser-preview", Date.now(), "preview");
    try {
      if (JSON.parse(localStorage.getItem("muchi-detail-v1") || "{}").scouted)
        s.flags.tutorialGachaUsed = true;
    } catch {}
    ["t_akatsuki", "t_kohaku", "t_tsukikage"].forEach((id, i) => {
      const h = createHorseFromTemplate(
        s,
        collectionMaster.templateById.get(id)!,
        Date.now(),
      );
      h.name = ["アカツキ", "コハク", "シラナミ"][i]!;
    });
  }
  const name = localStorage.getItem("muchi-horse");
  if (name) s.horses[0]!.name = name;
  return s;
}
function commit(s: PlayerState) {
  localStorage.setItem(KEY, JSON.stringify(s));
}
export function roster() {
  const s = collection();
  return s.horses.map((h, index) => {
    const stats = effectiveStats(collectionMaster, h);
    const values = [stats.speed, stats.burst, stats.stamina, stats.temper].map(
      (n) => Math.round(n / 10),
    );
    return [
      h.name,
      h.rarity,
      styleLabel[h.style],
      `${surfaceLabel[h.surface]} / ${h.distMinM.toLocaleString()}–${h.distMaxM.toLocaleString()}m`,
      String(Math.round(STAT_KEYS.reduce((n, k) => n + stats[k], 0) / 50)),
      { ...h, index, viewStats: values, stats, model: index % 3 },
    ];
  });
}
export function isActive(index: number) {
  return collection().horses[index]?.status === "active";
}
export function validateHorseName(raw: string) {
  return validateName(collectionMaster, raw);
}
export function renameOwned(id: string, raw: string) {
  const s = collection();
  nameHorse(collectionMaster, s, id, raw);
  commit(s);
  if (s.horses[0]?.id === id)
    localStorage.setItem("muchi-horse", s.horses[0].name);
  return s.horses.find((h) => h.id === id)!;
}
export function retireOwned(id: string) {
  const s = collection();
  if (s.horses.filter((h) => h.status === "active").length <= 1)
    throw Object.assign(new Error("最後の現役馬は残してください"), {
      code: "LAST_ACTIVE",
    });
  retire(s, id);
  commit(s);
}
export function awakenOwned(id: string) {
  const s = collection();
  awaken(collectionMaster, s, id);
  commit(s);
}
export function horsePedigree(id: string) {
  return pedigree(collection(), id, 5);
}
function walletInto(s: PlayerState) {
  const c = readClub();
  s.wallet.free = freeBalance();
  s.wallet.paid = c.paid;
  s.wallet.lots = c.paid
    ? [
        {
          lotId: "preview",
          txId: "preview",
          granted: c.paid,
          remaining: c.paid,
          unitPriceMicroYen: 0,
          at: Date.now(),
        },
      ]
    : [];
  s.items = { ...c.items };
}
function walletOut(s: PlayerState) {
  replaceDemoWallet(s.wallet.paid, s.wallet.free, s.items);
}
export function scout(options: {
  banner?: string;
  count?: 1 | 10;
  ticket?: string;
  tutorial?: boolean;
  key: string;
}) {
  const s = collection();
  if ((s as any).operations?.[options.key])
    return (s as any).operations[options.key];
  walletInto(s);
  const banner = options.banner || "standard",
    count = options.count || 1;
  let result: any;
  if (options.ticket) {
    result = drawTicket(
      collectionMaster,
      s,
      options.ticket,
      cryptoRng,
      Date.now(),
    );
  } else
    result = drawGacha(
      collectionMaster,
      s,
      banner,
      count,
      cryptoRng,
      Date.now(),
      { tutorialFree: options.tutorial },
    );
  const order = {
    ...result,
    id: options.key,
    at: Date.now(),
    banner,
    count: result.results.length,
  };
  (s as any).operations = { ...(s as any).operations, [options.key]: order };
  (s as any).lastScout = order;
  commit(s);
  walletOut(s);
  return order;
}
export function lastScout() {
  return (collection() as any).lastScout;
}
export function odds(banner = "standard") {
  return oddsDisclosure(
    collectionMaster,
    collectionMaster.gacha.banners.find((b) => b.id === banner)!,
  );
}
export function pityExchange(templateId: string) {
  const s = collection();
  walletInto(s);
  const result = exchangePity(
    collectionMaster,
    s,
    "standard",
    templateId,
    Date.now(),
  );
  commit(s);
  walletOut(s);
  return result;
}
export function previewPair(sire: string, dam: string) {
  return breedingPreview(collectionMaster, collection(), sire, dam);
}
export function breedPair(sire: string, dam: string, key: string) {
  const s = collection();
  if ((s as any).operations?.[key]) return (s as any).operations[key];
  const result = breed(collectionMaster, s, sire, dam, cryptoRng, Date.now());
  (s as any).operations = { ...(s as any).operations, [key]: result };
  (s as any).lastFoal = result.foal.id;
  commit(s);
  return result;
}
