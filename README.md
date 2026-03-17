# Agent Salad

Your own AI agent, running on your own machine.

No cloud. No subscription. No coding required.

![fork](assets/fork.png)

---

## What Is This?

Agent Salad lets anyone run AI agents through Telegram — using a visual dashboard. Pick an AI provider, connect a messenger bot, choose who it talks to, and you're done.

**Agent + Channel + Target = Service.**

- Works with **Anthropic, OpenAI, Groq, OpenRouter, OpenCode**
- Talks through **Telegram**
- Runs as a **single Node.js process** on any computer you own
- **Web dashboard** with drag-and-drop — no terminal commands needed after setup
- **4 languages** — English, Korean, Japanese, Chinese

## Prerequisites

You need two things installed before starting:

| What | Why |
|------|-----|
| **Node.js 20+** | Runs the agent |
| **Git** | Downloads the code |

You'll also need these later (but not for installation):

| What | Why |
|------|-----|
| **AI provider API key** | Powers the agent's brain — see [Getting an API Key](#getting-an-api-key) |
| **Telegram bot token** | Connects the messenger — see [Creating a Telegram Bot](#creating-a-telegram-bot) |

---

## Installation

### macOS

Git comes pre-installed. Just install Node.js:

```bash
# Option A: Download from website
# Go to https://nodejs.org and download the LTS version, then run the installer.

# Option B: Using Homebrew (if you have it)
brew install node@22
```

Then open **Terminal** (search "Terminal" in Spotlight) and run:

```bash
git clone https://github.com/terry-uu/agentsalad.git
cd agentsalad
npm install
npm run dev
```

### Windows

Windows needs WSL2 (Windows Subsystem for Linux) to run Agent Salad.

**Step 1: Install WSL2**

Open **PowerShell as Administrator** and run:

```powershell
wsl --install
```

Restart your computer. After reboot, Ubuntu will set up automatically — create a username and password when prompted.

**Step 2: Install Node.js inside WSL**

Open the **Ubuntu** app from Start menu and run:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs git
```

**Step 3: Download and start**

```bash
git clone https://github.com/terry-uu/agentsalad.git
cd agentsalad
npm install
npm run dev
```

### Linux (Ubuntu / Debian)

```bash
# Install Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs git

# Download and start
git clone https://github.com/terry-uu/agentsalad.git
cd agentsalad
npm install
npm run dev
```

### Verify

After `npm run dev`, open your browser and go to:

**http://127.0.0.1:3210**

If you see the dashboard, you're good.

## First-Time Setup (5 minutes)

### Step 1: Add an API Key

Click the **API Key Settings** button at the top of the dashboard.

Enter your provider name (e.g. `anthropic`) and paste your API key.

### Step 2: Create an Agent

Go to the **Agents** tab and click **+ Create Agent**.

- **Name** — anything you want (e.g. "My Assistant")
- **Provider** — select the one you added a key for
- **Model** — enter the model name (e.g. `claude-sonnet-4-20250514`, `gpt-4o`)
- **System Prompt** — describe what the agent should do
- **Skills** — toggle on the tools your agent can use (files, web, etc.)

### Step 3: Connect Telegram

Go to the **Agent Services** tab, click **+ Add** under Channels.

- Paste your **Telegram bot token**

### Step 4: Add a Target

Click **+ Add** under Targets.

- Enter the **Telegram user ID** of the person who'll chat with the agent
- Give them a **nickname**

### Step 5: Make a Salad

Drag an **Agent**, a **Channel**, and a **Target** into the salad bowl.

Your agent is now live. Open Telegram and start chatting.

---

## Getting an API Key

| Provider | Where to get it |
|----------|----------------|
| Anthropic | [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys) |
| OpenAI | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
| Groq | [console.groq.com/keys](https://console.groq.com/keys) |
| OpenRouter | [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys) |
| OpenCode | [opencode.ai/auth](https://opencode.ai/auth) |

## Creating a Telegram Bot

1. Open Telegram and search for **@BotFather**
2. Send `/newbot`
3. Follow the prompts to name your bot
4. Copy the **token** it gives you (looks like `123456789:ABCdef...`)

To find your **Telegram user ID**: search for **@userinfobot** on Telegram and send it any message.

---

## Features

| Feature | Description |
|---------|-------------|
| **Multi-provider** | Anthropic, OpenAI, Groq, OpenRouter, OpenCode via Vercel AI SDK |
| **10 builtin skills** | File I/O, web fetch, browser automation, bash, Google (Gmail/Calendar/Drive), cron |
| **Custom skills** | Create your own script or prompt-based tools |
| **Auto-compaction** | Automatically summarizes when conversation gets too long |
| **Cron scheduler** | Schedule tasks — daily news summary, morning briefing, etc. |
| **Smart Step** | Multi-step plan execution with interrupt detection |
| **Web UI** | Visual dashboard, 4 languages, drag-and-drop |

## Keeping It Running

> Your agent only works while the program is running and the computer is on.
> Think of it like a Wi-Fi router — if you unplug it, the Wi-Fi stops.

### Quick Run (testing)

```bash
npm run dev
```

This starts the agent in your terminal. If you close the terminal or shut down the computer, the agent stops.

### Always-On (production)

For 24/7 operation, you need two things:

**1. Keep the computer awake**

| Platform | How |
|----------|-----|
| **macOS** | System Settings > Energy > Turn off "Put hard disks to sleep" and enable "Prevent automatic sleeping when the display is off" |
| **Linux** | `sudo systemctl mask sleep.target suspend.target hibernate.target` |
| **Windows (WSL2)** | Settings > System > Power > Set sleep to "Never" |

**2. Run as a background service**

```bash
# Build first
npm run build

# Install pm2 (process manager — keeps your agent alive)
npm install -g pm2

# Start as background service
pm2 start dist/index.js --name agentsalad

# Auto-restart on computer reboot
pm2 save
pm2 startup

# Useful commands
pm2 status          # check if running
pm2 logs agentsalad # see what the agent is doing
pm2 restart agentsalad  # restart
pm2 stop agentsalad     # stop
```

Once set up, your agent runs silently in the background — even after you close the terminal. It automatically restarts if it crashes or if the computer reboots.

## Development

```bash
npm run dev          # Hot reload (tsx)
npm run build        # Compile TypeScript
npm test             # Run tests
npm run format       # Format code
```

Dashboard: `http://127.0.0.1:3210`
Health check: `http://127.0.0.1:3210/api/health`

## Documentation

| Document | Description |
|----------|-------------|
| [PHILOSOPHY.md](PHILOSOPHY.md) | Why this project exists |
| [SERVICE_PLATFORM.md](docs/SERVICE_PLATFORM.md) | Full architecture reference |
| [DATABASE_SCHEMA.md](docs/DATABASE_SCHEMA.md) | SQLite schema reference |
| [SECURITY.md](docs/SECURITY.md) | Security model |
| [REQUIREMENTS.md](docs/REQUIREMENTS.md) | Design decisions |
| [DEBUG_CHECKLIST.md](docs/DEBUG_CHECKLIST.md) | Troubleshooting guide |

## Philosophy

Read [PHILOSOPHY.md](PHILOSOPHY.md) to understand why this project exists.

## License

[Elastic License 2.0](LICENSE) — Free to use, modify, and distribute. Cannot be offered as a managed service.
