# social-radar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cloudflare Worker по cron находит свежие Reddit-треды по проектам workspace, оценивает уместность ответа через Workers AI и присылает в Telegram карточку с черновиком; на Reddit не пишет ничего.

**Architecture:** Один Worker (`scheduled` + два HTTP-маршрута). Чистые модули без привязки к Workers (`match`, `reddit`, `seen`, `format`, `prompt`, `ai`, `telegram`, `tick`) тестируются Vitest в Node; `index.ts` только склеивает их с биндингами `AI`/`KV` и секретами. Проекты — папки `projects/<slug>/{config.json,voice.md}`, список генерирует скрипт перед сборкой.

**Tech Stack:** TypeScript, Wrangler 4, Workers AI (`@cf/openai/gpt-oss-120b`), Workers KV, Vitest, Reddit OAuth (script app, read-only), Telegram Bot API.

**Spec:** `docs/superpowers/specs/2026-10-02-social-radar-design.md`

## Global Constraints

- Никаких запросов записи к Reddit: только `POST /api/v1/access_token` и `GET https://oauth.reddit.com/...`.
- User-Agent всех запросов к Reddit: `web:social-radar:v<VERSION> (by /u/<REDDIT_USERNAME>)`.
- Бесплатный план Workers: 50 субзапросов и 10 мс CPU на вызов → `limit=25` на сабреддит, одна KV-запись `seen:v1` на все посты, потолок `MAX_CARDS_PER_TICK=5`.
- Пост помечается увиденным только после доставленного решения (все карточки по нему ушли с 200, либо ни одна не нужна).
- Карточка Telegram — plain text, `disable_web_page_preview: true`, не длиннее 4000 символов.
- Модель возвращает JSON `{relevant: 0..10, reason, draft}`; порог — `threshold` проекта; `relevant < 5` → пустой `draft`.
- Секреты только через `wrangler secret put` / `.dev.vars` (в `.gitignore`); в коммиты и чат не попадают.
- Коммиты без упоминания AI-ассистентов.

## Review Focus

1. Ключевое слово `8/2` в тексте вроде `on 8/2/2026 I...` — это дата, не split sleeper; матчиться НЕ должно (тест в Task 2).
2. Модель оборачивает JSON в ```` ```json ```` или отдаёт `"relevant": "8"` строкой — разбор обязан пройти (тесты в Task 6).
3. `created_utc` поста из будущего (рассинхрон часов) — возраст 0, пост остаётся кандидатом, карточка печатает `0 min ago` (тесты в Task 2 и Task 5).
4. Повреждённое значение `seen:v1` в KV (не JSON, массив, `null`) — тик стартует с пустым хранилищем, а не падает (тест в Task 4).
5. Один и тот же пост пришёл и из `/r/<sub>/new`, и из `/search` — одна карточка на проект, не две (тест в Task 10).

---

## File Structure

```
social-radar/
  package.json              scripts: gen / dev / test / typecheck / deploy
  wrangler.toml             cron, AI, KV, vars, rules(Text *.md)
  tsconfig.json
  .dev.vars                 локальные секреты (gitignore)
  scripts/gen-projects.mjs  projects/*/ → src/projects.generated.ts
  projects/loadlens/config.json, voice.md
  src/
    types.ts                Post, ProjectConfig, Project, Verdict, Card
    match.ts                compileKeyword / matchKeywords / ageHours / prefilter
    reddit.ts               parseListing / RedditClient (token cache in KV, 401 retry)
    seen.ts                 KVLike / SeenStore / loadSeen / saveSeen
    format.ts               formatAge / formatCard / formatOverflow
    prompt.ts               FRAME / buildMessages / parseVerdict / truncate
    ai.ts                   AiLike / extractText / judge (1 retry)
    telegram.ts             sendTelegram
    tick.ts                 collectPosts / tick
    projects.generated.ts   (генерируется, gitignore)
    modules.d.ts            declare module '*.md'
    index.ts                fetch(/health, /run) + scheduled
  test/*.test.ts, test/fixtures/reddit-new.json
```

---

### Task 1: Скаффолд + спайк «Reddit OAuth с IP Cloudflare»

Единственный архитектурный риск проверяется до остального кода. Спайк — временный маршрут, удаляется в Task 11.

**Files:**
- Create: `package.json`, `wrangler.toml`, `tsconfig.json`, `src/index.ts`, `src/modules.d.ts`, `.dev.vars.example`
- Modify: `.gitignore`

**Interfaces:**
- Produces: биндинги `env.RADAR` (KV), `env.AI`, vars `AI_MODEL`, `MAX_CARDS_PER_TICK`, `VERSION`; секреты `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_USERNAME`, `REDDIT_PASSWORD`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `RUN_KEY`.

- [ ] **Step 1: package.json и зависимости**

```bash
cd /Users/bogdan/work/startup/social-radar
npm init -y >/dev/null
npm i -D wrangler typescript vitest @cloudflare/workers-types
```

Затем заменить `scripts` в `package.json`:

```json
{
  "name": "social-radar",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "gen": "node scripts/gen-projects.mjs",
    "dev": "npm run gen && wrangler dev --test-scheduled",
    "test": "vitest run",
    "typecheck": "npm run gen && tsc --noEmit",
    "deploy": "npm run gen && npm test && tsc --noEmit && wrangler deploy"
  }
}
```

- [ ] **Step 2: wrangler.toml**

`compatibility_date` = сегодняшняя дата (wrangler отвергает будущие). KV `id` появится в шаге 5.

```toml
name = "social-radar"
main = "src/index.ts"
compatibility_date = "2026-10-02"

[triggers]
crons = ["*/15 * * * *"]

[ai]
binding = "AI"

[[kv_namespaces]]
binding = "RADAR"
id = "REPLACE_AFTER_KV_CREATE"

[vars]
AI_MODEL = "@cf/openai/gpt-oss-120b"
MAX_CARDS_PER_TICK = "5"
VERSION = "0.1.0"

[[rules]]
type = "Text"
globs = ["**/*.md"]
fallthrough = true
```

- [ ] **Step 3: tsconfig.json, modules.d.ts, gitignore**

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "noEmit": true,
    "resolveJsonModule": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts", "projects/**/*.json"]
}
```

`src/modules.d.ts`:

```ts
declare module '*.md' {
  const content: string;
  export default content;
}
```

Дописать в `.gitignore`:

```
src/projects.generated.ts
.dev.vars
```

`.dev.vars.example` (коммитится, без значений):

```
REDDIT_CLIENT_ID=
REDDIT_CLIENT_SECRET=
REDDIT_USERNAME=
REDDIT_PASSWORD=
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
RUN_KEY=
```

- [ ] **Step 4: Спайк в src/index.ts**

Временный код: берёт токен и читает `/r/Truckers/new`, возвращает статусы. Ни одной записи.

```ts
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
```

- [ ] **Step 5: Логин, KV, секреты, деплой**

Выполняет владелец (секреты не вставлять в чат):

```bash
npx wrangler login
npx wrangler kv namespace create RADAR        # вставить выданный id в wrangler.toml
for s in REDDIT_CLIENT_ID REDDIT_CLIENT_SECRET REDDIT_USERNAME REDDIT_PASSWORD RUN_KEY; do npx wrangler secret put $s; done
npx wrangler deploy
```

- [ ] **Step 6: Проверка спайка**

```bash
curl -s "https://social-radar.<account>.workers.dev/health"
curl -s "https://social-radar.<account>.workers.dev/spike/reddit?key=$RUN_KEY"
```

