# Life OS

MVP персонального AI-агента на базе `Codex`, `Supabase`, `OpenRouter`, `Telegram` и `Notion`.

На первом этапе система работает без локального Mac-компонента и без веб-интерфейса.

## Целевая схема MVP

`Telegram -> Supabase Edge Function (webhook) -> Postgres/Storage/queue -> process-inbox -> OpenRouter -> Telegram/Notion`

Что входит в MVP:

- приём входящих сообщений и файлов из Telegram;
- надёжное сохранение оригиналов и метаданных в Supabase;
- фоновая AI-обработка через OpenRouter;
- подтверждения и диалоги в Telegram;
- отображение подтверждённых сущностей в Notion;
- вечерний диалог и недельный обзор по расписанию.

Что не входит в MVP:

- локальный Mac-коннектор;
- Apple Calendar;
- отдельный веб-интерфейс;
- автоматические подтверждённые действия без пользователя.

## Структура репозитория

```text
life-os/
  docs/
    architecture.md
    implementation-plan.md
  supabase/
    migrations/
    functions/
      telegram-webhook/
      process-inbox/
      notion-sync/
      evening-dialog/
      weekly-review/
  .env.example
  .gitignore
```

## Архитектурные решения

- `Supabase` является основным и единственным backend-хостингом для MVP.
- `Postgres` является источником истины.
- `Notion` является витриной, а не мастер-хранилищем.
- `OpenRouter` используется как основной AI-провайдер.
- `Codex` используется как среда разработки и реализации.
- Все внешние изменения создаются только как `draft` или `proposed`, пока пользователь их не подтвердит.
- `process-inbox` запускается по расписанию через `pg_cron`.
- `notion-sync` запускается по расписанию через `pg_cron`.

## Основные компоненты

### `telegram-webhook`

Принимает `Telegram update`, валидирует секрет, сохраняет оригинал, создаёт запись в очереди и отправляет короткое подтверждение пользователю.

### `process-inbox`

Фоново обрабатывает `pending`-элементы, вызывает нужные внешние API, сохраняет AI-результаты и предложения, управляет retry и переходами состояний.

### `notion-sync`

Синхронизирует подтверждённые сущности и представления в Notion.

### `evening-dialog`

Запускается по расписанию, инициирует вечерний диалог в Telegram и сохраняет результаты в Supabase.

### `weekly-review`

Формирует недельный обзор, отправляет его в Telegram и обновляет представления в Notion.

## Переменные окружения

См. [.env.example](/Users/maxsafonov/Documents/Max's system/.env.example).

Минимально понадобятся:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `OPENROUTER_API_KEY`
- `OPENROUTER_BASE_URL`
- `OPENROUTER_MODEL`
- `NOTION_API_KEY`
- `NOTION_DATABASE_IDS`
- `TIMEZONE`

## Порядок реализации

1. Настроить Supabase-проект и секреты.
2. Создать миграции таблиц и базовых ограничений.
3. Реализовать `telegram-webhook`.
4. Реализовать `process-inbox`.
5. Реализовать `notion-sync`.
6. Реализовать `evening-dialog` и `weekly-review`.
7. Добавить тесты на webhook, идемпотентность, очередь и подтверждения.

## Что нужно от вас

- аккаунт и проект `Supabase`;
- бот в `Telegram` и токен;
- `DeepSeek API key`;
- `Notion internal integration` и ID баз;
- решение по часовому поясу для расписания;
- доступ к Git-репозиторию, если хотите сразу вести проект в GitHub.

Подробности по архитектуре и этапам лежат в [docs/architecture.md](/Users/maxsafonov/Documents/Max's system/docs/architecture.md) и [docs/implementation-plan.md](/Users/maxsafonov/Documents/Max's system/docs/implementation-plan.md).
