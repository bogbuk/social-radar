import type { Card } from './types';

export const TG_LIMIT = 4000;
const MAX_TITLE = 300;
const MAX_REASON = 300;

const cut = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`);

export function formatAge(createdUtc: number, nowMs: number): string {
  const mins = Math.max(0, Math.floor((nowMs / 1000 - createdUtc) / 60));
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

// Plain text (без markdown: заголовки Reddit полны подчёркиваний и скобок), ссылка отдельной строкой.
export function formatCard(card: Card, nowMs: number): string {
  const { project, post, verdict } = card;
  const head = `${project.name} · r/${post.subreddit} · ${formatAge(post.createdUtc, nowMs)} · ${post.numComments} comments\n${cut(post.title, MAX_TITLE)}\n\n`;
  const score = verdict ? `Score ${verdict.relevant}/10: ${cut(verdict.reason, MAX_REASON)}\n\n` : 'Score: model failed, no draft\n\n';
  // Ссылка — последнее, что режется: без неё карточка бесполезна.
  const fixed = cut(`${head}${score}${post.url}`, TG_LIMIT);
  if (!verdict?.draft) return fixed;
  const prefix = `${fixed}\n\nDraft:\n`;
  return cut(`${prefix}${verdict.draft}`, TG_LIMIT);
}

export function formatOverflow(n: number): string {
  return `Ещё ${n} в очереди, следующий тик.`;
}
