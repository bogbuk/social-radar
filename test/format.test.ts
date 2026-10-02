import { describe, it, expect } from 'vitest';
import { formatAge, formatCard, formatOverflow, TG_LIMIT } from '../src/format';
import type { Card } from '../src/types';

const now = 1_700_000_000 * 1000;
const card = (over: Partial<Card> = {}): Card => ({
  project: { slug: 'loadlens', name: 'LoadLens', landing: 'https://x', subreddits: [], keywords: { any: [] }, maxAgeHours: 24, threshold: 7, voice: '' },
  post: { id: 'abc', subreddit: 'CDL', title: 'Will the 14 hour clock keep running?', selftext: '', url: 'https://www.reddit.com/r/CDL/comments/abc/x/', createdUtc: 1_700_000_000 - 42 * 60, numComments: 3, author: 'u' },
  verdict: { relevant: 9, reason: 'new driver asks exactly the 14-hour window question.', draft: 'Yes, and that is the part that bites.' },
  ...over,
});

describe('formatAge', () => {
  it('minutes, hours, days; future → 0 min', () => {
    expect(formatAge(1_700_000_000 - 42 * 60, now)).toBe('42 min ago');
    expect(formatAge(1_700_000_000 - 3 * 3600, now)).toBe('3 h ago');
    expect(formatAge(1_700_000_000 - 50 * 3600, now)).toBe('2 d ago');
    expect(formatAge(1_700_000_000 + 600, now)).toBe('0 min ago');
  });
});

describe('formatCard', () => {
  it('renders header, score, link, draft', () => {
    expect(formatCard(card(), now)).toBe(
      'LoadLens · r/CDL · 42 min ago · 3 comments\n' +
      'Will the 14 hour clock keep running?\n\n' +
      'Score 9/10: new driver asks exactly the 14-hour window question.\n\n' +
      'https://www.reddit.com/r/CDL/comments/abc/x/\n\n' +
      'Draft:\nYes, and that is the part that bites.',
    );
  });
  it('model failure → explicit line, no Draft section', () => {
    const text = formatCard(card({ verdict: null }), now);
    expect(text).toContain('Score: model failed, no draft');
    expect(text).not.toContain('Draft:');
    expect(text.endsWith('/x/')).toBe(true);
  });
  it('empty draft → no Draft section', () => {
    expect(formatCard(card({ verdict: { relevant: 8, reason: 'r', draft: '' } }), now)).not.toContain('Draft:');
  });
  it('caps the whole card even without a draft: long title + long reason stay under TG_LIMIT', () => {
    const text = formatCard(card({ post: { ...card().post, title: 'T'.repeat(3000) }, verdict: { relevant: 8, reason: 'R'.repeat(3000), draft: '' } }), now);
    expect(text.length).toBeLessThanOrEqual(TG_LIMIT);
    expect(text).toContain('https://www.reddit.com/r/CDL/comments/abc/x/');
  });
  it('truncates long drafts to TG_LIMIT with ellipsis', () => {
    const text = formatCard(card({ verdict: { relevant: 8, reason: 'r', draft: 'x'.repeat(10_000) } }), now);
    expect(text.length).toBeLessThanOrEqual(TG_LIMIT);
    expect(text.endsWith('…')).toBe(true);
  });
});

describe('formatOverflow', () => {
  it('reports queued count', () => {
    expect(formatOverflow(3)).toBe('Ещё 3 в очереди, следующий тик.');
  });
});
