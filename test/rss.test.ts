import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseAtom, RssClient, RssError } from '../src/rss';

const xml = readFileSync(join(__dirname, 'fixtures', 'reddit-new.rss'), 'utf8');

describe('parseAtom', () => {
  it('maps entries to Post: id without t3_, title unescaped, link, published time, author without /u/', () => {
    const posts = parseAtom(xml, 'CDL');
    expect(posts).toHaveLength(3);
    const p = posts[2];
    expect(p.id).toBe('zzz999');
    expect(p.subreddit).toBe('CDL');
    expect(p.title).toBe('Does the 14 hour clock keep running & what about <breaks>?');
    expect(p.url).toBe('https://www.reddit.com/r/CDL/comments/zzz999/does_the_14_hour_clock_keep_running/');
    expect(p.createdUtc).toBe(Math.floor(Date.parse('2026-10-02T06:30:00+00:00') / 1000));
    expect(p.author).toBe('tester');
    expect(p.numComments).toBe(0);
    expect(p.selftext).toBe('');
  });
  it('turns html content into plain selftext without the "submitted by" boilerplate', () => {
    const p = parseAtom(xml, 'CDL')[0];
    expect(p.id).toBe('1wvkjgu');
    expect(p.selftext).toContain('Disclosure: I run CDL Test Prep Tracker');
    expect(p.selftext).toContain("If you're just starting permit prep");
    expect(p.selftext).not.toContain('<p>');
    expect(p.selftext).not.toContain('submitted by');
    expect(p.selftext).not.toContain('[comments]');
  });
  it('tolerates garbage', () => {
    expect(parseAtom('', 'X')).toEqual([]);
    expect(parseAtom('<feed><entry><title>no id</title></entry></feed>', 'X')).toEqual([]);
  });
});

describe('RssClient', () => {
  it('fetches /r/<sub>/new.rss with a browser-like user agent', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(xml, { status: 200 }));
    const posts = await new RssClient(fetchFn as any, 0).newPosts('CDL');
    expect(posts).toHaveLength(3);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('https://www.reddit.com/r/CDL/new.rss?limit=25');
    expect(init.headers['User-Agent']).toMatch(/Mozilla/);
  });
  it('spaces requests by minGapMs (Reddit allows ~1 unauthenticated request per 30 s per IP)', async () => {
    const times: number[] = [];
    const fetchFn = vi.fn(async () => { times.push(Date.now()); return new Response(xml, { status: 200 }); });
    const c = new RssClient(fetchFn as any, 120);
    await Promise.all([c.newPosts('A'), c.newPosts('B'), c.newPosts('C')]);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(100);
    expect(times[2] - times[1]).toBeGreaterThanOrEqual(100);
  });
  it('search is unsupported and returns []', async () => {
    const fetchFn = vi.fn();
    expect(await new RssClient(fetchFn as any, 0).search('q')).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it('retries once after a 429, then succeeds', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(new Response('', { status: 429 })).mockResolvedValueOnce(new Response(xml, { status: 200 }));
    expect(await new RssClient(fetchFn as any, 0).newPosts('CDL')).toHaveLength(3);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
  it('throws RssError with status on persistent 429', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('', { status: 429 }));
    const err = await new RssClient(fetchFn as any, 0).newPosts('CDL').catch((e) => e);
    expect(err).toBeInstanceOf(RssError);
    expect(err.status).toBe(429);
  });
});

describe('default fetch binding', () => {
  it('calls global fetch without a foreign `this` (Workers throw Illegal invocation otherwise)', async () => {
    const strictFetch = vi.fn(function (this: unknown) {
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
      return Promise.resolve(new Response(xml, { status: 200 }));
    });
    vi.stubGlobal('fetch', strictFetch);
    try {
      expect(await new RssClient(undefined, 0).newPosts('CDL')).toHaveLength(3);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
