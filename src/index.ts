export interface Env {
  RADAR: KVNamespace;
  AI: Ai;
  AI_MODEL: string;
  MAX_CARDS_PER_TICK: string;
  VERSION: string;
  REDDIT_CLIENT_ID: string;
  REDDIT_CLIENT_SECRET: string;
  REDDIT_USERNAME: string;
  REDDIT_PASSWORD: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  RUN_KEY: string;
}

// ВРЕМЕННЫЙ спайк (Task 1): проверяет, что Reddit OAuth проходит с IP Cloudflare. Удаляется в Task 11.
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/health') return Response.json({ ok: true, version: env.VERSION });
    if (url.pathname === '/spike/reddit') {
      if (!env.RUN_KEY || url.searchParams.get('key') !== env.RUN_KEY) return new Response('unauthorized', { status: 401 });
      const ua = `web:social-radar:v${env.VERSION} (by /u/${env.REDDIT_USERNAME})`;
      const basic = btoa(`${env.REDDIT_CLIENT_ID}:${env.REDDIT_CLIENT_SECRET}`);
      const tokenRes = await fetch('https://www.reddit.com/api/v1/access_token', {
        method: 'POST',
        headers: { Authorization: `Basic ${basic}`, 'User-Agent': ua, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'password', username: env.REDDIT_USERNAME, password: env.REDDIT_PASSWORD }),
      });
      const tokenJson: any = await tokenRes.json().catch(() => ({}));
      if (!tokenJson.access_token) return Response.json({ tokenStatus: tokenRes.status, tokenBody: JSON.stringify(tokenJson).slice(0, 200) });
      const listing = await fetch('https://oauth.reddit.com/r/Truckers/new?limit=5&raw_json=1', {
        headers: { Authorization: `Bearer ${tokenJson.access_token}`, 'User-Agent': ua },
      });
      const body: any = await listing.json().catch(() => ({}));
      return Response.json({ tokenStatus: tokenRes.status, listingStatus: listing.status, count: body?.data?.children?.length ?? 0 });
    }
    return new Response('not found', { status: 404 });
  },
  async scheduled(): Promise<void> {},
} satisfies ExportedHandler<Env>;
