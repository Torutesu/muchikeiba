/**
 * "Something changed since the last published snapshot", safe across awaits.
 *
 * A boolean flag cleared after the (awaited) R2 writes loses updates that arrive during those writes:
 * the upsert sets it to true, then the snapshot overwrites it with false although its data was read
 * before the upsert. A generation counter fixes that: writers bump `dirtyGen`; a snapshot remembers the
 * generation it read *before* reading the rows and, when done, marks only that generation published.
 */
export interface KvLike {
  get<T>(k: string): T | null;
  put(k: string, v: unknown): void;
}

export class DirtyTracker {
  constructor(private readonly kv: KvLike) {}

  /** Called by every write that should appear in the next snapshot. */
  mark() {
    this.kv.put('dirtyGen', (this.kv.get<number>('dirtyGen') ?? 0) + 1);
  }

  /** Generation to snapshot, or null when nothing changed since the last published one. */
  begin(force = false): number | null {
    const gen = this.kv.get<number>('dirtyGen') ?? 0;
    const published = this.kv.get<number>('publishedGen') ?? 0;
    const legacyDirty = this.kv.get<boolean>('dirty') === true; // flag written by older builds
    if (!force && gen <= published && !legacyDirty) return null;
    return gen;
  }

  /** Marks `gen` (from begin) as published; later writes keep the object dirty. */
  end(gen: number) {
    const published = this.kv.get<number>('publishedGen') ?? 0;
    if (gen > published) this.kv.put('publishedGen', gen);
    if (this.kv.get<boolean>('dirty') !== null) this.kv.put('dirty', false);
  }
}
