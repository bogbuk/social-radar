import { describe, it, expect } from 'vitest';
import { buildMessages, parseVerdict, truncate, MAX_SELFTEXT, FRAME } from '../src/prompt';
import type { Post, Project } from '../src/types';

const project: Project = { slug: 'p', name: 'LoadLens', landing: 'https://x', subreddits: [], keywords: { any: [] }, maxAgeHours: 24, threshold: 7, voice: '# Voice\nBe short.' };
const post: Post = { id: 'a', subreddit: 'CDL', title: 'T', selftext: 'B'.repeat(5000), url: 'https://r/x', createdUtc: 1000, numComments: 2, author: 'u' };

describe('truncate', () => {
  it('keeps short strings, cuts long with ellipsis at exactly max', () => {
    expect(truncate('abc', 5)).toBe('abc');
    expect(truncate('abcdefgh', 5)).toBe('abcd…');
    expect(truncate('abcdefgh', 5).length).toBe(5);
  });
});

describe('buildMessages', () => {
  it('system = FRAME + voice; user has subreddit, age, comments, title, truncated body', () => {
    const { system, user } = buildMessages(project, post, 1000 * 1000 + 5 * 60 * 1000);
    expect(system.startsWith(FRAME)).toBe(true);
    expect(system).toContain('Voice and rules for LoadLens');
    expect(system).toContain('Be short.');
    expect(user).toContain('Subreddit: r/CDL');
    expect(user).toContain('Age: 5 min ago');
    expect(user).toContain('Comments: 2');
    expect(user).toContain('Title: T');
    expect(user.length).toBeLessThan(MAX_SELFTEXT + 200);
  });
  it('empty body → "(no body)"', () => {
    expect(buildMessages(project, { ...post, selftext: '' }, 2_000_000).user).toContain('(no body)');
  });
});

describe('parseVerdict', () => {
  it('parses clean JSON', () => {
    expect(parseVerdict('{"relevant": 8, "reason": "asks about 14h", "draft": "Yes."}')).toEqual({ relevant: 8, reason: 'asks about 14h', draft: 'Yes.' });
  });
  it('strips code fences and prose around JSON', () => {
    expect(parseVerdict('Sure! ```json\n{"relevant": 3, "reason": "meme", "draft": ""}\n```')).toEqual({ relevant: 3, reason: 'meme', draft: '' });
  });
  it('coerces numeric strings and rounds', () => {
    expect(parseVerdict('{"relevant": "8", "reason": "r", "draft": "d"}')?.relevant).toBe(8);
    expect(parseVerdict('{"relevant": 7.6, "reason": "r", "draft": "d"}')?.relevant).toBe(8);
  });
  it('rejects out-of-range, missing, or non-JSON', () => {
    expect(parseVerdict('{"relevant": 11, "reason": "r", "draft": ""}')).toBeNull();
    expect(parseVerdict('{"reason": "r"}')).toBeNull();
    expect(parseVerdict('no json here')).toBeNull();
    expect(parseVerdict('')).toBeNull();
  });
  it('missing reason/draft become empty strings', () => {
    expect(parseVerdict('{"relevant": 2}')).toEqual({ relevant: 2, reason: '', draft: '' });
  });
});
