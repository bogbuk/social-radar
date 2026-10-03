import { describe, it, expect, vi } from 'vitest';
import { tick, collectPosts, type TickDeps } from '../src/tick';
import { SEEN_KEY } from '../src/seen';
import { STATS_KEY } from '../src/stats';
import type { Post, Project } from '../src/types';

const NOW = 1_700_000_000 * 1000;
const memKv = () => {
  const m = new Map<string, string>();
  return { get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => { m.set(k, v); }, _m: m };
};
type MemKv = ReturnType<typeof memKv>;
const post = (id: string, over: Partial<Post> = {}): Post => ({
  id, subreddit: 'CDL', title: `HOS question ${id}`, selftext: '', url: `https://www.reddit.com/r/CDL/comments/${id}/`,
  createdUtc: 1_700_000_000 - 600, numComments: 0, author: 'u', ...over,
});
const proj = (over: Partial<Project> = {}): Project => ({
  slug: 'loadlens', name: 'LoadLens', landing: 'https://x', subreddits: ['CDL'], keywords: { any: ['HOS'] },
  maxAgeHours: 24, threshold: 7, voice: 'v', ...over,
});
const statsOf = (kv: MemKv) => JSON.parse(kv._m.get(STATS_KEY) ?? 'null');
const seenOf = (kv: MemKv) => Object.keys(JSON.parse(kv._m.get(SEEN_KEY) ?? '{}'));

function deps(over: Partial<TickDeps> = {}): TickDeps & { sent: string[]; kv: MemKv } {
  const sent: string[] = [];
  return {
    projects: [proj()],
    reddit: { newPosts: async () => [], search: async () => [] },
    kv: memKv(),
    judge: async () => ({ relevant: 9, reason: 'r', draft: 'd' }),
    send: async (t) => { sent.push(t); return true; },
    now: () => NOW,
    maxCards: 5,
    log: () => {},
    sent,
    ...over,
  } as TickDeps & { sent: string[]; kv: MemKv };
}

describe('collectPosts', () => {
  it('dedupes subreddits across projects and posts across new+search, newest first', async () => {
    const newPosts = vi.fn(async (sub: string) => (sub === 'CDL' ? [post('a', { createdUtc: 100 }), post('b', { createdUtc: 300 })] : [post('c', { createdUtc: 200 })]));
    const search = vi.fn(async () => [post('a', { createdUtc: 100 })]);
    const d = deps({ projects: [proj({ subreddits: ['CDL', 'Truckers'], queries: ['q'] }), proj({ slug: 'p2', subreddits: ['CDL'] })], reddit: { newPosts, search } });
    const posts = await collectPosts(d);
    expect(newPosts).toHaveBeenCalledTimes(2);
    expect(search).toHaveBeenCalledTimes(1);
    expect(posts.map((p) => p.id)).toEqual(['b', 'c', 'a']);
  });
});

