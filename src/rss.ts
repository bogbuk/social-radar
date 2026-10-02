import type { Post } from './types';

// Запасной источник без OAuth: Atom-лента /r/<sub>/new.rss (публичный JSON Reddit отдаёт 403, RSS — 200
// с браузерным UA). Поиска нет, число комментариев не отдаётся. Только чтение.

export class RssError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'RssError';
  }
}

const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function unescapeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

const tag = (xml: string, name: string): string | null => {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? m[1] : null;
};

// Содержимое Reddit — HTML, экранированный внутри XML: сначала снимаем XML-слой, потом HTML → текст.
function htmlToText(escapedHtml: string): string {
  let html = unescapeXml(escapedHtml);
  html = html.replace(/<!--\s*SC_ON\s*-->[\s\S]*$/, ''); // хвост "submitted by … [link] [comments]"
  html = html.replace(/<!--[\s\S]*?-->/g, '');
  html = html.replace(/<\/(p|li|div|br|h\d)>|<br\s*\/?>/gi, '\n');
  html = html.replace(/<[^>]+>/g, '');
  return unescapeXml(html).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function parseAtom(xml: string, subreddit: string): Post[] {
  const entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? [];
  const posts: Post[] = [];
  for (const e of entries) {
    const rawId = tag(e, 'id');
    if (!rawId) continue;
    const id = rawId.trim().replace(/^t3_/, '');
    const link = /<link[^>]*\shref="([^"]+)"/.exec(e)?.[1] ?? '';
    const when = tag(e, 'published') ?? tag(e, 'updated') ?? '';
    const createdMs = Date.parse(when.trim());
    const author = (tag(e, 'name') ?? '').trim().replace(/^\/u\//, '');
    const content = tag(e, 'content');
    posts.push({
      id,
      subreddit,
      title: unescapeXml(tag(e, 'title') ?? '').trim(),
      selftext: content ? htmlToText(content) : '',
      url: unescapeXml(link),
      createdUtc: Number.isFinite(createdMs) ? Math.floor(createdMs / 1000) : 0,
      numComments: 0,
      author,
    });
  }
  return posts;
}

// Reddit без авторизации: ~1 запрос в 30 с с одного IP (x-ratelimit-remaining=0 после первого же).
export const RSS_MIN_GAP_MS = 31_000;

export class RssClient {
  private chain: Promise<unknown> = Promise.resolve();
  private lastAt = 0;

  // Не `= fetch`: вызов this.fetchFn(...) передал бы экземпляр как this → Illegal invocation в Workers.
  constructor(
    private fetchFn: typeof fetch = (input, init) => fetch(input, init),
    private minGapMs: number = RSS_MIN_GAP_MS,
  ) {}

  // Запросы строго по одному, с паузой minGapMs между стартами (ожидание — не CPU-время Workers).
  private paced<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      const wait = this.lastAt + this.minGapMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastAt = Date.now();
      return fn();
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  newPosts(sub: string, limit = 25): Promise<Post[]> {
    return this.paced(() => this.fetchNew(sub, limit));
  }

  private async fetchNew(sub: string, limit: number): Promise<Post[]> {
    const res = await this.fetchFn(`https://www.reddit.com/r/${encodeURIComponent(sub)}/new.rss?limit=${limit}`, {
      headers: { 'User-Agent': BROWSER_UA, Accept: 'application/atom+xml, application/xml;q=0.9, */*;q=0.8' },
    });
    if (!res.ok) throw new RssError(res.status, `GET /r/${sub}/new.rss ${res.status}`);
    return parseAtom(await res.text(), sub);
  }

  async search(_q: string): Promise<Post[]> {
    return []; // search.rss лимитируется с первого запроса; поиск только через OAuth
  }
}
