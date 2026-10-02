import type { Card, Post, Project, Verdict } from './types';
import { prefilter } from './match';
import { loadSeen, saveSeen, type KVLike } from './seen';
import { formatCard, formatOverflow } from './format';

export interface TickDeps {
  projects: Project[];
  reddit: { newPosts(sub: string): Promise<Post[]>; search(q: string): Promise<Post[]> };
  kv: KVLike;
  judge(project: Project, post: Post): Promise<Verdict | null>;
  send(text: string): Promise<boolean>;
  now(): number;
  maxCards: number;
  log?: (...a: unknown[]) => void;
}

export interface TickResult {
  fetched: number;
  candidates: number;
  sent: number;
  queued: number;
  aborted?: string;
}

export async function collectPosts(deps: TickDeps): Promise<Post[]> {
  const subs = [...new Set(deps.projects.flatMap((p) => p.subreddits))];
  const queries = [...new Set(deps.projects.flatMap((p) => p.queries ?? []))];
  const batches = await Promise.all([...subs.map((s) => deps.reddit.newPosts(s)), ...queries.map((q) => deps.reddit.search(q))]);
  const byId = new Map<string, Post>();
  for (const p of batches.flat()) if (!byId.has(p.id)) byId.set(p.id, p);
  return [...byId.values()].sort((a, b) => b.createdUtc - a.createdUtc);
}

export async function tick(deps: TickDeps): Promise<TickResult> {
  const log = deps.log ?? console.log;
  const nowMs = deps.now();
  const seen = await loadSeen(deps.kv);

  let posts: Post[];
  try {
    posts = await collectPosts(deps);
  } catch (e) {
    log('tick: reddit failed, abort', String(e));
    return { fetched: 0, candidates: 0, sent: 0, queued: 0, aborted: String(e) };
  }

  // Отсев без модели. Что не кандидат ни для одного проекта — помечаем сразу.
  const work: { post: Post; projects: Project[] }[] = [];
  for (const post of posts) {
    if (seen.has(post.id)) continue;
    const hits = deps.projects.filter((p) => prefilter(post, p, nowMs) === 'candidate');
    if (hits.length) work.push({ post, projects: hits });
    else seen.add(post.id, nowMs);
  }

  let sent = 0;
  let judged = 0;
  let queued = 0;
  let telegramDown = false;
  // Бюджет вызовов модели на тик: иначе десятки кандидатов ниже порога = десятки вызовов 120B за тик.
  const maxJudges = deps.maxCards * 2;
  for (let i = 0; i < work.length; i++) {
    const { post, projects } = work[i];
    // `sent > 0 &&` / `judged > 0 &&`: пост, подходящий большему числу проектов, чем потолок, иначе застрял бы навсегда.
    const overCards = sent > 0 && sent + projects.length > deps.maxCards;
    const overJudges = judged > 0 && judged + projects.length > maxJudges;
    if (telegramDown || overCards || overJudges) {
      queued = work.length - i;
      break;
    }
    const cards: Card[] = [];
    for (const project of projects) {
      judged++;
      const verdict = await deps.judge(project, post);
      if (verdict && verdict.relevant < project.threshold) continue;
      cards.push({ project, post, verdict });
    }
    let delivered = true;
    for (const card of cards) {
      if (await deps.send(formatCard(card, nowMs))) {
        sent++;
      } else {
        delivered = false;
        telegramDown = true;
        break;
      }
    }
    if (delivered) seen.add(post.id, nowMs); // все карточки ушли (или ни одна не нужна)
  }

  if (queued > 0 && !telegramDown) await deps.send(formatOverflow(queued));
  await saveSeen(deps.kv, seen, nowMs);
  log(`tick: fetched=${posts.length} candidates=${work.length} sent=${sent} queued=${queued}`);
  return { fetched: posts.length, candidates: work.length, sent, queued };
}