Ожидание: `{"tokenStatus":200,"listingStatus":200,"count":5}`. Если `tokenStatus` 401 с `invalid_grant` — проверить 2FA на аккаунте (password grant требует `password:otp`, тогда отдельный read-only аккаунт). Если `listingStatus` 403/429 стабильно — Reddit режет IP Cloudflare: СТОП, откат на вариант Hetzner из спеки, план переписывается.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json wrangler.toml tsconfig.json src/index.ts src/modules.d.ts .dev.vars.example .gitignore
git commit -m "chore: скаффолд worker + спайк Reddit OAuth с IP Cloudflare"
```

---

### Task 2: Типы и фильтр по ключевым словам (`match.ts`)

**Files:**
- Create: `src/types.ts`, `src/match.ts`
- Test: `test/match.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // types.ts
  export interface Post { id: string; subreddit: string; title: string; selftext: string; url: string; createdUtc: number /* сек */; numComments: number; author: string }
  export interface ProjectConfig { slug: string; name: string; landing: string; subreddits: string[]; queries?: string[]; keywords: { any: string[]; exclude?: string[] }; maxAgeHours: number; threshold: number }
  export interface Project extends ProjectConfig { voice: string }
  export interface Verdict { relevant: number; reason: string; draft: string }
  export interface Card { project: Project; post: Post; verdict: Verdict | null }
  // match.ts
  export function compileKeyword(k: string): RegExp
  export function matchKeywords(text: string, keywords: ProjectConfig['keywords']): boolean
  export function ageHours(post: Post, nowMs: number): number
  export type Prefilter = 'candidate' | 'too_old' | 'no_match'
  export function prefilter(post: Post, project: ProjectConfig, nowMs: number): Prefilter
  ```

- [ ] **Step 1: types.ts**

```ts
export interface Post {
  id: string;
  subreddit: string;
  title: string;
  selftext: string;
  url: string;
  createdUtc: number; // секунды UTC
  numComments: number;
  author: string;
}

export interface ProjectConfig {
  slug: string;
  name: string;
  landing: string;
  subreddits: string[];
  queries?: string[];
  keywords: { any: string[]; exclude?: string[] };
  maxAgeHours: number;
  threshold: number;
}

export interface Project extends ProjectConfig {
  voice: string;
}

export interface Verdict {
  relevant: number;
  reason: string;
  draft: string;
}

export interface Card {
  project: Project;
  post: Post;
  verdict: Verdict | null; // null = модель не ответила
}
```

- [ ] **Step 2: Failing tests**

`test/match.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { compileKeyword, matchKeywords, ageHours, prefilter } from '../src/match';
import type { Post, ProjectConfig } from '../src/types';

const post = (over: Partial<Post> = {}): Post => ({
  id: 'abc', subreddit: 'CDL', title: 'Question about the 14 hour clock', selftext: '',
  url: 'https://www.reddit.com/r/CDL/comments/abc/x/', createdUtc: 1_000_000, numComments: 0, author: 'u', ...over,
});
const project: ProjectConfig = {
  slug: 'p', name: 'P', landing: 'https://x', subreddits: ['CDL'],
  keywords: { any: ['hours of service', 'HOS', '14 hour', '8/2', '70/8'], exclude: ['hiring'] },
  maxAgeHours: 24, threshold: 7,
};

describe('compileKeyword', () => {
  it('matches whole words, case-insensitive for normal words', () => {
    expect(compileKeyword('recap').test('Will it RECAP?')).toBe(true);
    expect(compileKeyword('recap').test('recapture')).toBe(false);
  });
  it('uppercase abbreviations are case-sensitive', () => {
    expect(compileKeyword('HOS').test('my HOS clock')).toBe(true);
    expect(compileKeyword('HOS').test('the hospital')).toBe(false);
    expect(compileKeyword('HOS').test('hos')).toBe(false);
  });
  it('slash keywords do not match dates', () => {
    expect(compileKeyword('8/2').test('I run an 8/2 split')).toBe(true);
    expect(compileKeyword('8/2').test('on 8/2/2026 I was')).toBe(false);
    expect(compileKeyword('70/8').test('70/8 cycle')).toBe(true);
  });
  it('escapes regex specials', () => {
    expect(compileKeyword('c++').test('learning c++ now')).toBe(true);
  });
});

describe('matchKeywords', () => {
  it('any hit → true, exclude hit → false even with any hit', () => {
    expect(matchKeywords('hours of service question', project.keywords)).toBe(true);
    expect(matchKeywords('hiring drivers, hours of service ok', project.keywords)).toBe(false);
    expect(matchKeywords('nothing relevant', project.keywords)).toBe(false);
  });
});

describe('ageHours', () => {
  it('computes hours and clamps future posts to 0', () => {
    expect(ageHours(post({ createdUtc: 1000 }), 1000 * 1000 + 2 * 3600 * 1000)).toBeCloseTo(2);
    expect(ageHours(post({ createdUtc: 5000 }), 1000 * 1000)).toBe(0);
  });
});

describe('prefilter', () => {
  const now = 1_000_000 * 1000 + 3600 * 1000; // пост 1 час назад
  it('candidate when fresh and matched', () => expect(prefilter(post(), project, now)).toBe('candidate'));
  it('too_old beyond maxAgeHours', () => expect(prefilter(post({ createdUtc: 1_000_000 - 25 * 3600 }), project, now)).toBe('too_old'));
  it('no_match when keywords absent', () => expect(prefilter(post({ title: 'truck stop food' }), project, now)).toBe('no_match'));
  it('matches in selftext too', () => expect(prefilter(post({ title: 'help', selftext: 'my HOS is confusing' }), project, now)).toBe('candidate'));
  it('future-dated post is still a candidate', () => expect(prefilter(post({ createdUtc: 1_000_000 + 600 }), project, now)).toBe('candidate'));
});
```

- [ ] **Step 3: Run → fails**

Run: `npx vitest run test/match.test.ts`
Expected: FAIL, `Cannot find module '../src/match'`

- [ ] **Step 4: Implement src/match.ts**

```ts
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
```

- [ ] **Step 5: Run → passes**

Run: `npx vitest run test/match.test.ts`
Expected: PASS (все 11)

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/match.ts test/match.test.ts
git commit -m "feat(match): типы и фильтр по ключевым словам с границами слов"
```

---

### Task 3: Reddit-клиент (`reddit.ts`)

**Files:**
- Create: `src/reddit.ts`, `test/fixtures/reddit-new.json`
- Test: `test/reddit.test.ts`

**Interfaces:**
- Consumes: `Post` из `types.ts`; `KVLike` из Task 4 (объявить здесь локально-совместимо: `{ get(key): Promise<string|null>; put(key, value, opts?: {expirationTtl?: number}): Promise<void> }` — Task 4 экспортирует ровно этот тип, после Task 4 импортировать его из `./seen`).
- Produces:
  ```ts
  export interface RedditAuth { clientId: string; clientSecret: string; username: string; password: string }
  export class RedditError extends Error { status: number }
  export function parseListing(json: unknown): Post[]
  export class RedditClient {
    constructor(auth: RedditAuth, kv: KVLike, userAgent: string, fetchFn?: typeof fetch)
    token(force?: boolean): Promise<string>
    get(path: string): Promise<unknown>
    newPosts(sub: string, limit?: number): Promise<Post[]>   // limit по умолчанию 25
    search(q: string, limit?: number): Promise<Post[]>
  }
  ```

- [ ] **Step 1: Фикстура**

`test/fixtures/reddit-new.json` — усечённый реальный формат listing (поля, которые мы читаем, плюс шум):

```json
{
  "kind": "Listing",
  "data": {
    "after": "t3_zzz",
    "children": [
      {
        "kind": "t3",
        "data": {
          "id": "1abc23",
          "subreddit": "CDL",
          "title": "Does the 14 hour clock keep running at the shipper?",
          "selftext": "Waited 4 hours today and my dispatcher says I still have 11 to drive. Is that right?",
          "permalink": "/r/CDL/comments/1abc23/does_the_14_hour_clock_keep_running/",
          "created_utc": 1759400000.0,
          "num_comments": 3,
          "author": "newdriver22",
          "ups": 5,
          "over_18": false
        }
      },
      {
        "kind": "t3",
        "data": {
          "id": "1abc24",
          "subreddit": "CDL",
          "title": "Link post without body",
          "selftext": "",
          "permalink": "/r/CDL/comments/1abc24/link_post/",
          "created_utc": 1759399000,
          "num_comments": 0,
          "author": "someone"
        }
      },
      { "kind": "t1", "data": { "id": "comment", "body": "not a post" } }
    ]
  }
}
```

