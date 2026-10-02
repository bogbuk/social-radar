export interface SourceEnv {
  REDDIT_CLIENT_ID?: string;
  REDDIT_CLIENT_SECRET?: string;
  REDDIT_USERNAME?: string;
  REDDIT_PASSWORD?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
}

export type SourceKind = 'oauth' | 'rss';

// OAuth — основной путь; пока Reddit не одобрил script-app, работаем по RSS.
export function sourceKind(env: SourceEnv): SourceKind {
  return env.REDDIT_CLIENT_ID && env.REDDIT_CLIENT_SECRET && env.REDDIT_USERNAME && env.REDDIT_PASSWORD ? 'oauth' : 'rss';
}

export function telegramConfigured(env: SourceEnv): boolean {
  return Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID);
}
