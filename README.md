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

## Источник данных
Пока Reddit не одобрил script-app (заявка Data Access Request подана 02.10.2026), воркер читает публичные
Atom-ленты `/r/<sub>/new.rss` (`src/rss.ts`): без глобального поиска по `queries` и без числа комментариев.
Как только заданы все четыре `REDDIT_*` секрета, автоматически переключается на OAuth (`src/reddit.ts`).
`GET /health` показывает текущий `source`. Cron пропускает тик, если Telegram не настроен.

## Секреты (`wrangler secret put`)
`REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_USERNAME`, `REDDIT_PASSWORD` (script-app на reddit.com/prefs/apps, только чтение),
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `RUN_KEY` (для `POST /run?key=`).

## Ограничения бесплатного плана
50 субзапросов и 10 мс CPU на вызов: `limit=25` на сабреддит, одна KV-запись `seen:v1`, потолок `MAX_CARDS_PER_TICK`.
Если cron падает по CPU — Workers Paid ($5/мес) даёт 30 с.