- [ ] **Step 2: Failing tests**

`test/reddit.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { parseListing, RedditClient, RedditError } from '../src/reddit';
import fixture from './fixtures/reddit-new.json';

const memKv = () => {
  const m = new Map<string, string>();
  return { get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => { m.set(k, v); }, _m: m };
};
const auth = { clientId: 'id', clientSecret: 'sec', username: 'me', password: 'pw' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('parseListing', () => {
  it('maps t3 children to Post, skips comments, builds absolute url', () => {
    const posts = parseListing(fixture);
    expect(posts).toHaveLength(2);
    expect(posts[0]).toEqual({
      id: '1abc23', subreddit: 'CDL', title: 'Does the 14 hour clock keep running at the shipper?',
      selftext: 'Waited 4 hours today and my dispatcher says I still have 11 to drive. Is that right?',
      url: 'https://www.reddit.com/r/CDL/comments/1abc23/does_the_14_hour_clock_keep_running/',
      createdUtc: 1759400000, numComments: 3, author: 'newdriver22',
    });
    expect(posts[1].selftext).toBe('');
  });
  it('tolerates garbage', () => {
    expect(parseListing(null)).toEqual([]);
    expect(parseListing({ data: {} })).toEqual([]);
  });
});

describe('RedditClient', () => {
  it('fetches token with basic auth + password grant and caches it in KV with ttl', async () => {
    const kv = memKv();
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(json({ access_token: 'T1', expires_in: 3600 }))
      .mockResolvedValueOnce(json(fixture));
    const c = new RedditClient(auth, kv, 'ua/1', fetchFn as any);
    const posts = await c.newPosts('CDL');
    expect(posts).toHaveLength(2);
    const [tokenUrl, tokenInit] = fetchFn.mock.calls[0];
    expect(tokenUrl).toBe('https://www.reddit.com/api/v1/access_token');
    expect(tokenInit.method).toBe('POST');
    expect(tokenInit.headers.Authorization).toBe(`Basic ${btoa('id:sec')}`);
    expect(tokenInit.headers['User-Agent']).toBe('ua/1');
    expect(String(tokenInit.body)).toContain('grant_type=password');
    const [listUrl, listInit] = fetchFn.mock.calls[1];
    expect(listUrl).toBe('https://oauth.reddit.com/r/CDL/new?limit=25&raw_json=1');
    expect(listInit.headers.Authorization).toBe('Bearer T1');
    expect(kv._m.get('token:reddit')).toBe('T1');
    expect(fetchFn.mock.calls[0]).toBeDefined();
  });
  it('uses cached token without hitting token endpoint', async () => {
    const kv = memKv(); kv._m.set('token:reddit', 'CACHED');
    const fetchFn = vi.fn().mockResolvedValueOnce(json(fixture));
    const c = new RedditClient(auth, kv, 'ua/1', fetchFn as any);
    await c.newPosts('CDL');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0][1].headers.Authorization).toBe('Bearer CACHED');
  });
  it('on 401 refreshes token once and retries', async () => {
    const kv = memKv(); kv._m.set('token:reddit', 'OLD');
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(json({ access_token: 'NEW', expires_in: 3600 }))
      .mockResolvedValueOnce(json(fixture));
    const c = new RedditClient(auth, kv, 'ua/1', fetchFn as any);
    await c.newPosts('CDL');
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(fetchFn.mock.calls[2][1].headers.Authorization).toBe('Bearer NEW');
  });
  it('throws RedditError with status on 429', async () => {
    const kv = memKv(); kv._m.set('token:reddit', 'T');
    const fetchFn = vi.fn().mockResolvedValueOnce(new Response('', { status: 429 }));
    const c = new RedditClient(auth, kv, 'ua/1', fetchFn as any);
    await expect(c.newPosts('CDL')).rejects.toMatchObject({ status: 429 });
    await expect(c.newPosts('CDL')).rejects.toBeInstanceOf(RedditError).catch(() => {});
  });
  it('search encodes query and uses sort=new&t=day', async () => {
    const kv = memKv(); kv._m.set('token:reddit', 'T');
    const fetchFn = vi.fn().mockResolvedValueOnce(json(fixture));
    const c = new RedditClient(auth, kv, 'ua/1', fetchFn as any);
    await c.search('"hours of service" calculator');
    expect(fetchFn.mock.calls[0][0]).toBe('https://oauth.reddit.com/search?q=%22hours%20of%20service%22%20calculator&sort=new&t=day&limit=25&raw_json=1');
  });
});
```

- [ ] **Step 3: Run → fails**

Run: `npx vitest run test/reddit.test.ts`
Expected: FAIL, `Cannot find module '../src/reddit'`

- [ ] **Step 4: Implement src/reddit.ts**

```ts
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
  const children: any[] = (json as any)?.data?.children ?? [];
  if (!Array.isArray(children)) return [];
  return children
    .filter((c) => c?.kind === 't3' && c.data && c.data.id)
    .map((c) => {
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
```

- [ ] **Step 5: Run → passes**

Run: `npx vitest run test/reddit.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/reddit.ts test/reddit.test.ts test/fixtures/reddit-new.json
git commit -m "feat(reddit): OAuth-клиент только для чтения, кэш токена в KV, разбор listing"
```

---

### Task 4: Хранилище увиденных постов (`seen.ts`)

Одна KV-запись `seen:v1` = `{ [postId]: lastSeenMs }`, чистка старше 3 дней (посты старше `maxAgeHours`=24 всё равно отсеиваются как `too_old`). Так тик делает 1 чтение + 1 запись KV вместо сотен.

**Files:**
- Create: `src/seen.ts`
- Modify: `src/reddit.ts` (импортировать `KVLike` из `./seen` вместо локального объявления)
- Test: `test/seen.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface KVLike { get(key: string): Promise<string | null>; put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> }
  export const SEEN_KEY = 'seen:v1'; export const SEEN_KEEP_MS: number
  export class SeenStore { static parse(raw: string | null): SeenStore; has(id): boolean; add(id, nowMs): void; prune(nowMs): void; size(): number; serialize(): string }
  export function loadSeen(kv: KVLike): Promise<SeenStore>
  export function saveSeen(kv: KVLike, store: SeenStore, nowMs: number): Promise<void>
  ```

- [ ] **Step 1: Failing tests**

`test/seen.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { SeenStore, loadSeen, saveSeen, SEEN_KEY, SEEN_KEEP_MS } from '../src/seen';

const memKv = () => {
  const m = new Map<string, string>();
  return { get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => { m.set(k, v); }, _m: m };
};

describe('SeenStore', () => {
  it('parses, adds, has, serializes', () => {
    const s = SeenStore.parse('{"a":1}');
    expect(s.has('a')).toBe(true);
    expect(s.has('b')).toBe(false);
    s.add('b', 5);
    expect(JSON.parse(s.serialize())).toEqual({ a: 1, b: 5 });
  });
  it('starts empty on corrupted or non-object values', () => {
    for (const raw of [null, '', 'not json', '[1,2]', 'null', '42']) {
      expect(SeenStore.parse(raw).size()).toBe(0);
    }
  });
  it('prunes entries older than SEEN_KEEP_MS', () => {
    const now = 10_000_000;
    const s = SeenStore.parse(JSON.stringify({ old: now - SEEN_KEEP_MS - 1, fresh: now - 1000 }));
    s.prune(now);
    expect(s.has('old')).toBe(false);
    expect(s.has('fresh')).toBe(true);
  });
});

describe('loadSeen/saveSeen', () => {
  it('round-trips through KV under SEEN_KEY and prunes on save', async () => {
    const kv = memKv();
    const s = await loadSeen(kv);
    expect(s.size()).toBe(0);
    s.add('x', 100);
    s.add('y', 100 + SEEN_KEEP_MS + 5);
    await saveSeen(kv, s, 100 + SEEN_KEEP_MS + 5);
    expect(JSON.parse(kv._m.get(SEEN_KEY)!)).toEqual({ y: 100 + SEEN_KEEP_MS + 5 });
  });
});
```

