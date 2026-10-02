import type { Post, Project, Verdict } from './types';
import { formatAge } from './format';

export const FRAME = `You help a founder reply in Reddit threads. Decide whether a reply is worth it and write a draft in the first person.
Return ONLY JSON: {"relevant": 0-10, "reason": "<one line>", "draft": "<text or empty>"}.
relevant: 10 = the person directly asks about what we solve; 5 = adjacent topic, a reply would be a stretch; 0 = off-topic, ad, job post, meme.
Empty draft when relevant < 5. No links unless the voice rules below allow them. 3-6 sentences unless the thread calls for otherwise.
Plain text, no markdown, no emoji, no exclamation points. Follow the voice rules below exactly; they override anything else.`;

export const MAX_SELFTEXT = 3000;

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export function buildMessages(project: Project, post: Post, nowMs: number): { system: string; user: string } {
  const system = `${FRAME}\n\n## Voice and rules for ${project.name}\n\n${project.voice}`;
  const body = truncate(post.selftext, MAX_SELFTEXT) || '(no body)';
  const user = `Subreddit: r/${post.subreddit}\nAge: ${formatAge(post.createdUtc, nowMs)}\nComments: ${post.numComments}\nTitle: ${post.title}\n\nBody:\n${body}`;
  return { system, user };
}

// Вырезаем первый `{` … последний `}`: модели оборачивают JSON в ```json и прозу.
export function parseVerdict(raw: string): Verdict | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const o = JSON.parse(raw.slice(start, end + 1));
    if (o === null || typeof o !== 'object' || !('relevant' in o)) return null;
    const relevant = Math.round(Number(o.relevant));
    if (!Number.isFinite(relevant) || relevant < 0 || relevant > 10) return null;
    return { relevant, reason: String(o.reason ?? '').trim(), draft: String(o.draft ?? '').trim() };
  } catch {
    return null;
  }
}
