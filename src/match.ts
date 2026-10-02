import type { Post, ProjectConfig } from './types';

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

// Слово целиком; `/` входит в границу, чтобы "8/2" не ловило дату "8/2/2026".
// Ключ из одних ЗАГЛАВНЫХ (с цифрами/знаками) и хотя бы одной буквой — регистрозависим (HOS ≠ hospital).
export function compileKeyword(k: string): RegExp {
  const caseSensitive = /^[A-Z0-9/\-+]+$/.test(k) && /[A-Z]/.test(k);
  return new RegExp(`(?<![\\w/])${escapeRe(k)}(?![\\w/])`, caseSensitive ? '' : 'i');
}

export function matchKeywords(text: string, keywords: ProjectConfig['keywords']): boolean {
  if (keywords.exclude?.some((k) => compileKeyword(k).test(text))) return false;
  return keywords.any.some((k) => compileKeyword(k).test(text));
}

export function ageHours(post: Post, nowMs: number): number {
  return Math.max(0, (nowMs / 1000 - post.createdUtc) / 3600);
}

export type Prefilter = 'candidate' | 'too_old' | 'no_match';

export function prefilter(post: Post, project: ProjectConfig, nowMs: number): Prefilter {
  if (ageHours(post, nowMs) > project.maxAgeHours) return 'too_old';
  return matchKeywords(`${post.title}\n${post.selftext}`, project.keywords) ? 'candidate' : 'no_match';
}