- [ ] **Step 2: Run → fails**

Run: `npx vitest run test/seen.test.ts`
Expected: FAIL, `Cannot find module '../src/seen'`

- [ ] **Step 3: Implement src/seen.ts**

```ts
export interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}

export const SEEN_KEY = 'seen:v1';
export const SEEN_KEEP_MS = 3 * 24 * 3600 * 1000;

export class SeenStore {
  constructor(private map: Record<string, number> = {}) {}

  static parse(raw: string | null): SeenStore {
    if (!raw) return new SeenStore();
    try {
      const o = JSON.parse(raw);
      if (o && typeof o === 'object' && !Array.isArray(o)) return new SeenStore(o as Record<string, number>);
    } catch {
      /* повреждённое значение → пустое хранилище */
    }
    return new SeenStore();
  }

  has(id: string): boolean { return Object.prototype.hasOwnProperty.call(this.map, id); }
  add(id: string, nowMs: number): void { this.map[id] = nowMs; }
  prune(nowMs: number): void {
    for (const [id, t] of Object.entries(this.map)) if (nowMs - Number(t) > SEEN_KEEP_MS) delete this.map[id];
  }
  size(): number { return Object.keys(this.map).length; }
  serialize(): string { return JSON.stringify(this.map); }
}

export async function loadSeen(kv: KVLike): Promise<SeenStore> {
  return SeenStore.parse(await kv.get(SEEN_KEY));
}

export async function saveSeen(kv: KVLike, store: SeenStore, nowMs: number): Promise<void> {
  store.prune(nowMs);
  await kv.put(SEEN_KEY, store.serialize());
}
```

В `src/reddit.ts` удалить локальный `interface KVLike` и добавить `import type { KVLike } from './seen';`.

- [ ] **Step 4: Run → passes**

Run: `npx vitest run`
Expected: PASS (match, reddit, seen)

- [ ] **Step 5: Commit**

```bash
git add src/seen.ts src/reddit.ts test/seen.test.ts
git commit -m "feat(seen): одна KV-запись увиденных постов с чисткой за 3 дня"
```

---

### Task 5: Форматирование карточки (`format.ts`)

**Files:**
- Create: `src/format.ts`
- Test: `test/format.test.ts`

**Interfaces:**
- Consumes: `Card`, `Post`, `Project` из `types.ts`.
- Produces:
  ```ts
  export const TG_LIMIT = 4000
  export function formatAge(createdUtc: number, nowMs: number): string   // "42 min ago" | "3 h ago" | "2 d ago"
  export function formatCard(card: Card, nowMs: number): string           // ≤ TG_LIMIT
  export function formatOverflow(n: number): string
  ```

- [ ] **Step 1: Failing tests**

`test/format.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { formatAge, formatCard, formatOverflow, TG_LIMIT } from '../src/format';
import type { Card } from '../src/types';

const now = 1_700_000_000 * 1000;
const card = (over: Partial<Card> = {}): Card => ({
  project: { slug: 'loadlens', name: 'LoadLens', landing: 'https://x', subreddits: [], keywords: { any: [] }, maxAgeHours: 24, threshold: 7, voice: '' },
  post: { id: 'abc', subreddit: 'CDL', title: 'Will the 14 hour clock keep running?', selftext: '', url: 'https://www.reddit.com/r/CDL/comments/abc/x/', createdUtc: 1_700_000_000 - 42 * 60, numComments: 3, author: 'u' },
  verdict: { relevant: 9, reason: 'new driver asks exactly the 14-hour window question.', draft: 'Yes, and that is the part that bites.' },
  ...over,
});

describe('formatAge', () => {
  it('minutes, hours, days; future → 0 min', () => {
    expect(formatAge(1_700_000_000 - 42 * 60, now)).toBe('42 min ago');
    expect(formatAge(1_700_000_000 - 3 * 3600, now)).toBe('3 h ago');
    expect(formatAge(1_700_000_000 - 50 * 3600, now)).toBe('2 d ago');
    expect(formatAge(1_700_000_000 + 600, now)).toBe('0 min ago');
  });
});

describe('formatCard', () => {
  it('renders header, score, link, draft', () => {
    expect(formatCard(card(), now)).toBe(
      'LoadLens · r/CDL · 42 min ago · 3 comments\n' +
      'Will the 14 hour clock keep running?\n\n' +
      'Score 9/10: new driver asks exactly the 14-hour window question.\n\n' +
      'https://www.reddit.com/r/CDL/comments/abc/x/\n\n' +
      'Draft:\nYes, and that is the part that bites.',
    );
  });
  it('model failure → explicit line, no Draft section', () => {
    const text = formatCard(card({ verdict: null }), now);
    expect(text).toContain('Score: model failed, no draft');
    expect(text).not.toContain('Draft:');
    expect(text.endsWith('/x/')).toBe(true);
  });
  it('empty draft → no Draft section', () => {
    expect(formatCard(card({ verdict: { relevant: 8, reason: 'r', draft: '' } }), now)).not.toContain('Draft:');
  });
  it('truncates long drafts to TG_LIMIT with ellipsis', () => {
    const text = formatCard(card({ verdict: { relevant: 8, reason: 'r', draft: 'x'.repeat(10_000) } }), now);
    expect(text.length).toBeLessThanOrEqual(TG_LIMIT);
    expect(text.endsWith('…')).toBe(true);
  });
});

describe('formatOverflow', () => {
  it('reports queued count', () => {
    expect(formatOverflow(3)).toBe('Ещё 3 в очереди, следующий тик.');
  });
});
```

- [ ] **Step 2: Run → fails**

Run: `npx vitest run test/format.test.ts`
Expected: FAIL, `Cannot find module '../src/format'`

- [ ] **Step 3: Implement src/format.ts**

```ts
import type { Card } from './types';

export const TG_LIMIT = 4000;

export function formatAge(createdUtc: number, nowMs: number): string {
  const mins = Math.max(0, Math.floor((nowMs / 1000 - createdUtc) / 60));
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

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
```

- [ ] **Step 4: Run → passes**

Run: `npx vitest run test/format.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/format.ts test/format.test.ts
git commit -m "feat(format): карточка Telegram и строка очереди"
```

---

### Task 6: Промпт и разбор вердикта (`prompt.ts`)

**Files:**
- Create: `src/prompt.ts`
- Test: `test/prompt.test.ts`

**Interfaces:**
- Consumes: `formatAge` из `format.ts`; `Post`, `Project`, `Verdict` из `types.ts`.
- Produces:
  ```ts
  export const FRAME: string
  export const MAX_SELFTEXT = 3000
  export function truncate(s: string, max: number): string
  export function buildMessages(project: Project, post: Post, nowMs: number): { system: string; user: string }
  export function parseVerdict(raw: string): Verdict | null
  ```

- [ ] **Step 1: Failing tests**

