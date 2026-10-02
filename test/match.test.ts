import { describe, it, expect } from 'vitest';
import { compileKeyword, matchKeywords, ageHours, prefilter } from '../src/match';
import type { Post, ProjectConfig } from '../src/types';

const post = (over: Partial<Post> = {}): Post => ({
  id: 'abc', subreddit: 'CDL', title: 'Question about the 14 hour clock', selftext: '',
  url: 'https://www.reddit.com/r/CDL/comments/abc/x/', createdUtc: 1_000_000, numComments: 0, author: 'u', ...over,
});
const project: ProjectConfig = {
  slug: 'p', name: 'P', landing: 'https://x', subreddits: ['CDL'],
  keywords: { any: ['hours of service', 'HOS', '14 hour', '8/2', '70/8'], exclude: ['hiring'] },
  maxAgeHours: 24, threshold: 7,
};

describe('compileKeyword', () => {
  it('matches whole words, case-insensitive for normal words', () => {
    expect(compileKeyword('recap').test('Will it RECAP?')).toBe(true);
    expect(compileKeyword('recap').test('recapture')).toBe(false);
  });
  it('uppercase abbreviations are case-sensitive', () => {
    expect(compileKeyword('HOS').test('my HOS clock')).toBe(true);
    expect(compileKeyword('HOS').test('the hospital')).toBe(false);
    expect(compileKeyword('HOS').test('hos')).toBe(false);
  });
  it('slash keywords do not match dates', () => {
    expect(compileKeyword('8/2').test('I run an 8/2 split')).toBe(true);
    expect(compileKeyword('8/2').test('on 8/2/2026 I was')).toBe(false);
    expect(compileKeyword('70/8').test('70/8 cycle')).toBe(true);
  });
  it('escapes regex specials', () => {
    expect(compileKeyword('c++').test('learning c++ now')).toBe(true);
  });
});

describe('matchKeywords', () => {
  it('any hit → true, exclude hit → false even with any hit', () => {
    expect(matchKeywords('hours of service question', project.keywords)).toBe(true);
    expect(matchKeywords('hiring drivers, hours of service ok', project.keywords)).toBe(false);
    expect(matchKeywords('nothing relevant', project.keywords)).toBe(false);
  });
});

describe('ageHours', () => {
  it('computes hours and clamps future posts to 0', () => {
    expect(ageHours(post({ createdUtc: 1000 }), 1000 * 1000 + 2 * 3600 * 1000)).toBeCloseTo(2);
    expect(ageHours(post({ createdUtc: 5000 }), 1000 * 1000)).toBe(0);
  });
});

describe('prefilter', () => {
  const now = 1_000_000 * 1000 + 3600 * 1000; // пост 1 час назад
  it('candidate when fresh and matched', () => expect(prefilter(post(), project, now)).toBe('candidate'));
  it('too_old beyond maxAgeHours', () => expect(prefilter(post({ createdUtc: 1_000_000 - 25 * 3600 }), project, now)).toBe('too_old'));
  it('no_match when keywords absent', () => expect(prefilter(post({ title: 'truck stop food' }), project, now)).toBe('no_match'));
  it('matches in selftext too', () => expect(prefilter(post({ title: 'help', selftext: 'my HOS is confusing' }), project, now)).toBe('candidate'));
  it('future-dated post is still a candidate', () => expect(prefilter(post({ createdUtc: 1_000_000 + 600 }), project, now)).toBe('candidate'));
});
