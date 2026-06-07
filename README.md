<p align="center">
  <img src="assets/fork.png" width="420" alt="Agent Salad" />
</p>

<h1 align="center">Agent Salad</h1>

<p align="center">
  Run your own AI agents through messenger channels, on your own machine.<br/>
  Visual setup. Local data. MIT licensed.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/node-20%2B-339933?logo=nodedotjs&logoColor=white" alt="Node 20+" />
  <img src="https://img.shields.io/badge/recommended-Node%2022-339933?logo=nodedotjs&logoColor=white" alt="Node 22 recommended" />
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License" />
  <img src="https://img.shields.io/badge/channels-Telegram%20%7C%20Discord%20%7C%20Slack-5865F2" alt="Telegram Discord Slack" />
  <img src="https://img.shields.io/badge/languages-EN%20%7C%20KO%20%7C%20JA%20%7C%20ZH-ff69b4" alt="English Korean Japanese Chinese" />
</p>

---

## What Is Agent Salad?

Agent Salad is a self-hosted AI agent platform for people who want useful agents without handing the whole workflow to another SaaS.

Create an agent, connect a messenger channel, choose a target user or room, and Agent Salad runs the service as one local Node.js process with a web dashboard.

**Agent + Channel + Target = Service.**

| Piece | What it means |
|-------|---------------|
| **Agent** | Provider, model, system prompt, skills, memory behavior |
| **Channel** | Telegram, Discord, Slack, or a channel plugin |
| **Target** | A DM user, room, channel, or thread the agent serves |

## Why It Exists

AI agents should be usable by people who do not want to learn cloud deployment, daemon management, vector databases, or bot framework internals.

Agent Salad keeps the setup small: one app, one local database, one visual dashboard, and messenger channels people already use.

## Features

| Area | Supported today |
|------|-----------------|
| **Providers** | Anthropic, OpenAI, Google Gemini, Groq, OpenRouter, OpenCode, Moonshot, GLM, plus provider plugins |
| **Channels** | Telegram, Discord, Slack, plus bundled channel plugins such as KakaoTalk |
| **Skills** | File read/write/list, file upload, web fetch, browser automation, bash, long-running terminal, Gmail, Calendar, Drive, cron |
| **Workspaces** | Per-agent and per-target folders with shared agent folders |
| **Conversation control** | Auto-compaction, archives, `/reset`, time-aware prompts |
| **Automation** | Cron jobs and Smart Step multi-step plan execution |
| **Desktop** | Electron wrapper can be built locally when needed |

## Install

Run from source:

Requirements:

- Node.js `>=20`; Node `22` is recommended and used by `.nvmrc`
- npm
- Native build tools for `better-sqlite3`
  - macOS: Xcode Command Line Tools
  - Ubuntu/Debian: `python3 make g++`
  - Windows: WSL2 is recommended

```bash
git clone https://github.com/terry-uu/agentsalad.git
cd agentsalad
npm install
npm run dev
```

Open `http://127.0.0.1:3210`.

For production from source:

```bash
npm run build
npm start
```

## First Setup

Everything below happens in the Web UI.

1. Add an LLM provider API key.
2. Create an agent with a model, system prompt, and skills.
3. Add a channel such as Telegram, Discord, or Slack.
4. Add a target user or room.
5. Combine the agent, channel, and target into a service.

The service starts immediately while Agent Salad is running.

### API Key Links

| Provider | Key page |
|----------|----------|
| Anthropic | [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys) |
| OpenAI | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
| Google Gemini | [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey) |
| Groq | [console.groq.com/keys](https://console.groq.com/keys) |
| OpenRouter | [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys) |
| OpenCode | [opencode.ai/auth](https://opencode.ai/auth) |
| Moonshot | [platform.moonshot.ai/console/api-keys](https://platform.moonshot.ai/console/api-keys) |
| GLM | [bigmodel.cn/usercenter/proj-mgmt/apikeys](https://www.bigmodel.cn/usercenter/proj-mgmt/apikeys) |

## Configuration

Copy `.env.example` to `.env` when you need to override defaults.

| Variable | Default | Purpose |
|----------|---------|---------|
| `AGENTSALAD_STORE_DIR` | `./store` | SQLite database, workspaces, uploads, archives |
| `WEB_UI_ENABLED` | `true` | Enable or disable the admin dashboard |
| `WEB_UI_HOST` | `127.0.0.1` | Dashboard bind host |
| `WEB_UI_PORT` | `3210` | Dashboard port |
| `TZ` | system timezone | Default server timezone before Web UI override |
| `LOG_LEVEL` | `info` | Pino log level |

## Security Model

Agent Salad is designed for a trusted local admin.

- The Web UI has no built-in authentication and binds to `127.0.0.1` by default.
- Provider API keys are stored in the local SQLite database in plaintext.
- `bash`, `terminal`, and custom skills execute on the host machine.
- File tools are scoped to agent workspaces, but tool-enabled agents should still be treated as trusted automation.
- If you expose the dashboard outside localhost, add authentication at the network or reverse proxy layer.

## Browser Automation

The `web_browse` skill uses the Agent Salad Chrome Extension bridge. The extension is included in this repository at `extension/`; there is no separate download or GitHub Release asset.

Load it in Chrome:

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the repository's `extension/` folder
5. Click the extension icon and connect to `127.0.0.1:3210`

See [BROWSER_EXTENSION.md](BROWSER_EXTENSION.md) for details and troubleshooting.

## Development

```bash
npm run dev            # Run with hot reload
npm run build          # Compile TypeScript
npm run typecheck      # Type-check without emitting
npm test               # Run Vitest
npm run format:check   # Check formatting
npm run format:fix     # Format source files
npm run electron       # Run the Electron desktop wrapper
npm run electron:build # Build desktop installers
```

Dashboard: `http://127.0.0.1:3210`  
Health check: `http://127.0.0.1:3210/api/health`

The CI workflow runs format check, typecheck, and tests on pull requests.

## License

Agent Salad is open source under the [MIT License](LICENSE).