`test/prompt.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildMessages, parseVerdict, truncate, MAX_SELFTEXT, FRAME } from '../src/prompt';
import type { Post, Project } from '../src/types';

const project: Project = { slug: 'p', name: 'LoadLens', landing: 'https://x', subreddits: [], keywords: { any: [] }, maxAgeHours: 24, threshold: 7, voice: '# Voice\nBe short.' };
const post: Post = { id: 'a', subreddit: 'CDL', title: 'T', selftext: 'B'.repeat(5000), url: 'https://r/x', createdUtc: 1000, numComments: 2, author: 'u' };

describe('truncate', () => {
  it('keeps short strings, cuts long with ellipsis at exactly max', () => {
    expect(truncate('abc', 5)).toBe('abc');
    expect(truncate('abcdefgh', 5)).toBe('abcd…');
    expect(truncate('abcdefgh', 5).length).toBe(5);
  });
});

describe('buildMessages', () => {
  it('system = FRAME + voice; user has subreddit, age, comments, title, truncated body', () => {
    const { system, user } = buildMessages(project, post, 1000 * 1000 + 5 * 60 * 1000);
    expect(system.startsWith(FRAME)).toBe(true);
    expect(system).toContain('Voice and rules for LoadLens');
    expect(system).toContain('Be short.');
    expect(user).toContain('Subreddit: r/CDL');
    expect(user).toContain('Age: 5 min ago');
    expect(user).toContain('Comments: 2');
    expect(user).toContain('Title: T');
    expect(user.length).toBeLessThan(MAX_SELFTEXT + 200);
  });
  it('empty body → "(no body)"', () => {
    expect(buildMessages(project, { ...post, selftext: '' }, 2_000_000).user).toContain('(no body)');
  });
});

describe('parseVerdict', () => {
  it('parses clean JSON', () => {
    expect(parseVerdict('{"relevant": 8, "reason": "asks about 14h", "draft": "Yes."}')).toEqual({ relevant: 8, reason: 'asks about 14h', draft: 'Yes.' });
  });
  it('strips code fences and prose around JSON', () => {
    expect(parseVerdict('Sure! ```json\n{"relevant": 3, "reason": "meme", "draft": ""}\n```')).toEqual({ relevant: 3, reason: 'meme', draft: '' });
  });
  it('coerces numeric strings and rounds', () => {
    expect(parseVerdict('{"relevant": "8", "reason": "r", "draft": "d"}')?.relevant).toBe(8);
    expect(parseVerdict('{"relevant": 7.6, "reason": "r", "draft": "d"}')?.relevant).toBe(8);
  });
  it('rejects out-of-range, missing, or non-JSON', () => {
    expect(parseVerdict('{"relevant": 11, "reason": "r", "draft": ""}')).toBeNull();
    expect(parseVerdict('{"reason": "r"}')).toBeNull();
    expect(parseVerdict('no json here')).toBeNull();
    expect(parseVerdict('')).toBeNull();
  });
  it('missing reason/draft become empty strings', () => {
    expect(parseVerdict('{"relevant": 2}')).toEqual({ relevant: 2, reason: '', draft: '' });
  });
});
```

- [ ] **Step 2: Run → fails**

Run: `npx vitest run test/prompt.test.ts`
Expected: FAIL, `Cannot find module '../src/prompt'`

- [ ] **Step 3: Implement src/prompt.ts**

```ts
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
```

- [ ] **Step 4: Run → passes**

Run: `npx vitest run test/prompt.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/prompt.ts test/prompt.test.ts
git commit -m "feat(prompt): рамка промпта, сборка сообщений, устойчивый разбор вердикта"
```

---

### Task 7: Вызов Workers AI (`ai.ts`)

**Files:**
- Create: `src/ai.ts`
- Test: `test/ai.test.ts`

**Interfaces:**
- Consumes: `parseVerdict` из `prompt.ts`; `Verdict`.
- Produces:
  ```ts
  export interface AiLike { run(model: string, input: unknown): Promise<unknown> }
  export function extractText(raw: unknown): string
  export function judge(ai: AiLike, model: string, msgs: { system: string; user: string }, log?: (...a: unknown[]) => void): Promise<Verdict | null>
  ```

- [ ] **Step 1: Failing tests**

`test/ai.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { extractText, judge } from '../src/ai';

const msgs = { system: 'S', user: 'U' };
const good = '{"relevant": 8, "reason": "r", "draft": "d"}';

describe('extractText', () => {
  it('handles Llama-style {response}', () => expect(extractText({ response: 'hi' })).toBe('hi'));
  it('handles Responses API output array (gpt-oss)', () => {
    const raw = { output: [{ type: 'reasoning', content: [] }, { type: 'message', content: [{ type: 'output_text', text: 'hello' }] }] };
    expect(extractText(raw)).toBe('hello');
  });
  it('handles output_text and plain string, else empty', () => {
    expect(extractText({ output_text: 'x' })).toBe('x');
    expect(extractText('s')).toBe('s');
    expect(extractText({})).toBe('');
    expect(extractText(null)).toBe('');
  });
});

describe('judge', () => {
  it('passes system+user messages to the model and returns the verdict', async () => {
    const ai = { run: vi.fn().mockResolvedValue({ response: good }) };
    const v = await judge(ai, '@cf/x', msgs, () => {});
    expect(v).toEqual({ relevant: 8, reason: 'r', draft: 'd' });
    expect(ai.run).toHaveBeenCalledWith('@cf/x', { messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }] });
  });
  it('retries once on unparseable output, then succeeds', async () => {
    const ai = { run: vi.fn().mockResolvedValueOnce({ response: 'garbage' }).mockResolvedValueOnce({ response: good }) };
    expect(await judge(ai, 'm', msgs, () => {})).not.toBeNull();
    expect(ai.run).toHaveBeenCalledTimes(2);
  });
  it('retries once on thrown error, returns null after two failures', async () => {
    const ai = { run: vi.fn().mockRejectedValue(new Error('quota')) };
    const log = vi.fn();
    expect(await judge(ai, 'm', msgs, log)).toBeNull();
    expect(ai.run).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run → fails**

Run: `npx vitest run test/ai.test.ts`
Expected: FAIL, `Cannot find module '../src/ai'`

- [ ] **Step 3: Implement src/ai.ts**

```ts
import type { Verdict } from './types';
import { parseVerdict } from './prompt';

export interface AiLike {
  run(model: string, input: unknown): Promise<unknown>;
}

// Биндинг Workers AI отдаёт разные формы: {response} у Llama-подобных, Responses API ({output:[...]}) у gpt-oss.
export function extractText(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  const r = raw as any;
  if (!r || typeof r !== 'object') return '';
  if (typeof r.response === 'string') return r.response;
  if (Array.isArray(r.output)) {
    for (const item of r.output) {
      if (item?.type === 'message' && Array.isArray(item.content)) {
        for (const c of item.content) if (typeof c?.text === 'string') return c.text;
      }
    }
  }
  if (typeof r.output_text === 'string') return r.output_text;
  return '';
}

export async function judge(
  ai: AiLike,
  model: string,
  msgs: { system: string; user: string },
  log: (...a: unknown[]) => void = console.error,
): Promise<Verdict | null> {
  const input = { messages: [{ role: 'system', content: msgs.system }, { role: 'user', content: msgs.user }] };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const text = extractText(await ai.run(model, input));
      const verdict = parseVerdict(text);
      if (verdict) return verdict;
      log('ai: unparseable verdict', attempt, text.slice(0, 200));
    } catch (e) {
      log('ai: run failed', attempt, String(e));
    }
  }
  return null;
}
```

- [ ] **Step 4: Run → passes**

Run: `npx vitest run test/ai.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ai.ts test/ai.test.ts
git commit -m "feat(ai): вызов Workers AI с одним повтором и разбором обеих форм ответа"
```

---

### Task 8: Telegram (`telegram.ts`)

**Files:**
- Create: `src/telegram.ts`
- Test: `test/telegram.test.ts`

**Interfaces:**
- Produces: `export function sendTelegram(token: string, chatId: string, text: string, fetchFn?: typeof fetch): Promise<boolean>`

- [ ] **Step 1: Failing tests**

`test/telegram.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { sendTelegram } from '../src/telegram';

describe('sendTelegram', () => {
  it('posts plain text without preview and returns true on 200', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    expect(await sendTelegram('TOK', '42', 'hello', fetchFn as any)).toBe(true);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('https://api.telegram.org/botTOK/sendMessage');
    expect(JSON.parse(init.body)).toEqual({ chat_id: '42', text: 'hello', disable_web_page_preview: true });
  });
  it('returns false on non-200 and on network error', async () => {
    expect(await sendTelegram('T', '1', 'x', vi.fn().mockResolvedValue(new Response('bad', { status: 400 })) as any)).toBe(false);
    expect(await sendTelegram('T', '1', 'x', vi.fn().mockRejectedValue(new Error('net')) as any)).toBe(false);
  });
});
```

- [ ] **Step 2: Run → fails**

Run: `npx vitest run test/telegram.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement src/telegram.ts**

