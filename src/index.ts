import { PROJECTS } from './projects.generated';
import { RedditClient } from './reddit';
import { RssClient } from './rss';
import { sourceKind, telegramConfigured } from './source';
import { judge } from './ai';
import { buildMessages } from './prompt';
import { sendTelegram } from './telegram';
import { tick, type TickResult } from './tick';

export interface Env {
  RADAR: KVNamespace;
  AI: Ai;
  AI_MODEL: string;
  MAX_CARDS_PER_TICK: string;
  VERSION: string;
  REDDIT_CLIENT_ID?: string;
  REDDIT_CLIENT_SECRET?: string;
  REDDIT_USERNAME?: string;
  REDDIT_PASSWORD?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  RUN_KEY?: string;
}

function makeSource(env: Env) {
  if (sourceKind(env) === 'rss') return new RssClient();
  const userAgent = `web:social-radar:v${env.VERSION} (by /u/${env.REDDIT_USERNAME})`;
  return new RedditClient(
    { clientId: env.REDDIT_CLIENT_ID!, clientSecret: env.REDDIT_CLIENT_SECRET!, username: env.REDDIT_USERNAME!, password: env.REDDIT_PASSWORD! },
    env.RADAR,
    userAgent,
  );
}

function runTick(env: Env): Promise<TickResult> {
  const reddit = makeSource(env);
  return tick({
    projects: PROJECTS,
    reddit,
    kv: env.RADAR,
    judge: (project, post) => judge(env.AI, env.AI_MODEL, buildMessages(project, post, Date.now())),
    send: (text) => sendTelegram(env.TELEGRAM_BOT_TOKEN ?? '', env.TELEGRAM_CHAT_ID ?? '', text),
    now: () => Date.now(),
    maxCards: Number(env.MAX_CARDS_PER_TICK) || 5,
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/health') {
      return Response.json({
        ok: true,
        version: env.VERSION,
        source: sourceKind(env),
        telegram: telegramConfigured(env),
        projects: PROJECTS.map((p) => p.slug),
      });
    }
    if (url.pathname === '/run' && req.method === 'POST') {
      if (!env.RUN_KEY || url.searchParams.get('key') !== env.RUN_KEY) return new Response('unauthorized', { status: 401 });
      return Response.json(await runTick(env));
    }
    return new Response('not found', { status: 404 });
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    // Без Telegram карточки некуда слать, а модель всё равно тратила бы нейроны — тик пропускаем.
    if (!telegramConfigured(env)) {
      console.log('tick: telegram not configured, skip');
      return;
    }
    await runTick(env);
  },
} satisfies ExportedHandler<Env>;
