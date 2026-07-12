# AGENTS

## Project

`Life OS` is a personal AI system for capturing information from `Telegram`, processing it in the cloud through `OpenRouter`, storing canonical data in `Supabase`, and exposing useful views in `Notion`.

This repository is implemented with `Codex` as the primary coding agent.

## Core Product Rules

- Always save the original input before any AI processing.
- `Supabase Postgres` is the single source of truth.
- `Notion` is a read model and presentation layer, not a master data store.
- All AI-generated actions must stay in `draft` or `proposed` state until explicit user confirmation.
- No local `Mac` component is part of MVP.
- No `Apple Calendar` integration is part of MVP.
- No web UI is part of MVP unless explicitly added later.

## Current MVP Scope

The first implementation stage includes:

- Telegram bot ingestion;
- webhook handling through `Supabase Edge Functions`;
- storage of raw messages and attachments;
- background processing queue;
- AI classification and summarization through `OpenRouter`;
- Telegram confirmations and follow-up prompts;
- Notion sync for approved entities;
- scheduled evening dialog and weekly review.

Out of scope for now:

- Apple Calendar;
- local scripts required for core product operation;
- autonomous life decisions;
- auto-confirmed tasks, goals, events, or financial operations;
- multi-agent orchestration inside the product itself unless explicitly required later.

## Architecture Rules

- Prefer one managed backend platform: `Supabase`.
- Use `Supabase Edge Functions` for webhook handlers and lightweight background jobs.
- If a workload exceeds practical edge limits, move only the heavy processing step to a separate worker while keeping the same storage and domain contracts.
- External providers must be wrapped by adapters.
- Domain logic should not depend directly on vendor SDKs across the codebase.

## Provider Rules

### OpenRouter

- Use `OpenRouter` as the default AI provider.
- Access it through a dedicated adapter layer.
- Keep model choice configurable through environment variables.
- Do not hardcode deprecated model names.

### Telegram

- Treat repeated updates as normal and design for idempotency.
- Acknowledge successful capture quickly.
- Do not block webhook responses on long AI tasks.

### Notion

- Sync only the data that should be visible in dashboards or review flows.
- Make sync idempotent and retry-safe.
- Never treat Notion as canonical storage.

## Data Rules

Every mutable entity should aim to include:

- stable id;
- created and updated timestamps;
- source reference;
- actor: `user`, `system`, or `ai`;
- status;
- revision or version marker;
- confidence where relevant;
- soft delete or archive marker when needed.

Critical system behavior:

- raw input must remain immutable;
- AI outputs must be stored separately from source data;
- important transitions must be written to `audit_log`;
- queue processing must be restart-safe.

## Security Rules

- Never commit secrets.
- Keep credentials only in environment variables or secret stores.
- Never expose `SUPABASE_SERVICE_ROLE_KEY` to clients.
- Avoid logging full sensitive payloads, tokens, or private raw content.
- Treat potentially sensitive work information conservatively and prefer redaction.

## Implementation Priorities

Build in this order unless the user asks otherwise:

1. Database migrations and core schema.
2. `telegram-webhook`.
3. `process-inbox`.
4. `notion-sync`.
5. `evening-dialog`.
6. `weekly-review`.
7. Tests for idempotency, retries, permissions, and confirmation flows.

## Coding Preferences

- Keep modules small and explicit.
- Prefer adapters and pure domain functions over tightly coupled handlers.
- Use structured logs with correlation ids when possible.
- Design queue transitions carefully: `pending`, `processing`, `processed`, `failed`.
- Make retries bounded and observable.
- Prefer Russian for user-facing Telegram copy unless requested otherwise.

## Task Execution Rules For Codex

- Before implementing a new feature, check whether it belongs to MVP.
- When requirements are ambiguous, preserve safety: store data, create drafts, avoid automatic external changes.
- When adding integrations, document required environment variables in `.env.example`.
- When changing architecture assumptions, update `README.md` and `docs/architecture.md`.
- When adding new flows, keep them traceable to explicit product requirements.

## Definition Of Done

A task is not complete unless:

- the code or docs reflect the agreed architecture;
- secrets are not hardcoded;
- the behavior is safe under retries or repeated webhook delivery where relevant;
- the change does not bypass user confirmation rules;
- local documentation stays consistent with the implementation.
