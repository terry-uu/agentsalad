/**
 * KakaoTalk Channel Dressing — adapter.bundle.js
 *
 * 카카오 오픈빌더 스킬 서버 채널 어댑터 + 자동 터널 (ngrok / Cloudflare Tunnel).
 *
 * 터널: tunnel_provider 설정에 따라 ngrok 또는 cloudflared 바이너리를 자동 다운로드하고
 * spawn하여 공개 URL을 확보. onConfigUpdate 콜백으로 public_url을 DB에 기록.
 * crash recovery: 프로세스 크래시 시 최대 3회 exponential backoff 재시작 (3s, 6s, 9s).
 * 서버 재시작 시 고아 터널 프로세스 정리: pkill/taskkill로 OS-level 강제 종료 후 재생성.
 *
 * 채널: handleWebhook으로 카카오 POST 수신 → useCallback:true 즉시 반환 + onMessage 비동기 LLM 트리거.
 * sendMessage로 콜백 URL에 LLM 응답 전달. callbackUrl은 메시지당 1회성 (55s TTL).
 *
 * CJS 모듈 — plugin-loader.ts의 require()로 로드됨.
 */

'use strict';

const { existsSync, mkdirSync, createWriteStream, chmodSync, readdirSync } = require('fs');
const { join } = require('path');
const { platform: osPlatform, arch: osArch } = require('os');
const { execSync, spawn } = require('child_process');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

const KAKAO_TEXT_LIMIT = 1000;
const CALLBACK_TTL_MS = 55_000;
const DOWNLOAD_TIMEOUT_MS = 180_000;
const TUNNEL_START_TIMEOUT_MS = 15_000;
const MAX_CRASH_RETRIES = 3;

// ── 터널 상태 (모듈 싱글턴 — 모든 카카오 채널이 하나의 터널을 공유) ──

let tunnelProcess = null;
let tunnelUrl = null;
let tunnelProvider = null;
let tunnelRetries = 0;
let binDir = null;
let lastTunnelConfig = null;

// ── 채널 상태 ──

/** @type {Map<string, { url: string, timer: NodeJS.Timeout }>} */
const pendingCallbacks = new Map();
/** @type {Map<string, Record<string, unknown>>} */
const channelConfigs = new Map();
/** @type {Function|null} */
let configUpdateFn = null;
let activeChannelId = null;

// ── 플랫폼 감지 ──

function getPlatformKey() {
  const p = osPlatform();
  const a = osArch();
  return `${p}-${a === 'x64' ? 'amd64' : a}`;
}

function getNgrokDownloadUrl() {
  const key = getPlatformKey();
  const map = {
    'darwin-arm64': 'ngrok-v3-stable-darwin-arm64.tgz',
    'darwin-amd64': 'ngrok-v3-stable-darwin-amd64.tgz',
    'linux-amd64': 'ngrok-v3-stable-linux-amd64.tgz',
    'linux-arm64': 'ngrok-v3-stable-linux-arm64.tgz',
    'win32-amd64': 'ngrok-v3-stable-windows-amd64.zip',
  };
  const file = map[key];
  if (!file) throw new Error(`ngrok: unsupported platform ${key}`);
  return `https://bin.equinox.io/c/bNyj1mQVY4c/${file}`;
}

function getCloudflaredDownloadUrl() {
  const key = getPlatformKey();
  const base = 'https://github.com/cloudflare/cloudflared/releases/latest/download';
  const map = {
    'darwin-arm64': `${base}/cloudflared-darwin-arm64.tgz`,
    'darwin-amd64': `${base}/cloudflared-darwin-amd64.tgz`,
    'linux-amd64': `${base}/cloudflared-linux-amd64`,
    'linux-arm64': `${base}/cloudflared-linux-arm64`,
    'win32-amd64': `${base}/cloudflared-windows-amd64.exe`,
  };
  const url = map[key];
  if (!url) throw new Error(`cloudflared: unsupported platform ${key}`);
  return url;
}

function ngrokBinName() { return osPlatform() === 'win32' ? 'ngrok.exe' : 'ngrok'; }
function cloudflaredBinName() { return osPlatform() === 'win32' ? 'cloudflared.exe' : 'cloudflared'; }

// ── 바이너리 다운로드 ──

async function downloadFile(url, destPath) {
  console.log(`[kakaotalk] Downloading ${url} ...`);
  const resp = await fetch(url, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    redirect: 'follow',
  });
  if (!resp.ok) throw new Error(`Download failed: ${resp.status} — ${url}`);
  const ws = createWriteStream(destPath);
  await pipeline(Readable.fromWeb(resp.body), ws);
}