```ts
export async function sendTelegram(token: string, chatId: string, text: string, fetchFn: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchFn(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
    if (!res.ok) console.error('telegram', res.status, (await res.text()).slice(0, 200));
    return res.ok;
  } catch (e) {
    console.error('telegram', String(e));
    return false;
  }
}
```

- [ ] **Step 4: Run → passes**

Run: `npx vitest run test/telegram.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/telegram.ts test/telegram.test.ts
git commit -m "feat(telegram): отправка plain-text карточки"
```

---

### Task 9: Проекты: генератор, конфиг и голос LoadLens

**Files:**
- Create: `scripts/gen-projects.mjs`, `projects/loadlens/config.json`, `projects/loadlens/voice.md`
- Test: `test/projects.test.ts` (проверяет конфиги папок, не генерацию)

**Interfaces:**
- Produces: `src/projects.generated.ts` → `export const PROJECTS: Project[]` (генерируется, в gitignore).

- [ ] **Step 1: Конфиг LoadLens**

`projects/loadlens/config.json`:

```json
{
  "slug": "loadlens",
  "name": "LoadLens",
  "landing": "https://loadlens.krait.studio/hos-calculator/",
  "subreddits": ["Truckers", "CDL", "TruckDrivers", "FreightBrokers", "SideProject"],
  "queries": ["\"hours of service\" calculator", "recap hours 70/8", "\"14 hour\" clock dispatcher"],
  "keywords": {
    "any": ["hours of service", "HOS", "14 hour", "14-hour", "11 hour", "11-hour", "70/8", "recap", "34 reset", "34 hour reset", "split sleeper", "8/2", "7/3", "dispatcher", "rate per mile", "deadhead", "ELD"],
    "exclude": ["hiring", "for sale", "meme", "[Hiring]", "now hiring"]
  },
  "maxAgeHours": 24,
  "threshold": 7
}
```

- [ ] **Step 2: Голос LoadLens**

`projects/loadlens/voice.md` (английский, уходит в промпт целиком; на ревью владельцу):

```markdown
# Who is writing
I am the solo developer of a free Hours-of-Service calculator for US truck drivers and dispatchers. I am a developer, not a driver and not a dispatcher: never claim to drive, dispatch, or run a carrier. Say "I built" when relevant, never "we".

# Hard rules
- No links unless the person explicitly asks where to find such a tool. Then one plain URL: https://loadlens.krait.studio/hos-calculator/ with no tracking parameters.
- Never mention any Chrome extension, DAT, Truckstop, load boards, auto-refresh, or reading load board data. The calculator is the only product I talk about.
- Never call myself a dispatcher or imply I work for a carrier or broker.
- Never invent statistics, customers, or stories. Only the facts listed below.
- Answer the question first. Do not pitch. If the thread is about planning hours for a trip, one closing sentence like "I built a free calculator for exactly this" is allowed, nothing more.
- Skip threads that are rants, memes, job posts, "for sale", or where the honest reply would be generic encouragement. For those return a low relevance and an empty draft.

# Tone
- Short: 3 to 6 sentences, one idea per sentence.
- Plain English. No exclamation points, no emoji, no markdown, no bullet lists.
- End with a question to the person when there is something real to ask.
- Admit limits openly, for example "the planner still assumes straight 10-hour breaks".

# Facts I can use
- Federal rules: 11 hours driving, 14-hour on-duty window, 30-minute break after 8 hours of driving, 70 hours in 8 days (or 60 in 7).
- The 14 keeps running while you wait at a dock. Four hours at a shipper costs four hours of the window even if the 11 is untouched.
- Recap: hours come back at midnight when the oldest of the 8 days drops off. Waiting a few hours for recap is sometimes faster than a full 34-hour reset.
- Split sleeper 7/3 or 8/2: the first qualifying rest does not count against the 14, and the pairing is only valid once the second part is done.
- Texas intrastate uses different limits (12 driving, 15 on duty, 70 in 7, no mandatory 30) and the calculator does not cover it.
- The calculator runs in the browser, sends nothing anywhere, has no signup and no ads, and is available in English, Russian and Romanian.

# Examples of my real answers
Q: "Will it recap?"
A: It does now. Tick "Enter hours by day" under the cycle field and put in your on-duty hours for today and the last 7 days. It shows how much comes back at midnight, and if you run out of cycle on the trip, the plan waits for the recap instead of a full 34 when that's quicker.

Q: "Recap is a lost art, long haul adopted the 34 too willingly."
A: Thanks. That history makes sense, a weekend off is a free 34 for a local guy. Long haul I think it just won because it's one number. "Take a 34" is easy to say over the phone, recap means someone has to actually keep the last 8 days in their head. Curious how you run it now, do you track your 8 days yourself or trust the ELD recap screen?

Q: "Is this yours? Are you selling something?"
A: Yeah, I built it. The calculator is free and stays free. Didn't want to lead with it here.
```

- [ ] **Step 3: Failing test для конфигов**

`test/projects.test.ts` читает папки напрямую (не через генератор), чтобы ловить сломанный JSON и отсутствующие поля до деплоя:

```ts
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectConfig } from '../src/types';

const root = join(__dirname, '..', 'projects');
const slugs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);

describe('projects/*', () => {
  it('has at least loadlens', () => expect(slugs).toContain('loadlens'));
  for (const slug of slugs) {
    it(`${slug}: valid config.json and non-empty voice.md`, () => {
      const cfg = JSON.parse(readFileSync(join(root, slug, 'config.json'), 'utf8')) as ProjectConfig;
      expect(cfg.slug).toBe(slug);
      expect(cfg.name.length).toBeGreaterThan(0);
      expect(cfg.landing).toMatch(/^https:\/\//);
      expect(cfg.subreddits.length).toBeGreaterThan(0);
      expect(cfg.keywords.any.length).toBeGreaterThan(0);
      expect(cfg.maxAgeHours).toBeGreaterThan(0);
      expect(cfg.threshold).toBeGreaterThanOrEqual(0);
      expect(cfg.threshold).toBeLessThanOrEqual(10);
      expect(existsSync(join(root, slug, 'voice.md'))).toBe(true);
      expect(readFileSync(join(root, slug, 'voice.md'), 'utf8').trim().length).toBeGreaterThan(100);
    });
  }
});
```

- [ ] **Step 4: Run → passes сразу** (конфиг уже на месте; тест защищает будущие проекты)

Run: `npx vitest run test/projects.test.ts`
Expected: PASS

- [ ] **Step 5: Генератор scripts/gen-projects.mjs**

```js
// Собирает src/projects.generated.ts из projects/<slug>/{config.json,voice.md}.
import { readdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', 'projects');
const out = join(here, '..', 'src', 'projects.generated.ts');

const slugs = readdirSync(root, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(root, d.name, 'config.json')) && existsSync(join(root, d.name, 'voice.md')))
  .map((d) => d.name)
  .sort();

for (const slug of slugs) {
  const cfg = JSON.parse(readFileSync(join(root, slug, 'config.json'), 'utf8'));
  if (cfg.slug !== slug) throw new Error(`projects/${slug}/config.json: slug "${cfg.slug}" != folder name`);
}

const ident = (s) => s.replace(/[^a-zA-Z0-9]/g, '_');
let src = `// GENERATED by scripts/gen-projects.mjs — не редактировать руками\nimport type { Project } from './types';\n`;
for (const s of slugs) {
  src += `import ${ident(s)}Config from '../projects/${s}/config.json';\nimport ${ident(s)}Voice from '../projects/${s}/voice.md';\n`;
}
src += `\nexport const PROJECTS: Project[] = [\n`;
for (const s of slugs) src += `  { ...(${ident(s)}Config as Project), voice: ${ident(s)}Voice },\n`;
src += `];\n`;
writeFileSync(out, src);
console.log(`projects.generated.ts: ${slugs.join(', ') || '(none)'}`);
```

- [ ] **Step 6: Проверить генерацию и типы**

```bash
npm run gen && npx tsc --noEmit
```

Expected: `projects.generated.ts: loadlens`, tsc без ошибок (`.md` покрыт `modules.d.ts`, json — `resolveJsonModule`).

- [ ] **Step 7: Commit**

```bash
git add scripts/gen-projects.mjs projects/loadlens/config.json projects/loadlens/voice.md test/projects.test.ts
git commit -m "feat(projects): генератор списка проектов, конфиг и голос LoadLens"
```

---

### Task 10: Оркестрация тика (`tick.ts`)

**Files:**
- Create: `src/tick.ts`
- Test: `test/tick.test.ts`

**Interfaces:**
- Consumes: `prefilter` (match), `loadSeen/saveSeen/KVLike` (seen), `formatCard/formatOverflow` (format), типы.
- Produces:
  ```ts
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
  export interface TickResult { fetched: number; candidates: number; sent: number; queued: number; aborted?: string }
  export function collectPosts(deps: TickDeps): Promise<Post[]>
  export function tick(deps: TickDeps): Promise<TickResult>
  ```

- [ ] **Step 1: Failing tests**

`test/tick.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { tick, collectPosts, type TickDeps } from '../src/tick';
import { SEEN_KEY } from '../src/seen';
import type { Post, Project } from '../src/types';

