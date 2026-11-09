/** REQ-HOF-*: adapts per-player invocations (PlayerDO RPC or PlayerService) to the 殿堂 orchestration. */
import type { Master } from '../domain/master.js';
import { hallConfig, HallService, type HallDirectory, type HallPlayers } from '../domain/hallOfFame.js';
import type { PlayerInvoker } from './app.js';

export function hallPlayersFrom(player: (uid: string) => PlayerInvoker): HallPlayers {
  return {
    mine: (u, cursor, limit) => player(u).invoke('hallMine', u, cursor, limit),
    viewerOf: (u) => player(u).invoke('hallViewer', u),
    noteView: (u, relation, count) => player(u).invoke('hallNoteView', u, relation, count),
  };
}

export function makeHallService(player: (uid: string) => PlayerInvoker, dir: HallDirectory, master: () => Master): HallService {
  return new HallService(hallPlayersFrom(player), dir, () => hallConfig(master()));
}