async function ensureNgrok() {
  const binPath = join(binDir, ngrokBinName());
  if (existsSync(binPath)) return binPath;

  mkdirSync(binDir, { recursive: true });
  const url = getNgrokDownloadUrl();
  const archivePath = join(binDir, 'ngrok-download' + (url.endsWith('.zip') ? '.zip' : '.tgz'));

  await downloadFile(url, archivePath);

  if (archivePath.endsWith('.tgz')) {
    execSync(`tar xzf "${archivePath}" -C "${binDir}"`, { timeout: 30_000 });
  } else {
    execSync(
      `powershell -Command "Expand-Archive -Path '${archivePath}' -DestinationPath '${binDir}' -Force"`,
      { timeout: 30_000 },
    );
  }

  if (osPlatform() !== 'win32') chmodSync(binPath, 0o755);
  console.log(`[kakaotalk] ngrok installed: ${binPath}`);
  return binPath;
}

async function ensureCloudflared() {
  const binPath = join(binDir, cloudflaredBinName());
  if (existsSync(binPath)) return binPath;

  mkdirSync(binDir, { recursive: true });
  const url = getCloudflaredDownloadUrl();

  if (url.endsWith('.tgz')) {
    const archivePath = join(binDir, 'cloudflared-download.tgz');
    await downloadFile(url, archivePath);
    execSync(`tar xzf "${archivePath}" -C "${binDir}"`, { timeout: 30_000 });
  } else {
    await downloadFile(url, binPath);
  }

  if (osPlatform() !== 'win32') chmodSync(binPath, 0o755);
  console.log(`[kakaotalk] cloudflared installed: ${binPath}`);
  return binPath;
}

// ── ngrok 터널 ──

async function startNgrok(authtoken, port, domain) {
  const binPath = await ensureNgrok();

  // ngrok agent API kill + OS-level 고아 프로세스 정리
  try { execSync(`"${binPath}" kill`, { timeout: 5_000, stdio: 'ignore' }); } catch {}
  try {
    if (osPlatform() === 'win32') execSync(`taskkill /F /IM "${ngrokBinName()}" 2>nul`, { timeout: 5_000, stdio: 'ignore' });
    else execSync(`pkill -f "${binPath.replace(/"/g, '')}" 2>/dev/null || true`, { timeout: 3_000, stdio: 'ignore' });
  } catch {}

  const args = ['http', '--authtoken', authtoken, '--domain', domain, '--log', 'stdout', '--log-format', 'json', String(port)];
  console.log(`[kakaotalk] Starting ngrok → https://${domain} (port ${port})`);

  return new Promise((resolve, reject) => {
    const proc = spawn(binPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    tunnelProcess = proc;
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        // Process still alive = tunnel likely connected
        if (proc.exitCode === null) resolve();
        else reject(new Error('ngrok: timed out'));
      }
    }, TUNNEL_START_TIMEOUT_MS);

    proc.stdout.on('data', (chunk) => {
      const lines = chunk.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if ((obj.msg === 'started tunnel' || obj.url) && !resolved) {
            resolved = true; clearTimeout(timeout); resolve();
          }
        } catch {}
      }
    });

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (text) console.error('[kakaotalk:ngrok] ' + text);
    });

    proc.on('exit', (code) => {
      tunnelProcess = null;
      if (!resolved) { resolved = true; clearTimeout(timeout); reject(new Error(`ngrok exited with code ${code}`)); return; }
      if (tunnelRetries < MAX_CRASH_RETRIES) {
        tunnelRetries++;
        console.warn(`[kakaotalk] ngrok crashed (code ${code}), retry ${tunnelRetries}/${MAX_CRASH_RETRIES}`);
        setTimeout(async () => {
          try {
            await startNgrok(authtoken, port, domain);
            tunnelUrl = `https://${domain}`;
            console.log(`[kakaotalk] ngrok restarted successfully (retry ${tunnelRetries})`);
          } catch (err) {
            console.error(`[kakaotalk] ngrok restart failed: ${err.message}`);
            tunnelUrl = null;
          }
        }, tunnelRetries * 3_000);
      } else {
        console.error(`[kakaotalk] ngrok crashed ${MAX_CRASH_RETRIES} times, giving up`);
        tunnelUrl = null;
      }
    });
  });
}

// ── cloudflared 터널 ──

