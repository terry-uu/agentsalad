# Agent Salad — Debug Checklist

## Quick Status Check

```bash
# 1. Is the service running?
curl -s http://127.0.0.1:3210/api/health

# 2. Check recent logs
tail -20 logs/agentsalad.log

# 3. Check for errors
grep -E 'ERROR|error' logs/agentsalad.log | tail -20

# 4. Is the process alive?
pgrep -f 'dist/index.js' || pgrep -f 'tsx src/index.ts'
```

## Common Issues

### Service Not Responding to Messages

| Check | Command / Action |
|-------|-----------------|
| Is the service running? | `curl http://127.0.0.1:3210/api/health` |
| Is the channel connected? | Check Web UI — channel should show "paired" status |
| Is there an active service? | Check Agent Services tab — service should be active |
| Does the target match? | Verify target's Telegram user ID matches the sender |
| Check logs | `grep -E 'handleMessage\|findActiveService' logs/agentsalad.log \| tail -20` |

### Telegram Bot Not Connecting

```bash
# Verify bot token
curl https://api.telegram.org/bot<TOKEN>/getMe

# Check for connection errors
grep -E 'telegram\|grammy\|bot' logs/agentsalad.log | tail -20
```

Fixes:
- Re-pair the bot via Web UI (re-enter token)
- Ensure only one instance is running (Telegram rejects concurrent long-polling)
- Check network connectivity

### LLM API Errors

```bash
# Check for provider errors
grep -E 'provider\|API\|rate.limit\|401\|403\|429' logs/agentsalad.log | tail -20
```

| Error | Cause | Fix |
|-------|-------|-----|
| 401 Unauthorized | Invalid API key | Update key via Web UI gear icon |
| 429 Rate Limited | Too many requests | Wait, or switch to a different provider |
| Model not found | Wrong model name | Check provider's model list |
| Network error | Connectivity issue | Check internet connection |

### Auto-Compaction Issues

```bash
# Check compaction events
grep -E 'compact\|archive\|summariz' logs/agentsalad.log | tail -10

# Check archive count
sqlite3 store/messages.db "SELECT service_id, COUNT(*) FROM conversation_archives GROUP BY service_id;"

# Check conversation length
sqlite3 store/messages.db "SELECT service_id, COUNT(*) FROM conversations GROUP BY service_id;"
```

### Cron Not Firing

```bash
# Check cron scheduler
grep -E 'cron\|scheduler\|due' logs/agentsalad.log | tail -20

# Check next_run times
sqlite3 store/messages.db "SELECT sc.service_id, c.name, sc.next_run, sc.status FROM service_crons sc JOIN cron_jobs c ON sc.cron_id = c.id;"
```

Fixes:
- Verify cron is attached to an active service (not just created)
- Check `next_run` is in the past (should trigger on next poll)
- Verify timezone settings

### Database Issues

```bash
# Check DB exists and is readable
ls -la store/messages.db

# Check table integrity
sqlite3 store/messages.db "PRAGMA integrity_check;"

# List all tables
sqlite3 store/messages.db ".tables"

# Check service count
sqlite3 store/messages.db "SELECT COUNT(*) FROM services WHERE status='active';"
```

### Web UI Not Loading

```bash
# Check if port is in use
lsof -i :3210

# Check Web UI env config
# Default: WEB_UI_ENABLED=true, WEB_UI_HOST=127.0.0.1, WEB_UI_PORT=3210
```

## Service Management

```bash
# Development mode (hot reload)
npm run dev

# Production mode
npm run build && npm start

# Run as background service (macOS launchd)
cp launchd/com.agentsalad.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.agentsalad.plist

# Stop service
launchctl unload ~/Library/LaunchAgents/com.agentsalad.plist

# Restart service
launchctl kickstart -k gui/$(id -u)/com.agentsalad

# View live logs
tail -f logs/agentsalad.log
```

## Log Locations

| File | Content |
|------|---------|
| `logs/agentsalad.log` | Main process stdout (structured JSON via Pino) |
| `logs/agentsalad.error.log` | Process stderr |

For pretty-printed logs during development:
```bash
npm run dev  # tsx uses pino-pretty automatically
```
