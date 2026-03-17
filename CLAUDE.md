# Agent Salad — Service Platform

Multi-provider AI agent platform served through messenger channels. Fork of [NanoClo (AgentSalad)](https://github.com/qwibitai/agentsalad), rebuilt with direct LLM API calls via Vercel AI SDK, Web UI, and a skills system.

See [docs/SERVICE_PLATFORM.md](docs/SERVICE_PLATFORM.md) for full architecture. See [docs/DATABASE_SCHEMA.md](docs/DATABASE_SCHEMA.md) for schema reference.

## Quick Context

**Agent + Channel + Target = Service.** A single Node.js process manages multiple concurrent services. Each service binds one AI agent (any LLM provider) to one messenger channel (Telegram) for one target user. Direct API calls via Vercel AI SDK — no proxy, no containers for chat.

Auto-compaction (Claude SDK pattern): when conversation context exceeds 75% of the provider's context window, the engine archives the full history, asks the same LLM to summarize, and replaces all messages with the summary. Recursive — if summary + new messages overflow again, re-summarizes.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Main orchestrator: DB init, service router, Web UI |
| `src/service-router.ts` | Message processing engine: service matching → auto-compaction → LLM call → response + processCronMessage |
| `src/cron-scheduler.ts` | Cron scheduler: 30s polling loop, due check, prompt wrapping, once cleanup |
| `src/compaction.ts` | Token estimation, context window map, auto-compaction engine |
| `src/providers/index.ts` | Multi-provider router (Vercel AI SDK: streamChat, chat) |
| `src/providers/system-prompt.ts` | Immutable System Prompt 1 (base rules for all agents) |
| `src/providers/anthropic.ts` | Anthropic provider adapter |
| `src/providers/openai.ts` | OpenAI provider adapter |
| `src/providers/groq.ts` | Groq provider adapter |
| `src/providers/openrouter.ts` | OpenRouter provider adapter |
| `src/providers/opencode.ts` | OpenCode provider adapter |
| `src/channels/telegram.ts` | Telegram channel (grammY) |
| `src/plan-executor.ts` | Smart Step plan execution engine (batch loop, interrupt check, crash recovery) |
| `src/web-ui.ts` | Admin dashboard: 3 tabs (Agent Services / Agents / Skills), i18n, light theme |
| `src/db.ts` | SQLite: services, conversations, archives, providers, custom_skills, cron_jobs, service_crons |
| `src/types.ts` | Type definitions (AgentSkillToggles, CustomSkill, CronJob, ServiceCron, Service, etc.) |
| `src/skills/types.ts` | BuiltinSkill, SkillContext, ResolvedSkills interfaces |
| `src/skills/registry.ts` | resolveSkills(agent, customSkills) → tools + skillPrompts (prompt.txt file-first) |
| `src/skills/custom-executor.ts` | Custom skill executor (file-based + inline fallback, stdin JSON + env vars) |
| `src/skills/workspace.ts` | Agent workspace management (multi-target subfolders, _shared/ shared folder, name-based folders, rename tracking) |
| `src/skills/builtin/index.ts` | All 10 builtin skills registered |
| `src/skills/builtin/file-read.ts` | read_file tool (workspace scoped) |
| `src/skills/builtin/file-write.ts` | write_file tool (workspace scoped) |
| `src/skills/builtin/file-list.ts` | list_files tool (workspace scoped) |
| `src/skills/builtin/web-fetch.ts` | fetch_url tool (HTML→text) |
| `src/skills/builtin/web-browse.ts` | Playwright browse_* tools (optional) |
| `src/skills/builtin/bash.ts` | run_command tool (workspace cwd) |
| `src/skills/builtin/google/index.ts` | gog CLI availability check + runner |
| `src/skills/builtin/google/gmail.ts` | gmail_search, gmail_send, gmail_read |
| `src/skills/builtin/google/calendar.ts` | calendar_list, calendar_create |
| `src/skills/builtin/google/drive.ts` | drive_list, drive_download, drive_upload |
| `src/skills/builtin/cron.ts` | create_cron, list_crons, delete_cron (agent self-service cron) |
| `src/skills/builtin/send-message.ts` | send_message tool (Smart Step channel delivery) |
| `src/skills/builtin/submit-plan.ts` | submit_plan tool (Smart Step plan submission) |
| `src/logger.ts` | Pino logger setup |
| `src/timezone.ts` | Timezone utilities |

## Architecture

```
User ──▶ Messenger ──▶ Channel (Telegram)
                              │
                              ▼
                     Service Router
                     ├─ Find active service (channel_id + target_id)
                     ├─ Auto-compact if context > 75% window
                     ├─ Build context (summary + recent messages)
                     ├─ resolveSkills(agent) → tools + skillPrompts
                     └─ Stream response via Provider Router
                              │
                              ▼
                     Provider Router (Vercel AI SDK)
                     ├─ 3-layer system prompt (base + skills + agent)
                     ├─ tools + stopWhen(stepCountIs(10))
                     ├─ Anthropic  ├─ OpenAI  ├─ Groq
                     ├─ OpenRouter └─ OpenCode
                              │
                    ┌─────────┼─────────┐ (tool calling loop)
                    ▼         ▼         ▼
              File Tools  Web Tools  Bash/Google
              (workspace)  (fetch/   (gog CLI)
                           browse)
                              │
                              ▼
                     Response ──▶ Channel ──▶ User

 Cron Scheduler (30s loop)
 ├─ getDueServiceCrons()
 ├─ Wrap prompt with cron metadata
 └─ processCronMessage() ──▶ same LLM pipeline
```

## Development

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
npm test             # Run vitest
```

Web UI: `http://127.0.0.1:3210`

## Compaction System

Mirrors Claude Agent SDK's auto-compaction:
1. Every message: estimate tokens (ASCII ~4 chars/token, CJK ~1.5 chars/token)
2. If total context > 75% of provider's context window → compact
3. Archive full conversation to `conversation_archives` table
4. Ask same LLM to summarize all messages
5. Replace all messages with single system summary
6. Summary + new messages overflow → re-summarize (recursive)

Config: `src/compaction.ts` — threshold ratio, min messages, context window map.