async function startCloudflared(token) {
  const binPath = await ensureCloudflared();

  // 고아 프로세스 정리 (SIGKILL로 부모가 죽은 경우 잔존 가능)
  try {
    if (osPlatform() === 'win32') execSync(`taskkill /F /IM "${cloudflaredBinName()}" 2>nul`, { timeout: 5_000, stdio: 'ignore' });
    else execSync(`pkill -f "${binPath.replace(/"/g, '')}" 2>/dev/null || true`, { timeout: 3_000, stdio: 'ignore' });
  } catch {}

  const args = ['tunnel', '--no-autoupdate', 'run', '--token', token];
  console.log('[kakaotalk] Starting cloudflared tunnel...');

  const proc = spawn(binPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  tunnelProcess = proc;

  return new Promise((resolve, reject) => {
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        // cloudflared doesn't output the URL — it's configured in dashboard
        // Consider it started if process is still alive
        if (proc.exitCode === null) resolve('cloudflared-running');
        else reject(new Error('cloudflared: process exited before ready'));
      }
    }, TUNNEL_START_TIMEOUT_MS);

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      // cloudflared logs connection success to stderr
      if (text.includes('Registered tunnel connection') && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve('cloudflared-connected');
      }
      if (text.includes('ERR')) console.error('[kakaotalk:cloudflared] ' + text.trim());
    });

    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      if (text.includes('Registered tunnel connection') && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve('cloudflared-connected');
      }
    });

    proc.on('exit', (code) => {
      tunnelProcess = null;
      if (!resolved) { resolved = true; clearTimeout(timeout); reject(new Error(`cloudflared exited with code ${code}`)); return; }
      if (tunnelRetries < MAX_CRASH_RETRIES) {
        tunnelRetries++;
        console.warn(`[kakaotalk] cloudflared crashed (code ${code}), retry ${tunnelRetries}/${MAX_CRASH_RETRIES}`);
        setTimeout(async () => {
          try {
            await startCloudflared(token);
            console.log(`[kakaotalk] cloudflared restarted successfully (retry ${tunnelRetries})`);
          } catch (err) {
            console.error(`[kakaotalk] cloudflared restart failed: ${err.message}`);
            tunnelUrl = null;
          }
        }, tunnelRetries * 3_000);
      } else {
        console.error(`[kakaotalk] cloudflared crashed ${MAX_CRASH_RETRIES} times, giving up`);
        tunnelUrl = null;
      }
    });
  });
}

// ── 터널 통합 관리 ──

async function startTunnel(config, port) {
  const provider = config.tunnel_provider || 'manual';
  if (provider === 'manual') return config.public_url || null;

  binDir = join(__dirname, 'bin');
  tunnelProvider = provider;
  tunnelRetries = 0;
  lastTunnelConfig = { config, port };

  if (provider === 'ngrok') {
    const token = config.ngrok_authtoken;
    const domain = (config.ngrok_domain || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (!token) { console.warn('[kakaotalk] ngrok: auth token missing'); return null; }
    if (!domain) { console.warn('[kakaotalk] ngrok: static domain missing — get yours at https://dashboard.ngrok.com/domains'); return null; }
    await startNgrok(token, port, domain);
    const url = `https://${domain}`;
    tunnelUrl = url;
    return url;
  }

  if (provider === 'cloudflare') {
    const token = (config.cf_tunnel_token || '').trim();
    let url = (config.cf_public_url || '').trim().replace(/\/+$/, '');
    if (url && !url.startsWith('https://')) url = 'https://' + url;
    if (!token) { console.warn('[kakaotalk] cloudflare: tunnel token missing'); return null; }
    if (!url) { console.warn('[kakaotalk] cloudflare: public URL missing — set it in Cloudflare dashboard and enter here'); return null; }
    await startCloudflared(token);
    tunnelUrl = url;
    return url;
  }

  return null;
}

function stopTunnel() {
  const proc = tunnelProcess;
  tunnelProcess = null;
  tunnelUrl = null;
  tunnelProvider = null;
  if (proc) {
    try { proc.kill('SIGTERM'); } catch {}
    setTimeout(() => {
      try { if (!proc.killed) proc.kill('SIGKILL'); } catch {}
    }, 3_000);
  }
}

// ── 카카오 콜백 관리 ──

function storeCallback(channelId, userId, callbackUrl) {
  const key = `${channelId}:${userId}`;
  const existing = pendingCallbacks.get(key);
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => pendingCallbacks.delete(key), CALLBACK_TTL_MS);
  pendingCallbacks.set(key, { url: callbackUrl, timer });
}

function consumeCallback(channelId, userId) {
  const key = `${channelId}:${userId}`;
  const entry = pendingCallbacks.get(key);
  if (!entry) return null;
  clearTimeout(entry.timer);
  pendingCallbacks.delete(key);
  return entry.url;
}

// ── 카카오 응답 포맷 ──

function buildSimpleText(text) {
  return { version: '2.0', template: { outputs: [{ simpleText: { text } }] } };
}

function buildCallbackAck(waitMessage) {
  return { version: '2.0', useCallback: true, data: { text: waitMessage } };
}