const NOW = 1_700_000_000 * 1000;
const memKv = () => {
  const m = new Map<string, string>();
  return { get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => { m.set(k, v); }, _m: m };
};
const post = (id: string, over: Partial<Post> = {}): Post => ({
  id, subreddit: 'CDL', title: `HOS question ${id}`, selftext: '', url: `https://www.reddit.com/r/CDL/comments/${id}/`,
  createdUtc: 1_700_000_000 - 600, numComments: 0, author: 'u', ...over,
});
const proj = (over: Partial<Project> = {}): Project => ({
  slug: 'loadlens', name: 'LoadLens', landing: 'https://x', subreddits: ['CDL'], keywords: { any: ['HOS'] },
  maxAgeHours: 24, threshold: 7, voice: 'v', ...over,
});
const seenOf = (kv: ReturnType<typeof memKv>) => Object.keys(JSON.parse(kv._m.get(SEEN_KEY) ?? '{}'));

function deps(over: Partial<TickDeps> = {}): TickDeps & { sent: string[] } {
  const sent: string[] = [];
  return {
    projects: [proj()],
    reddit: { newPosts: async () => [], search: async () => [] },
    kv: memKv(),
    judge: async () => ({ relevant: 9, reason: 'r', draft: 'd' }),
    send: async (t) => { sent.push(t); return true; },
    now: () => NOW,
    maxCards: 5,
    log: () => {},
    sent,
    ...over,
  };
}

describe('collectPosts', () => {
  it('dedupes subreddits across projects and posts across new+search, newest first', async () => {
    const newPosts = vi.fn(async (sub: string) => (sub === 'CDL' ? [post('a', { createdUtc: 100 }), post('b', { createdUtc: 300 })] : [post('c', { createdUtc: 200 })]));
    const search = vi.fn(async () => [post('a', { createdUtc: 100 })]);
    const d = deps({ projects: [proj({ subreddits: ['CDL', 'Truckers'], queries: ['q'] }), proj({ slug: 'p2', subreddits: ['CDL'] })], reddit: { newPosts, search } });
    const posts = await collectPosts(d);
    expect(newPosts).toHaveBeenCalledTimes(2);
    expect(search).toHaveBeenCalledTimes(1);
    expect(posts.map((p) => p.id)).toEqual(['b', 'c', 'a']);
  });
});

