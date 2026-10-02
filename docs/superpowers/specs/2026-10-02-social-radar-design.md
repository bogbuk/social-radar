# social-radar: поиск Reddit-тредов и черновики ответов в Telegram

Дата: 2026-10-02. Статус: дизайн согласован; план — `docs/superpowers/plans/2026-10-02-social-radar.md`.

## 1. Зачем

Продвижение проектов workspace `startup/` на Reddit упирается не в публикацию, а в поиск нужного
треда в первые часы и написание толкового ответа. Автопостинг исключён: Reddit банит автоматизацию,
а ценность даёт живой человек (см. `dat.com/docs/marketing/reddit-hos-calculator.md`, правило 9:1).

Сервис **находит** свежие треды по проектам, **оценивает** уместность ответа и присылает в Telegram
**черновик**. Публикует человек. На Reddit сервис ничего не пишет: в коде нет ни одного эндпоинта записи.

Успех первого месяца: 2–3 треда в неделю, на которые владелец реально ответил, рост комментарной
кармы до порога r/Truckers.

## 2. Решения и отвергнутые альтернативы

| Решение | Почему | Отвергнуто |
|---|---|---|
| Отдельный сервис, не модуль LoadLens | нужен всем проектам workspace | модуль в `dat.com/backend` |
| Cloudflare Worker + Cron + KV + Workers AI | ноль серверов и ноль стоимости, задача целиком помещается в один воркер | Node-сервис в Coolify на Hetzner (запасной путь, если Reddit режет IP Cloudflare) |
| Workers AI (gpt-oss-120b) для черновиков | 10 000 нейронов/день бесплатно; черновик правится руками; модель меняется одной строкой | Anthropic API (платно), подписка Claude (нельзя из сервиса по правилам Anthropic; рутина даёт только дайджест 1–2 раза в день) |
| Reddit OAuth script-app, только чтение | публичный `.json` отдаёт 403 (проверено 02.10 с ноутбука и с Hetzner), RSS лимитируется 429 | анонимный JSON, RSS |
| Один Telegram-чат на все проекты | проектов 2–3, имя проекта в карточке | чат на проект |

Оговорка: бесплатный доступ к Reddit API формально для некоммерческого использования; наш объём
(десятки read-only запросов в час) — общепринятая практика, но серая зона.

## 3. Архитектура

Репозиторий `startup/social-radar/` (приватный `bogbuk/social-radar`). TypeScript, Wrangler, без
фреймворка. Один Worker, Cron Trigger `*/15 * * * *`, KV namespace `RADAR`, биндинг `AI`.

```
src/
  index.ts      fetch (GET /health, POST /run?key=) + scheduled → tick()
  tick.ts       оркестрация одного тика (чистая, зависимости через параметры)
  reddit.ts     OAuth-токен (кэш в KV), listing /r/<sub>/new и /search → Post[]
  match.ts      отсев без модели: seen / возраст / keywords.any / keywords.exclude
  prompt.ts     системный+пользовательский промпт, разбор JSON ответа модели
  ai.ts         вызов Workers AI (id модели из vars), 1 повтор
  format.ts     карточка Telegram, строка «ещё N в очереди»
  telegram.ts   sendMessage (plain text, без предпросмотра)
  projects.ts   загрузка projects/*/config.json + voice.md (import при сборке)
projects/<slug>/config.json, voice.md
test/           vitest + фикстуры
```

### Поток одного тика

1. **Сбор.** Объединить сабреддиты всех проектов (дедуп), для каждого `GET /r/<sub>/new?limit=25`
   (25, не 50: разбор JSON укладывается в 10 мс CPU бесплатного плана).
   Для проектов с `queries`: `GET /search?q=<query>&sort=new&t=day` (глобально по Reddit).
   5–10 запросов на тик при лимите 100/мин. User-Agent: `web:social-radar:v<ver> (by /u/<username>)`.
