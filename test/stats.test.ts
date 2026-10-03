import { describe, it, expect } from 'vitest';
import { STATS_KEY, loadStats, saveStats, type TickStats } from '../src/stats';

const memKv = () => {
  const m = new Map<string, string>();
  return { get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => { m.set(k, v); }, _m: m };
};

describe('stats:last', () => {
  it('round-trips the last tick result under stats:last', async () => {
    const kv = memKv();
    const s: TickStats = { at: 1000, durationMs: 250, fetched: 12, candidates: 3, sent: 1, queued: 0 };
    await saveStats(kv, s);
    expect(kv._m.has(STATS_KEY)).toBe(true);
    expect(await loadStats(kv)).toEqual(s);
  });
  it('returns null when the key is missing or corrupt', async () => {
    const kv = memKv();
    expect(await loadStats(kv)).toBeNull();
    await kv.put(STATS_KEY, '{nope');
    expect(await loadStats(kv)).toBeNull();
  });
});