describe('tick', () => {
  it('records the tick result, start time and duration under stats:last', async () => {
    let t = NOW;
    const d = deps({ reddit: { newPosts: async () => [post('a')], search: async () => [] }, now: () => (t += 1000) - 1000 });
    await tick(d);
    expect(statsOf(d.kv)).toMatchObject({ at: NOW, fetched: 1, candidates: 1, sent: 1, queued: 0 });
    expect(statsOf(d.kv).durationMs).toBeGreaterThan(0);
  });
  it('records an aborted tick under stats:last too', async () => {
    const d = deps({ reddit: { newPosts: async () => { throw new Error('rss down'); }, search: async () => [] } });
    await tick(d);
    expect(statsOf(d.kv)).toMatchObject({ at: NOW, fetched: 0, sent: 0 });
    expect(statsOf(d.kv).aborted).toContain('rss down');
  });

  it('sends a card for a relevant candidate and marks it seen', async () => {
    const d = deps({ reddit: { newPosts: async () => [post('a')], search: async () => [] } });
    const r = await tick(d);
    expect(r).toMatchObject({ fetched: 1, candidates: 1, sent: 1, queued: 0 });
    expect(d.sent[0]).toContain('LoadLens · r/CDL');
    expect(d.sent[0]).toContain('Draft:\nd');
    expect(seenOf(d.kv)).toEqual(['a']);
  });
  it('marks no_match and too_old posts seen without calling the model', async () => {
    const judge = vi.fn();
    const d = deps({ judge, reddit: { newPosts: async () => [post('x', { title: 'lunch spots' }), post('y', { createdUtc: 1_700_000_000 - 30 * 3600 })], search: async () => [] } });
    const r = await tick(d);
    expect(judge).not.toHaveBeenCalled();
    expect(r.sent).toBe(0);
    expect(seenOf(d.kv).sort()).toEqual(['x', 'y']);
  });
  it('skips already-seen posts entirely', async () => {
    const kv = memKv(); kv._m.set(SEEN_KEY, JSON.stringify({ a: NOW - 1000 }));
    const judge = vi.fn();
    const d = deps({ kv, judge, reddit: { newPosts: async () => [post('a')], search: async () => [] } });
    await tick(d);
    expect(judge).not.toHaveBeenCalled();
    expect(d.sent).toEqual([]);
  });
  it('below threshold → no card, but marked seen', async () => {
    const d = deps({ judge: async () => ({ relevant: 3, reason: 'meh', draft: '' }), reddit: { newPosts: async () => [post('a')], search: async () => [] } });
    const r = await tick(d);
    expect(r.sent).toBe(0);
    expect(seenOf(d.kv)).toEqual(['a']);
  });
  it('model failure → card without draft, marked seen', async () => {
    const d = deps({ judge: async () => null, reddit: { newPosts: async () => [post('a')], search: async () => [] } });
    await tick(d);
    expect(d.sent[0]).toContain('model failed');
    expect(seenOf(d.kv)).toEqual(['a']);
  });
  it('same post from new and search → one card', async () => {
    const d = deps({ reddit: { newPosts: async () => [post('a')], search: async () => [post('a')] }, projects: [proj({ queries: ['q'] })] });
    const r = await tick(d);
    expect(r.sent).toBe(1);
  });
  it('one post matching two projects → two cards, one seen entry', async () => {
    const d = deps({ projects: [proj(), proj({ slug: 'p2', name: 'P2' })], reddit: { newPosts: async () => [post('a')], search: async () => [] } });
    const r = await tick(d);
    expect(r.sent).toBe(2);
    expect(d.sent.some((t) => t.startsWith('P2 ·'))).toBe(true);
    expect(seenOf(d.kv)).toEqual(['a']);
  });
  it('caps cards per tick, leaves the rest unseen, sends overflow line', async () => {
    const posts = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id, i) => post(id, { createdUtc: 1_700_000_000 - i }));
    const d = deps({ maxCards: 5, reddit: { newPosts: async () => posts, search: async () => [] } });
    const r = await tick(d);
    expect(r.sent).toBe(5);
    expect(r.queued).toBe(2);
    expect(d.sent).toHaveLength(6);
    expect(d.sent[5]).toBe('Ещё 2 в очереди, следующий тик.');
    expect(seenOf(d.kv).sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
  it('limits model calls per tick to 2×maxCards even when nothing passes the threshold', async () => {
    const posts = Array.from({ length: 20 }, (_, i) => post(`p${i}`, { createdUtc: 1_700_000_000 - i }));
    const judge = vi.fn(async () => ({ relevant: 1, reason: 'no', draft: '' }));
    const d = deps({ maxCards: 5, judge, reddit: { newPosts: async () => posts, search: async () => [] } });
    const r = await tick(d);
    expect(judge).toHaveBeenCalledTimes(10);
    expect(r.queued).toBe(10);
    expect(seenOf(d.kv)).toHaveLength(10);
  });
  it('telegram failure → post not marked seen, tick stops sending', async () => {
    const send = vi.fn().mockResolvedValue(false);
    const d = deps({ send, reddit: { newPosts: async () => [post('a'), post('b')], search: async () => [] } });
    const r = await tick(d);
    expect(r.sent).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(seenOf(d.kv)).toEqual([]);
  });
  it('all sources failing → aborted, nothing marked, nothing sent', async () => {
    const d = deps({ reddit: { newPosts: async () => { throw new Error('429'); }, search: async () => [] } });
    const r = await tick(d);
    expect(r.aborted).toContain('429');
    expect(d.sent).toEqual([]);
    expect(d.kv._m.has(SEEN_KEY)).toBe(false);
  });
  it('one subreddit failing → the others are still processed', async () => {
    const newPosts = vi.fn(async (sub: string) => { if (sub === 'Truckers') throw new Error('429'); return [post('a')]; });
    const d = deps({ projects: [proj({ subreddits: ['Truckers', 'CDL'] })], reddit: { newPosts, search: async () => [] } });
    const r = await tick(d);
    expect(r.aborted).toBeUndefined();
    expect(r.sent).toBe(1);
    expect(seenOf(d.kv)).toEqual(['a']);
  });
});