2. **Отсев без модели** для каждой пары (пост, проект): id есть в `seen:v1` → пропустить;
   старше `maxAgeHours` → пометить и пропустить; нет совпадений `keywords.any` или есть
   `keywords.exclude` → пометить и пропустить. Матчинг по границам слов, без учёта регистра;
   слова целиком в верхнем регистре в конфиге (`HOS`) матчатся только в верхнем регистре.
3. **Оценка и черновик одним вызовом Workers AI.** Ответ модели — JSON
   `{relevant: 0..10, reason: string, draft: string}`. `relevant < threshold` проекта → пометить,
   карточку не слать.
4. **Карточка в Telegram.** Пост помечается увиденным **только после 200 от Telegram**.
   Хранилище увиденных — ОДНА KV-запись `seen:v1` = `{postId: lastSeenMs}`, чистка старше 3 дней
   (посты старше `maxAgeHours` всё равно отсеиваются): бесплатный план даёт 50 субзапросов на
   вызов, и KV-операции в них входят, поэтому ключ на пост невозможен. Одно чтение в начале тика,
   одна запись в конце.
5. **Потолок 5 карточек на тик**; остальные кандидаты не помечаются и дождутся следующего тика.
   После пятой карточки одна строка «ещё N в очереди, следующий тик». Потолок держит 10 мс CPU
   бесплатного плана (ожидание сети не считается) и защищает чат при первом запуске.

Один пост может подойти нескольким проектам — отдельная карточка на проект (ключ seen общий на
пост: решение принимается по всем проектам в одном тике, помечаем после доставки всех карточек).

### Reddit OAuth

Script-app, password grant: `POST https://www.reddit.com/api/v1/access_token`
(Basic `client_id:secret`, `grant_type=password`, `username`, `password`). Токен живёт ~1 ч,
кэш `token:reddit` в KV с TTL (expires_in − 60 с). На 401 — обновить и повторить запрос один раз.
Один аккаунт на все проекты — тот, с которого владелец отвечает. При включённой 2FA password grant
требует `password:otp`; тогда заводится отдельный аккаунт только для чтения.

### HTTP

`GET /health` → 200 `{ok:true, version}`. `POST /run?key=<RUN_KEY>` → запустить тик вручную
(отладка), 401 без ключа. Других маршрутов нет.

## 4. Конфиг проекта

`projects/<slug>/config.json`:

```json
{
  "slug": "loadlens",
  "name": "LoadLens",
  "landing": "https://loadlens.krait.studio/hos-calculator/",
  "subreddits": ["Truckers", "CDL", "TruckDrivers", "FreightBrokers", "SideProject"],
  "queries": ["\"hours of service\" calculator", "recap hours 70/8", "\"14 hour\" clock dispatcher"],
  "keywords": {
    "any": ["hours of service", "HOS", "14 hour", "14-hour", "11 hour", "70/8", "recap",
            "34 reset", "split sleeper", "8/2", "7/3", "dispatcher", "rate per mile", "deadhead"],
    "exclude": ["hiring", "for sale", "meme"]
  },
  "maxAgeHours": 24,
  "threshold": 7
}
```

`voice.md` рядом — markdown целиком уходит в системный промпт: от чьего лица пишем, что можно/нельзя
(ссылки, упоминания продуктов/бордов, самопрезентация), тон, 4–5 реальных ответов как примеры.
Для LoadLens собирается из `dat.com/docs/marketing/reddit-hos-calculator.md` (без ссылок кроме
прямого вопроса «где взять», без расширения и DAT, не представляться диспетчером, коротко, вопрос
собеседнику в конце, без восклицаний и эмодзи). Правки тона = правка файла + `wrangler deploy`.

Добавить проект = папка + редеплой. Код про проекты ничего не знает: `scripts/gen-projects.mjs`
собирает `src/projects.generated.ts` перед `dev`/`deploy`.

## 5. Промпт

**System** = общая рамка + `voice.md`. Рамка (одна для всех проектов):

> You help a founder reply in Reddit threads. Decide whether a reply is worth it and write a draft in
> the first person. Return ONLY JSON `{"relevant": 0-10, "reason": "<one line>", "draft": "<text or empty>"}`.
> relevant: 10 = the person directly asks about what we solve; 5 = adjacent topic, a reply would be a
> stretch; 0 = off-topic, ad, job post. Empty draft when relevant < 5. No links unless the voice rules
> allow them. 3–6 sentences unless the thread calls for otherwise. Plain text, no markdown, no emoji.

