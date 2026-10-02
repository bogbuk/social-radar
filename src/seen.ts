export interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}

// Одна KV-запись на все увиденные посты: бесплатный план даёт 50 субзапросов на вызов,
// и KV-операции в них входят — ключ на пост невозможен.
export const SEEN_KEY = 'seen:v1';
export const SEEN_KEEP_MS = 3 * 24 * 3600 * 1000;

export class SeenStore {
  constructor(private map: Record<string, number> = {}) {}

  static parse(raw: string | null): SeenStore {
    if (!raw) return new SeenStore();
    try {
      const o = JSON.parse(raw);
      if (o && typeof o === 'object' && !Array.isArray(o)) return new SeenStore(o as Record<string, number>);
    } catch {
      /* повреждённое значение → пустое хранилище */
    }
    return new SeenStore();
  }

  has(id: string): boolean { return Object.prototype.hasOwnProperty.call(this.map, id); }
  add(id: string, nowMs: number): void { this.map[id] = nowMs; }
  prune(nowMs: number): void {
    for (const [id, t] of Object.entries(this.map)) if (nowMs - Number(t) > SEEN_KEEP_MS) delete this.map[id];
  }
  size(): number { return Object.keys(this.map).length; }
  serialize(): string { return JSON.stringify(this.map); }
}

export async function loadSeen(kv: KVLike): Promise<SeenStore> {
  return SeenStore.parse(await kv.get(SEEN_KEY));
}

export async function saveSeen(kv: KVLike, store: SeenStore, nowMs: number): Promise<void> {
  store.prune(nowMs);
  await kv.put(SEEN_KEY, store.serialize());
}