function splitText(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    let cut = remaining.lastIndexOf('\n', maxLen);
    if (cut <= 0) cut = maxLen;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n/, '');
  }
  return chunks;
}

// ── 미디어 유틸 ──

function guessExtFromUrl(url) {
  try {
    const m = new URL(url).pathname.match(/(\.[a-zA-Z0-9]+)$/);
    return m ? m[1].toLowerCase() : '';
  } catch { return ''; }
}

function guessImageMime(ext) {
  const map = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
  return map[ext] || 'image/png';
}

// ── ChannelPluginModule ──

function createChannel({ channelId, config, onConfigUpdate }) {
  channelConfigs.set(channelId, config || {});
  if (onConfigUpdate) configUpdateFn = onConfigUpdate;
  activeChannelId = channelId;

  return {
    channelId,
    name: `kakaotalk:${channelId}`,

    async connect() {
      const cfg = channelConfigs.get(channelId) || {};
      const provider = cfg.tunnel_provider || 'manual';

      if (provider !== 'manual' && !tunnelProcess) {
        try {
          const port = 3210;
          const url = await startTunnel(cfg, port);
          if (url && configUpdateFn) {
            const updatedCfg = { ...cfg, public_url: url };
            channelConfigs.set(channelId, updatedCfg);
            configUpdateFn(channelId, updatedCfg);
            console.log(`[kakaotalk] Tunnel ready: ${url}`);
          }
        } catch (err) {
          console.error(`[kakaotalk] Tunnel start failed: ${err.message}`);
        }
      }
    },

    async sendMessage(jid, text) {
      const callbackUrl = consumeCallback(channelId, jid);
      if (!callbackUrl) return;

      const chunks = splitText(text, KAKAO_TEXT_LIMIT);
      const payload = buildSimpleText(chunks.join('\n\n---\n\n'));

      try {
        const resp = await fetch(callbackUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!resp.ok) console.error(`[kakaotalk] callback POST failed: ${resp.status}`);
      } catch (err) {
        console.error(`[kakaotalk] callback POST error: ${err.message}`);
      }
    },

    isConnected() { return true; },

    async disconnect() {
      channelConfigs.delete(channelId);
      stopTunnel();
    },
  };
}

function handleWebhook({ method, body, channelId, onMessage }) {
  const jsonHeader = { 'Content-Type': 'application/json; charset=utf-8' };

  if (method === 'GET') {
    return {
      status: 200, headers: jsonHeader,
      body: JSON.stringify({ status: 'ok', channel: 'kakaotalk', channelId, tunnel: tunnelProvider || 'none' }),
    };
  }

  let payload;
  try { payload = JSON.parse(body); }
  catch { return { status: 400, headers: jsonHeader, body: JSON.stringify({ error: 'invalid JSON' }) }; }

  const utterance = payload?.userRequest?.utterance;
  const userId = payload?.userRequest?.user?.id;
  const callbackUrl = payload?.userRequest?.callbackUrl;
  const media = payload?.userRequest?.params?.media;

  if (!userId) {
    return { status: 400, headers: jsonHeader, body: JSON.stringify({ error: 'missing user.id' }) };
  }

  const attachments = [];
  if (media && media.url) {
    const ext = guessExtFromUrl(media.url) || (media.type === 'image' ? '.png' : '');
    const filename = `kakao-${media.type || 'file'}-${Date.now()}${ext}`;
    const mediaType = media.type === 'image' ? guessImageMime(ext) : 'application/octet-stream';
    attachments.push({ url: media.url, filename, size: 0, mediaType });
  }

  const isMediaOnly = media && media.url && utterance === media.url;
  const text = isMediaOnly ? '' : (utterance || '');

  if (!text && attachments.length === 0) {
    return { status: 400, headers: jsonHeader, body: JSON.stringify({ error: 'missing utterance and media' }) };
  }

  const config = channelConfigs.get(channelId) || {};
  const waitMessage = config.wait_message || '잠시만 기다려주세요, 답변을 준비하고 있어요...';

  const context = { isDM: true };
  if (attachments.length > 0) context.attachments = attachments;

  if (callbackUrl) {
    storeCallback(channelId, userId, callbackUrl);
    onMessage(channelId, userId, userId, text || '[첨부파일]', context);
    return { status: 200, headers: jsonHeader, body: JSON.stringify(buildCallbackAck(waitMessage)) };
  }

  return {
    status: 200, headers: jsonHeader,
    body: JSON.stringify(buildSimpleText(
      '이 봇은 AI 챗봇 콜백 모드에서만 응답할 수 있습니다.\n챗봇 관리자센터에서 해당 블록의 콜백 설정을 활성화해주세요.',
    )),
  };
}

module.exports = { createChannel, handleWebhook };