**User**: сабреддит, заголовок, selftext (обрезан до 3 000 символов), число комментариев, возраст.

Разбор: вырезать первый `{...}` из ответа, `JSON.parse`, валидировать типы и диапазон. Мусор →
один повтор → карточка без черновика с пометкой «model failed».

## 6. Карточка Telegram

Plain text, `disable_web_page_preview: true`, ссылка отдельной строкой:

```
LoadLens · r/CDL · 42 min ago · 3 comments
Will the 14 hour clock keep running if I'm waiting at the shipper?

Score 9/10: new driver asks exactly the 14-hour window question.

https://www.reddit.com/r/CDL/comments/abc123/...

Draft:
Yes, and that's the part that bites. The 14 keeps running from the moment you go on duty...
```

Длиннее 4 000 символов → черновик обрезается с «…».

## 7. Ошибки

Принцип: пост помечается увиденным только после принятого и доставленного решения.

| Сбой | Поведение |
|---|---|
| Reddit 401 | обновить токен, повторить 1 раз |
| Reddit 429 / 5xx / сеть | тик прерывается, ничего не помечается, повтор через 15 мин |
| Workers AI ошибка / не JSON | 1 повтор → карточка без черновика, пост помечается |
| Лимит нейронов исчерпан | то же: карточки без черновиков, видно в логах |
| Telegram ≠ 200 | пост не помечается, уйдёт следующим тиком (потолок 5 сглаживает пачку) |
| Ошибка в коде тика | `console.error`, тик завершается; видно в `wrangler tail` |

Алертинга нет осознанно: отсутствие карточек заметно за день, `POST /run` показывает причину.

## 8. Тесты

Vitest на чистых модулях: `match` (границы слов, регистр аббревиатур, exclude, возраст), `reddit`
(разбор listing на фикстуре реального ответа), `prompt` (сборка, обрезка, разбор JSON с мусором),
`format` (карточка, «ещё N»), `tick` на моках Reddit/AI/Telegram/KV (что помечается, потолок 5,
каждая строка таблицы ошибок).

Живая проверка: `wrangler dev --test-scheduled` + `curl http://localhost:8787/cdn-cgi/local/scheduled`,
секреты в `.dev.vars` (в `.gitignore`), чат-песочница.

**Первый шаг реализации — спайк**: минимальный воркер, который получает Reddit-токен и читает
`/r/Truckers/new` с IP Cloudflare. Если Reddit режет — откат на Node-сервис в Coolify (потеря ~1 ч).

## 9. Деплой и секреты

`wrangler deploy` с ноутбука, CI не нужен. Секреты (`wrangler secret put`): `REDDIT_CLIENT_ID`,
`REDDIT_CLIENT_SECRET`, `REDDIT_USERNAME`, `REDDIT_PASSWORD`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`,
`RUN_KEY`. Vars в `wrangler.toml`: `AI_MODEL` (`@cf/openai/gpt-oss-120b`), `MAX_CARDS_PER_TICK` (5),
cron. Бесплатный план: 5 cron-триггеров на аккаунт (нужен 1), 10 мс CPU на тик; при упоре —
Workers Paid $5/мес (30 с).

## 10. От владельца

1. Script-app на reddit.com/prefs/apps (redirect uri любой, напр. `http://localhost:8080`).
2. Новый Telegram-бот (BotFather) и первое сообщение ему, чтобы снять chat id; либо решение
   использовать бота LoadLens.
3. `wrangler login` на этой машине.
4. Ревью `projects/loadlens/voice.md`.

## 11. Вне скоупа (осознанно)

Публикация на Reddit; мониторинг ответов на наши комментарии (Reddit шлёт inbox сам); другие
источники (X, HN) — архитектура допускает `sources/`, но не сейчас; веб-интерфейс; алертинг;
несколько чатов; CI.
