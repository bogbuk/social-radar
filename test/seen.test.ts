import { describe, it, expect } from 'vitest';
import { SeenStore, loadSeen, saveSeen, SEEN_KEY, SEEN_KEEP_MS } from '../src/seen';

const memKv = () => {
  const m = new Map<string, string>();
  return { get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => { m.set(k, v); }, _m: m };
};

describe('SeenStore', () => {
  it('parses, adds, has, serializes', () => {
    const s = SeenStore.parse('{"a":1}');
    expect(s.has('a')).toBe(true);
    expect(s.has('b')).toBe(false);
    s.add('b', 5);
    expect(JSON.parse(s.serialize())).toEqual({ a: 1, b: 5 });
  });
  it('starts empty on corrupted or non-object values', () => {
    for (const raw of [null, '', 'not json', '[1,2]', 'null', '42']) {
      expect(SeenStore.parse(raw).size()).toBe(0);
    }
  });
  it('prunes entries older than SEEN_KEEP_MS', () => {
    const now = 10_000_000;
    const s = SeenStore.parse(JSON.stringify({ old: now - SEEN_KEEP_MS - 1, fresh: now - 1000 }));
    s.prune(now);
    expect(s.has('old')).toBe(false);
    expect(s.has('fresh')).toBe(true);
  });
});

describe('loadSeen/saveSeen', () => {
  it('round-trips through KV under SEEN_KEY and prunes on save', async () => {
    const kv = memKv();
    const s = await loadSeen(kv);
    expect(s.size()).toBe(0);
    s.add('x', 100);
    s.add('y', 100 + SEEN_KEEP_MS + 5);
    await saveSeen(kv, s, 100 + SEEN_KEEP_MS + 5);
    expect(JSON.parse(kv._m.get(SEEN_KEY)!)).toEqual({ y: 100 + SEEN_KEEP_MS + 5 });
  });
});
