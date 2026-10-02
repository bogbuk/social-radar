import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectConfig } from '../src/types';

const root = join(__dirname, '..', 'projects');
const slugs = existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : [];

describe('projects/*', () => {
  it('has at least loadlens', () => expect(slugs).toContain('loadlens'));
  for (const slug of slugs) {
    it(`${slug}: valid config.json and non-empty voice.md`, () => {
      const cfg = JSON.parse(readFileSync(join(root, slug, 'config.json'), 'utf8')) as ProjectConfig;
      expect(cfg.slug).toBe(slug);
      expect(cfg.name.length).toBeGreaterThan(0);
      expect(cfg.landing).toMatch(/^https:\/\//);
      expect(cfg.subreddits.length).toBeGreaterThan(0);
      expect(cfg.keywords.any.length).toBeGreaterThan(0);
      expect(cfg.maxAgeHours).toBeGreaterThan(0);
      expect(cfg.threshold).toBeGreaterThanOrEqual(0);
      expect(cfg.threshold).toBeLessThanOrEqual(10);
      expect(existsSync(join(root, slug, 'voice.md'))).toBe(true);
      expect(readFileSync(join(root, slug, 'voice.md'), 'utf8').trim().length).toBeGreaterThan(100);
    });
  }
});
