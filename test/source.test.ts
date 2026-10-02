import { describe, it, expect } from 'vitest';
import { sourceKind, telegramConfigured } from '../src/source';

describe('sourceKind', () => {
  it('oauth only when all four Reddit secrets are present, else rss', () => {
    const full = { REDDIT_CLIENT_ID: 'a', REDDIT_CLIENT_SECRET: 'b', REDDIT_USERNAME: 'c', REDDIT_PASSWORD: 'd' };
    expect(sourceKind(full)).toBe('oauth');
    expect(sourceKind({ ...full, REDDIT_PASSWORD: '' })).toBe('rss');
    expect(sourceKind({})).toBe('rss');
  });
});

describe('telegramConfigured', () => {
  it('requires both token and chat id', () => {
    expect(telegramConfigured({ TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '1' })).toBe(true);
    expect(telegramConfigured({ TELEGRAM_BOT_TOKEN: 't' })).toBe(false);
    expect(telegramConfigured({})).toBe(false);
  });
});
