# Agent Salad Security Model

## Trust Model

| Entity | Trust Level | Rationale |
|--------|-------------|-----------|
| Web UI admin | Trusted | Local-only access (127.0.0.1), manages all configuration |
| Telegram messages | User input | Potential prompt injection |
| LLM responses | Semi-trusted | Tool calls execute with workspace-scoped permissions |
| Custom skill scripts | Trusted | Admin-created via Web UI, execute on host |

## Security Boundaries

### 1. Workspace Isolation

Agent file operations are scoped to their workspace:
- Each agent gets `store/workspaces/<agent-name>/`
- Each target gets a personal subfolder within the agent's workspace
- Path traversal is blocked via `resolveWorkspacePath()` — prevents `../` escapes
- `_shared/` folder provides controlled cross-target file access

### 2. API Key Storage

LLM provider API keys are stored in the `llm_providers` SQLite table.

**Current state:** Keys are stored in plaintext. This is a known limitation.

**Mitigations:**
- Database file (`store/messages.db`) should have restricted permissions
- Web UI is bound to `127.0.0.1` only — not exposed to the network
- Keys are never sent to agents or included in tool call results

### 3. Tool Execution Scope

Builtin tools operate within defined boundaries:

| Tool | Scope |
|------|-------|
| `read_file` / `write_file` / `list_files` | Agent workspace only |
| `run_command` (bash) | Agent workspace as cwd, runs on host |
| `fetch_url` / `browse_*` | Unrestricted network access |
| `gmail_*` / `calendar_*` / `drive_*` | Requires gog CLI with OAuth |
| `create_cron` / `list_crons` / `delete_cron` | Service-scoped |

**Important:** The `bash` skill runs commands directly on the host machine (not in a container). Only enable it for trusted agents.

### 4. Custom Skill Execution

Custom skill scripts run via `child_process.exec` on the host:
- Working directory is the agent's workspace
- Input is passed as JSON stdin + `INPUT_*` environment variables
- Timeout enforced via `timeout_ms` (default 30s)
- Scripts are admin-authored — the LLM cannot create or modify them

### 5. Prompt Injection Risk

Telegram messages could contain malicious instructions.

**Mitigations:**
- Service matching by `channel_id + target_id` — only registered targets are processed
- Tool calling is bounded by `stopWhen(stepCountIs(10))` — max 10 tool steps per turn
- File tools are workspace-scoped — cannot access system files
- LLM's built-in safety training

**Recommendations:**
- Only create services for trusted users
- Disable `bash` skill for agents serving untrusted users
- Review custom skill scripts carefully
- Monitor logs for unusual tool call patterns

## Web UI Access

The admin dashboard binds to `127.0.0.1:3210` by default.

- No authentication (local-only access assumed)
- Configurable via `WEB_UI_HOST` and `WEB_UI_PORT` environment variables
- If exposed to a network, add a reverse proxy with authentication

## Credential Recommendations

```bash
chmod 600 store/messages.db
chmod 700 store/
```

Keep `store/` in `.gitignore` (already configured).
