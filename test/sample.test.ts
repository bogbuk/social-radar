import { describe, it, expect } from 'vitest';
import { samplePost } from '../src/sample';
import { prefilter } from '../src/match';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('samplePost', () => {
  it('is a fresh candidate for the loadlens config (so /run?sample=1 exercises model + telegram)', () => {
    const cfg = JSON.parse(readFileSync(join(__dirname, '..', 'projects', 'loadlens', 'config.json'), 'utf8'));
    const now = Date.now();
    const p = samplePost(now);
    expect(p.id.startsWith('sample-')).toBe(true);
    expect(prefilter(p, cfg, now)).toBe('candidate');
  });
});
