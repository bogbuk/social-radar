import type { Post } from './types';

export interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}

export interface RedditAuth {
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
}

export class RedditError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'RedditError';
  }
}

export function parseListing(json: unknown): Post[] {
  const children: unknown = (json as any)?.data?.children;
  if (!Array.isArray(children)) return [];
  return children
    .filter((c: any) => c?.kind === 't3' && c.data && c.data.id)
    .map((c: any) => {
      const d = c.data;
      return {
        id: String(d.id),
        subreddit: String(d.subreddit ?? ''),
        title: String(d.title ?? ''),
        selftext: typeof d.selftext === 'string' ? d.selftext : '',
        url: `https://www.reddit.com${d.permalink ?? ''}`,
        createdUtc: Math.floor(Number(d.created_utc) || 0),
        numComments: Number(d.num_comments) || 0,
        author: String(d.author ?? ''),
      };
    });
}

const TOKEN_KEY = 'token:reddit';

// Только чтение: POST /api/v1/access_token (password grant script-app) и GET oauth.reddit.com/*.
export class RedditClient {
  constructor(
    private auth: RedditAuth,
    private kv: KVLike,
    private userAgent: string,
    private fetchFn: typeof fetch = fetch,
  ) {}

  async token(force = false): Promise<string> {
    if (!force) {
      const cached = await this.kv.get(TOKEN_KEY);
      if (cached) return cached;
    }
    const basic = btoa(`${this.auth.clientId}:${this.auth.clientSecret}`);
    const res = await this.fetchFn('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'User-Agent': this.userAgent, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'password', username: this.auth.username, password: this.auth.password }),
    });
    if (!res.ok) throw new RedditError(res.status, `token ${res.status}`);
    const json: any = await res.json();
    if (!json?.access_token) throw new RedditError(401, `token response without access_token: ${JSON.stringify(json).slice(0, 200)}`);
    const ttl = Math.max(60, (Number(json.expires_in) || 3600) - 60);
    await this.kv.put(TOKEN_KEY, json.access_token, { expirationTtl: ttl });
    return json.access_token;
  }

  async get(path: string, retry = true): Promise<unknown> {
    const token = await this.token();
    const res = await this.fetchFn(`https://oauth.reddit.com${path}`, {
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': this.userAgent },
    });
    if (res.status === 401 && retry) {
      await this.token(true);
      return this.get(path, false);
    }
    if (!res.ok) throw new RedditError(res.status, `GET ${path} ${res.status}`);
    return res.json();
  }

  async newPosts(sub: string, limit = 25): Promise<Post[]> {
    return parseListing(await this.get(`/r/${encodeURIComponent(sub)}/new?limit=${limit}&raw_json=1`));
  }

  async search(q: string, limit = 25): Promise<Post[]> {
    return parseListing(await this.get(`/search?q=${encodeURIComponent(q)}&sort=new&t=day&limit=${limit}&raw_json=1`));
  }
}