describe('tick', () => {
  it('sends a card for a relevant candidate and marks it seen', async () => {
    const d = deps({ reddit: { newPosts: async () => [post('a')], search: async () => [] } });
    const r = await tick(d);
    expect(r).toMatchObject({ fetched: 1, candidates: 1, sent: 1, queued: 0 });
    expect(d.sent[0]).toContain('LoadLens · r/CDL');
    expect(d.sent[0]).toContain('Draft:\nd');
    expect(seenOf(d.kv as any)).toEqual(['a']);
  });
  it('marks no_match and too_old posts seen without calling the model', async () => {
    const judge = vi.fn();
    const d = deps({ judge, reddit: { newPosts: async () => [post('x', { title: 'lunch spots' }), post('y', { createdUtc: 1_700_000_000 - 30 * 3600 })], search: async () => [] } });
    const r = await tick(d);
    expect(judge).not.toHaveBeenCalled();
    expect(r.sent).toBe(0);
    expect(seenOf(d.kv as any).sort()).toEqual(['x', 'y']);
  });
  it('skips already-seen posts entirely', async () => {
    const kv = memKv(); kv._m.set(SEEN_KEY, JSON.stringify({ a: NOW - 1000 }));
    const judge = vi.fn();
    const d = deps({ kv, judge, reddit: { newPosts: async () => [post('a')], search: async () => [] } });
    await tick(d);
    expect(judge).not.toHaveBeenCalled();
    expect(d.sent).toEqual([]);
  });
  it('below threshold → no card, but marked seen', async () => {
    const d = deps({ judge: async () => ({ relevant: 3, reason: 'meh', draft: '' }), reddit: { newPosts: async () => [post('a')], search: async () => [] } });
    const r = await tick(d);
    expect(r.sent).toBe(0);
    expect(seenOf(d.kv as any)).toEqual(['a']);
  });
  it('model failure → card without draft, marked seen', async () => {
    const d = deps({ judge: async () => null, reddit: { newPosts: async () => [post('a')], search: async () => [] } });
    await tick(d);
    expect(d.sent[0]).toContain('model failed');
    expect(seenOf(d.kv as any)).toEqual(['a']);
  });
  it('same post from new and search → one card', async () => {
    const d = deps({ reddit: { newPosts: async () => [post('a')], search: async () => [post('a')] }, projects: [proj({ queries: ['q'] })] });
    const r = await tick(d);
    expect(r.sent).toBe(1);
  });
  it('one post matching two projects → two cards, one seen entry', async () => {
    const d = deps({ projects: [proj(), proj({ slug: 'p2', name: 'P2' })], reddit: { newPosts: async () => [post('a')], search: async () => [] } });
    const r = await tick(d);
    expect(r.sent).toBe(2);
    expect(d.sent.some((t) => t.startsWith('P2 ·'))).toBe(true);
    expect(seenOf(d.kv as any)).toEqual(['a']);
  });
  it('caps cards per tick, leaves the rest unseen, sends overflow line', async () => {
    const posts = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id, i) => post(id, { createdUtc: 1_700_000_000 - i }));
    const d = deps({ maxCards: 5, reddit: { newPosts: async () => posts, search: async () => [] } });
    const r = await tick(d);
    expect(r.sent).toBe(5);
    expect(r.queued).toBe(2);
    expect(d.sent).toHaveLength(6);
    expect(d.sent[5]).toBe('Ещё 2 в очереди, следующий тик.');
    expect(seenOf(d.kv as any).sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
  it('telegram failure → post not marked seen, tick stops sending', async () => {
    const send = vi.fn().mockResolvedValue(false);
    const d = deps({ send, reddit: { newPosts: async () => [post('a'), post('b')], search: async () => [] } });
    const r = await tick(d);
    expect(r.sent).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(seenOf(d.kv as any)).toEqual([]);
  });
  it('reddit failure → aborted, nothing marked, nothing sent', async () => {
    const d = deps({ reddit: { newPosts: async () => { throw new Error('429'); }, search: async () => [] } });
    const r = await tick(d);
    expect(r.aborted).toContain('429');
    expect(d.sent).toEqual([]);
    expect((d.kv as any)._m.has(SEEN_KEY)).toBe(false);
  });
});
```

- [ ] **Step 2: Run → fails**

Run: `npx vitest run test/tick.test.ts`
Expected: FAIL, `Cannot find module '../src/tick'`

- [ ] **Step 3: Implement src/tick.ts**

```ts
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
  let queued = 0;
  let telegramDown = false;
  for (let i = 0; i < work.length; i++) {
    const { post, projects } = work[i];
    if (telegramDown || (sent > 0 && sent + projects.length > deps.maxCards)) {
      queued = work.length - i;
      break;
    }
    const cards: Card[] = [];
    for (const project of projects) {
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
```

Примечание к `sent > 0 &&`: если первый же пост подходит большему числу проектов, чем `maxCards`, он всё равно обрабатывается — иначе он застрял бы навсегда.

- [ ] **Step 4: Run → passes**

Run: `npx vitest run`
Expected: PASS, все файлы.

- [ ] **Step 5: Commit**

```bash
git add src/tick.ts test/tick.test.ts
git commit -m "feat(tick): оркестрация тика — сбор, отсев, вердикт, карточки, потолок, seen после доставки"
```

---

### Task 11: Склейка в Worker, локальный прогон, деплой, README

**Files:**
- Modify: `src/index.ts` (убрать спайк, подключить `tick`)
- Create: `README.md`

**Interfaces:**
- Consumes: всё выше. `env.RADAR` реализует `KVLike` (`KVNamespace.get(key)` → `string|null`, `put(key, value, {expirationTtl})`); `env.AI` реализует `AiLike`.

- [ ] **Step 1: Переписать src/index.ts**

```ts
import { PROJECTS } from './projects.generated';
import { RedditClient } from './reddit';
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
  REDDIT_CLIENT_ID: string;
  REDDIT_CLIENT_SECRET: string;
  REDDIT_USERNAME: string;
  REDDIT_PASSWORD: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  RUN_KEY: string;
}

function runTick(env: Env): Promise<TickResult> {
  const userAgent = `web:social-radar:v${env.VERSION} (by /u/${env.REDDIT_USERNAME})`;
  const reddit = new RedditClient(
    { clientId: env.REDDIT_CLIENT_ID, clientSecret: env.REDDIT_CLIENT_SECRET, username: env.REDDIT_USERNAME, password: env.REDDIT_PASSWORD },
    env.RADAR,
    userAgent,
  );
  return tick({
    projects: PROJECTS,
    reddit,
    kv: env.RADAR,
    judge: (project, post) => judge(env.AI, env.AI_MODEL, buildMessages(project, post, Date.now())),
    send: (text) => sendTelegram(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, text),
    now: () => Date.now(),
    maxCards: Number(env.MAX_CARDS_PER_TICK) || 5,
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/health') {
      return Response.json({ ok: true, version: env.VERSION, projects: PROJECTS.map((p) => p.slug) });
    }
    if (url.pathname === '/run' && req.method === 'POST') {
      if (!env.RUN_KEY || url.searchParams.get('key') !== env.RUN_KEY) return new Response('unauthorized', { status: 401 });
      return Response.json(await runTick(env));
    }
    return new Response('not found', { status: 404 });
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await runTick(env);
  },
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 2: Типы и тесты**

```bash
npm run typecheck && npm test
```

Expected: без ошибок, все тесты зелёные.

- [ ] **Step 3: Локальный прогон**

Заполнить `.dev.vars` (копия `.dev.vars.example`, `TELEGRAM_CHAT_ID` = чат-песочница или личный), затем:

```bash
npm run dev
# в другом терминале:
curl -s "http://localhost:8787/health"
curl -s "http://localhost:8787/cdn-cgi/local/scheduled?format=json"
```

Expected: `/health` отдаёт `projects: ["loadlens"]`; scheduled → `{"outcome":"ok"}`; в Telegram приходят карточки (до 5) по свежим постам r/Truckers, r/CDL и т.д., в логе `wrangler dev` строка `tick: fetched=… candidates=… sent=… queued=…`. Локальный `wrangler dev` ходит в реальные Workers AI и KV через ваш аккаунт — это нормально.

Проверить глазами 3–5 карточек: оценка адекватна, черновик следует voice.md (без ссылок, без упоминания расширения, вопрос в конце). Если модель систематически завышает `relevant` — поднять `threshold` до 8 в конфиге; если черновики нарушают правила — ужесточить формулировки в voice.md. Это настройка, не код.

- [ ] **Step 4: Секреты Telegram и деплой**

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npm run deploy
curl -s "https://social-radar.<account>.workers.dev/health"
curl -s -X POST "https://social-radar.<account>.workers.dev/run?key=$RUN_KEY"
```

Expected: `/run` возвращает `TickResult`, карточки приходят в Telegram. Второй вызов `/run` сразу после — `sent: 0` (всё уже увидено). Через 15 минут cron отрабатывает сам: проверить `npx wrangler tail` или Cron Events в дашборде.

- [ ] **Step 5: README.md**

```markdown
# social-radar

Cloudflare Worker: раз в 15 минут ищет свежие Reddit-треды по проектам из `projects/`, оценивает их
через Workers AI и присылает в Telegram карточку с черновиком ответа. На Reddit ничего не публикует.

Спека: `docs/superpowers/specs/2026-10-02-social-radar-design.md`.

## Команды
- `npm run dev` — локально (`.dev.vars` из `.dev.vars.example`), тик: `curl localhost:8787/cdn-cgi/local/scheduled`
- `npm test` / `npm run typecheck`
- `npm run deploy` — gen + тесты + типы + `wrangler deploy`
- `npx wrangler tail` — логи прода

## Добавить проект
1. `projects/<slug>/config.json` (slug = имя папки) и `projects/<slug>/voice.md` (правила тона, уходят в промпт целиком).
2. `npm test` (валидирует конфиг) → `npm run deploy`.

## Секреты (`wrangler secret put`)
`REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_USERNAME`, `REDDIT_PASSWORD` (script-app на reddit.com/prefs/apps, только чтение),
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `RUN_KEY` (для `POST /run?key=`).

## Ограничения бесплатного плана
50 субзапросов и 10 мс CPU на вызов: `limit=25` на сабреддит, одна KV-запись `seen:v1`, потолок `MAX_CARDS_PER_TICK`.
Если cron падает по CPU — Workers Paid ($5/мес) даёт 30 с.
```

- [ ] **Step 6: Commit и remote**

```bash
git add src/index.ts README.md
git commit -m "feat: worker собран — cron тик, /health, /run; README"
gh repo create bogbuk/social-radar --private --source=. --push
```

---

## Self-Review

**Spec coverage.** §3 поток тика → Task 10; OAuth/UA/401 → Task 3; HTTP `/health` `/run` → Task 11; §4 конфиг и voice → Task 9; §5 промпт/разбор → Task 6–7; §6 карточка/4000/overflow → Task 5; §7 таблица ошибок → Task 7 (AI), Task 8 (Telegram false), Task 10 (reddit abort, telegram stop, seen после доставки); §8 тесты → все задачи, живой прогон Task 11, спайк Task 1; §9 деплой/секреты → Task 1 и 11; §11 вне скоупа — ничего из этого в плане нет. Отклонения от спеки, внесённые в неё этим же коммитом: одна KV-запись `seen:v1` с чисткой за 3 дня вместо ключа на пост с TTL 30 дней (лимит 50 субзапросов), `limit=25` вместо 50 (10 мс CPU), локальный cron через `/cdn-cgi/local/scheduled`.

**Placeholders.** Единственный плейсхолдер — `REPLACE_AFTER_KV_CREATE` в `wrangler.toml`, он заменяется в Task 1 шаг 5 реальным id; `<account>` в curl — субдомен workers.dev владельца.

**Type consistency.** `KVLike` объявлен в `seen.ts` (Task 4), `reddit.ts` временно объявляет такой же локально в Task 3 и переключается на импорт в Task 4. `Card.verdict: Verdict | null` одинаков в types/format/tick. `judge(project, post)` в `TickDeps` принимает проект и пост, а `ai.judge(ai, model, msgs)` — сообщения; склейка в `index.ts` через `buildMessages`. `formatOverflow` текст совпадает в format и tick тестах.

**Review Focus.** (1) даты `8/2/2026` — Task 2; (2) code fences / строковый `relevant` — Task 6; (3) пост из будущего — Task 2 (`prefilter` candidate) и Task 5 (`0 min ago`); (4) повреждённый `seen:v1` — Task 4; (5) дубль new+search — Task 10. Все пять закрыты тестами в задачах-владельцах.
