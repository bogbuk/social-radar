import { describe, it, expect, vi } from 'vitest';
import { parseListing, RedditClient, RedditError } from '../src/reddit';
import fixture from './fixtures/reddit-new.json';

const memKv = () => {
  const m = new Map<string, string>();
  return { get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => { m.set(k, v); }, _m: m };
};
const auth = { clientId: 'id', clientSecret: 'sec', username: 'me', password: 'pw' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('parseListing', () => {
  it('maps t3 children to Post, skips comments, builds absolute url', () => {
    const posts = parseListing(fixture);
    expect(posts).toHaveLength(2);
    expect(posts[0]).toEqual({
      id: '1abc23', subreddit: 'CDL', title: 'Does the 14 hour clock keep running at the shipper?',
      selftext: 'Waited 4 hours today and my dispatcher says I still have 11 to drive. Is that right?',
      url: 'https://www.reddit.com/r/CDL/comments/1abc23/does_the_14_hour_clock_keep_running/',
      createdUtc: 1759400000, numComments: 3, author: 'newdriver22',
    });
    expect(posts[1].selftext).toBe('');
  });
  it('tolerates garbage', () => {
    expect(parseListing(null)).toEqual([]);
    expect(parseListing({ data: {} })).toEqual([]);
  });
});

describe('RedditClient', () => {
  it('fetches token with basic auth + password grant and caches it in KV with ttl', async () => {
    const kv = memKv();
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(json({ access_token: 'T1', expires_in: 3600 }))
      .mockResolvedValueOnce(json(fixture));
    const c = new RedditClient(auth, kv, 'ua/1', fetchFn as any);
    const posts = await c.newPosts('CDL');
    expect(posts).toHaveLength(2);
    const [tokenUrl, tokenInit] = fetchFn.mock.calls[0];
    expect(tokenUrl).toBe('https://www.reddit.com/api/v1/access_token');
    expect(tokenInit.method).toBe('POST');
    expect(tokenInit.headers.Authorization).toBe(`Basic ${btoa('id:sec')}`);
    expect(tokenInit.headers['User-Agent']).toBe('ua/1');
    expect(String(tokenInit.body)).toContain('grant_type=password');
    const [listUrl, listInit] = fetchFn.mock.calls[1];
    expect(listUrl).toBe('https://oauth.reddit.com/r/CDL/new?limit=25&raw_json=1');
    expect(listInit.headers.Authorization).toBe('Bearer T1');
    expect(kv._m.get('token:reddit')).toBe('T1');
  });
  it('uses cached token without hitting token endpoint', async () => {
    const kv = memKv(); kv._m.set('token:reddit', 'CACHED');
    const fetchFn = vi.fn().mockResolvedValueOnce(json(fixture));
    const c = new RedditClient(auth, kv, 'ua/1', fetchFn as any);
    await c.newPosts('CDL');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0][1].headers.Authorization).toBe('Bearer CACHED');
  });
  it('on 401 refreshes token once and retries', async () => {
    const kv = memKv(); kv._m.set('token:reddit', 'OLD');
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(json({ access_token: 'NEW', expires_in: 3600 }))
      .mockResolvedValueOnce(json(fixture));
    const c = new RedditClient(auth, kv, 'ua/1', fetchFn as any);
    await c.newPosts('CDL');
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(fetchFn.mock.calls[2][1].headers.Authorization).toBe('Bearer NEW');
  });
  it('throws RedditError with status on 429', async () => {
    const kv = memKv(); kv._m.set('token:reddit', 'T');
    const fetchFn = vi.fn().mockResolvedValue(new Response('', { status: 429 }));
    const c = new RedditClient(auth, kv, 'ua/1', fetchFn as any);
    const err = await c.newPosts('CDL').catch((e) => e);
    expect(err).toBeInstanceOf(RedditError);
    expect(err.status).toBe(429);
  });
  it('parallel requests with an empty cache fetch the token once (single-flight)', async () => {
    const kv = memKv();
    const fetchFn = vi.fn(async (url: string) => (url.includes('access_token') ? json({ access_token: 'T', expires_in: 3600 }) : json(fixture)));
    const c = new RedditClient(auth, kv, 'ua/1', fetchFn as any);
    await Promise.all([c.newPosts('A'), c.newPosts('B'), c.newPosts('C')]);
    expect(fetchFn.mock.calls.filter(([u]) => String(u).includes('access_token'))).toHaveLength(1);
  });
  it('search encodes query and uses sort=new&t=day', async () => {
    const kv = memKv(); kv._m.set('token:reddit', 'T');
    const fetchFn = vi.fn().mockResolvedValueOnce(json(fixture));
    const c = new RedditClient(auth, kv, 'ua/1', fetchFn as any);
    await c.search('"hours of service" calculator');
    expect(fetchFn.mock.calls[0][0]).toBe('https://oauth.reddit.com/search?q=%22hours%20of%20service%22%20calculator&sort=new&t=day&limit=25&raw_json=1');
  });
});

describe('default fetch binding', () => {
  it('calls global fetch without a foreign `this`', async () => {
    const strictFetch = vi.fn(function (this: unknown, url: string) {
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
      return Promise.resolve(url.includes('access_token') ? json({ access_token: 'T', expires_in: 3600 }) : json(fixture));
    });
    vi.stubGlobal('fetch', strictFetch);
    try {
      expect(await new RedditClient(auth, memKv(), 'ua/1').newPosts('CDL')).toHaveLength(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
