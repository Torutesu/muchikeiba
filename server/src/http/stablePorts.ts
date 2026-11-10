/** REQ-STABLE-*: adapts per-player invocations (PlayerDO RPC or PlayerService) to the マイ厩舎 orchestration. */
import type { Master } from '../domain/master.js';
import { stableConfig, StableService, type StableDirectory, type StablePlayers } from '../domain/stable.js';
import type { PlayerInvoker } from './app.js';

export function stablePlayersFrom(player: (uid: string) => PlayerInvoker): StablePlayers {
  return {
    mine: (u) => player(u).invoke('stableMine', u),
    save: (u, input) => player(u).invoke('stableSave', u, input),
    visit: (u, t) => player(u).invoke('stableVisit', u, t),
    give: (u, t, k) => player(u).invoke('stableLikeGive', u, t, k),
    receive: (t, from, likeId) => player(t).invoke('stableLikeReceive', t, from, likeId),
    friendIds: async (u) => (await player(u).invoke('friendsState', u)).ids,
    blocks: (u) => player(u).invoke('blockIds', u), // REQ-RPT-012
  };
}

export function makeStableService(player: (uid: string) => PlayerInvoker, dir: StableDirectory, master: () => Master): StableService {
  return new StableService(stablePlayersFrom(player), dir, () => stableConfig(master()));
}
