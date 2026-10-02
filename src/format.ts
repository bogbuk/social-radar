import type { Card } from './types';

export const TG_LIMIT = 4000;

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
  const head = `${project.name} · r/${post.subreddit} · ${formatAge(post.createdUtc, nowMs)} · ${post.numComments} comments\n${post.title}\n\n`;
  const score = verdict ? `Score ${verdict.relevant}/10: ${verdict.reason}\n\n` : 'Score: model failed, no draft\n\n';
  const fixed = `${head}${score}${post.url}`;
  if (!verdict?.draft) return fixed;
  const prefix = `${fixed}\n\nDraft:\n`;
  const room = TG_LIMIT - prefix.length;
  const draft = verdict.draft.length > room ? `${verdict.draft.slice(0, Math.max(0, room - 1))}…` : verdict.draft;
  return `${prefix}${draft}`;
}

export function formatOverflow(n: number): string {
  return `Ещё ${n} в очереди, следующий тик.`;
}
