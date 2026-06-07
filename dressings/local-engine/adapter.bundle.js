/**
 * Local Engine Dressing — adapter.bundle.js
 *
 * llama-server 서브프로세스를 관리하여 GGUF 모델을 로컬에서 직접 추론.
 * AgentPluginModule 인터페이스 구현: getEndpoint로 네이티브 Vercel AI SDK 연결,
 * loadModel/unloadModel로 모델 마운트 제어, start/stop으로 바이너리 라이프사이클 관리.
 *
 * 바이너리는 최초 start() 호출 시 자동 다운로드 (GitHub releases, b8678).
 * 서버는 loadModel() 호출 시에만 기동 — 유휴 시 프로세스 없음.
 * 단일 모델 전용: 새 모델 마운트 시 기존 서버 종료 후 재기동.
 *
 * Thinking 모델 처리:
 *   - stderr에서 thinking=1 감지 → detectedThinking 플래그
 *   - disable_thinking 설정 시: getEndpoint 정상 반환 + needsThinkingOff 플래그로
 *     코어가 chat_template_kwargs 주입 (tool calling 지원)
 *   - disable_thinking 미설정 시: getEndpoint null → wrapAsLanguageModel 폴백 (텍스트 전용)
 *     streamChat에서 enable_thinking:false 자동 주입
 */
'use strict';

const { spawn, execSync } = require('child_process');
const {
  existsSync,
  mkdirSync,
  createWriteStream,
  chmodSync,
  unlinkSync,
  readdirSync,
  statSync,
} = require('fs');
const { join, basename } = require('path');
const { platform: osPlatform, arch: osArch } = require('os');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

const LLAMA_VERSION = 'b8678';
const RELEASE_BASE = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_VERSION}`;
const DEFAULT_PORT = 18200;
const HEALTH_TIMEOUT_MS = 120_000;
const DOWNLOAD_TIMEOUT_MS = 300_000;

let serverProcess = null;
let currentModelPath = null;
let currentModelId = null;
let binDir = null;
let serverPort = DEFAULT_PORT;
let adapterConfig = {};
let lastServerStderr = '';
let detectedThinking = false;

// ── Platform Detection ──

function getPlatformArchive() {
  const p = osPlatform();
  const a = osArch();
  const map = {
    'darwin-arm64': `llama-${LLAMA_VERSION}-bin-macos-arm64.tar.gz`,
    'darwin-x64': `llama-${LLAMA_VERSION}-bin-macos-x64.tar.gz`,
    'linux-x64': `llama-${LLAMA_VERSION}-bin-ubuntu-x64.tar.gz`,
    'linux-arm64': `llama-${LLAMA_VERSION}-bin-ubuntu-arm64.tar.gz`,
    'win32-x64': `llama-${LLAMA_VERSION}-bin-win-cpu-x64.zip`,
    'win32-arm64': `llama-${LLAMA_VERSION}-bin-win-cpu-arm64.zip`,
  };
  const key = `${p}-${a}`;
  const archive = map[key];
  if (!archive) throw new Error(`Unsupported platform: ${key}`);
  return archive;
}

function getBinaryName() {
  return osPlatform() === 'win32' ? 'llama-server.exe' : 'llama-server';
}

function getBinaryPath() {
  return join(binDir, getBinaryName());
}

// ── Binary Management ──

function findFileRecursive(dir, name) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isFile() && e.name === name) return full;
    if (e.isDirectory()) {
      const found = findFileRecursive(full, name);
      if (found) return found;
    }
  }
  return null;
}

async function downloadBinary() {
  const archive = getPlatformArchive();
  const url = `${RELEASE_BASE}/${archive}`;
  const tmpPath = join(binDir, archive);

  console.log(`[local-engine] Downloading llama-server ${LLAMA_VERSION} ...`);

  const resp = await fetch(url, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!resp.ok)
    throw new Error(
      `Download failed: ${resp.status} ${resp.statusText} — ${url}`,
    );

  const ws = createWriteStream(tmpPath);
  await pipeline(Readable.fromWeb(resp.body), ws);

  // Extract using system tools (no npm dependencies)
  if (archive.endsWith('.tar.gz')) {
    execSync(`tar xzf "${tmpPath}" -C "${binDir}"`, { timeout: 60_000 });
  } else {
    execSync(
      `powershell -Command "Expand-Archive -Path '${tmpPath}' -DestinationPath '${binDir}' -Force"`,
      { timeout: 60_000 },
    );
  }

  try {
    unlinkSync(tmpPath);
  } catch {}

  // Archives extract into a subdirectory (e.g. llama-b8678/).
  // Move ALL files (binaries + shared libs) to bin/ root.
  const subDirs = readdirSync(binDir, { withFileTypes: true })
    .filter((e) => e.isDirectory());
  for (const sub of subDirs) {
    const subPath = join(binDir, sub.name);
    const files = readdirSync(subPath);
    for (const f of files) {
      const src = join(subPath, f);
      const dst = join(binDir, f);
      if (!existsSync(dst)) {
        const { renameSync: mvSync } = require('fs');
        mvSync(src, dst);
      }
    }
    // Clean up empty subdirectory
    try { const { rmdirSync } = require('fs'); rmdirSync(subPath); } catch {}
  }

  const binPath = getBinaryPath();
  if (!existsSync(binPath))
    throw new Error('llama-server binary not found after extraction');

  if (osPlatform() !== 'win32') {
    // Make all binaries executable
    for (const f of readdirSync(binDir)) {
      const fp = join(binDir, f);
      try { if (statSync(fp).isFile()) chmodSync(fp, 0o755); } catch {}
    }
  }
  console.log('[local-engine] llama-server ready');
}

// ── Health Check ──

async function waitForHealth(timeoutMs) {
  const url = `http://127.0.0.1:${serverPort}/health`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!serverProcess) {
      const tail = lastServerStderr.trim().split('\n').slice(-8).join('\n');
      throw new Error(`llama-server crashed` + (tail ? `:\n${tail}` : ''));
    }
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (r.ok) {
        const d = await r.json();
        if (d.status === 'ok' || d.status === 'no slot available') return;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `llama-server health check timed out after ${timeoutMs / 1000}s`,
  );
}

// ── AgentPluginModule ──

module.exports = {
  /**
   * 바이너리 존재 확인, 없으면 다운로드. 서버는 아직 안 띄움.
   */
  async start(config) {
    binDir = join(__dirname, 'bin');
    mkdirSync(binDir, { recursive: true });
    adapterConfig = config || {};
    serverPort = Number(config.port) || DEFAULT_PORT;

    if (!existsSync(getBinaryPath())) {
      await downloadBinary();
    }
  },

  async stop() {
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 1500));
      if (serverProcess && !serverProcess.killed) serverProcess.kill('SIGKILL');
      serverProcess = null;
      currentModelPath = null;
      currentModelId = null;
    }
  },

  getEndpoint(_config) {
    if (!serverProcess || !currentModelId) return null;
    // thinking 모델 + thinking 미해제 → AI SDK가 reasoning_content 처리 못함
    if (detectedThinking && !adapterConfig.disable_thinking) return null;
    return {
      baseUrl: `http://127.0.0.1:${serverPort}/v1`,
      // disable_thinking이 설정된 thinking 모델: API 요청에 chat_template_kwargs 주입 필요
      needsThinkingOff: detectedThinking && adapterConfig.disable_thinking,
    };
  },

  async getModelStatus() {
    if (!serverProcess || !currentModelId)
      return [];
    try {
      const r = await fetch(
        `http://127.0.0.1:${serverPort}/v1/models`,
        { signal: AbortSignal.timeout(3_000) },
      );
      if (r.ok) {
        const d = await r.json();
        if (d.data && d.data.length > 0) {
          return d.data.map((m) => ({
            id: m.id || currentModelId,
            status: 'loaded',
          }));
        }
      }
    } catch {}
    return [{ id: currentModelId, status: 'loaded' }];
  },

  async loadModel(modelPath) {
    if (!binDir)
      return { success: false, error: 'Plugin not initialized — call start() first' };

    const binPath = getBinaryPath();
    if (!existsSync(binPath))
      return { success: false, error: 'llama-server binary missing. Restart plugin.' };

    if (!existsSync(modelPath))
      return { success: false, error: `Model file not found: ${modelPath}` };

    // Kill existing server (managed process)
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 1500));
      if (serverProcess && !serverProcess.killed)
        serverProcess.kill('SIGKILL');
      serverProcess = null;
    }

    // Kill orphan process occupying the port (e.g. zombie from ungraceful shutdown)
    try {
      const pid = execSync(`lsof -ti:${serverPort} 2>/dev/null`, { encoding: 'utf-8' }).trim();
      if (pid) {
        console.log(`[local-engine] Killing orphan process on port ${serverPort} (pid ${pid})`);
        execSync(`kill -9 ${pid} 2>/dev/null`);
        await new Promise((r) => setTimeout(r, 500));
      }
    } catch {}

    const gpuLayers = String(adapterConfig.gpu_layers ?? -1);
    const ctxSize = String(adapterConfig.ctx_size ?? 8192);
    const threads = Number(adapterConfig.threads) || 0;

    const args = [
      '--model', modelPath,
      '--port', String(serverPort),
      '--jinja',
      '-ngl', gpuLayers,
      '--ctx-size', ctxSize,
    ];
    if (threads > 0) args.push('-t', String(threads));
    if (adapterConfig.flash_attn === true) args.push('--flash-attn', 'on');
    else if (adapterConfig.flash_attn === false) args.push('--flash-attn', 'off');
    if (adapterConfig.mlock) args.push('--mlock');

    lastServerStderr = '';
    detectedThinking = false;

    try {
      serverProcess = spawn(binPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
        env: {
          ...process.env,
          DYLD_LIBRARY_PATH: binDir,
          LD_LIBRARY_PATH: binDir,
        },
      });

      serverProcess.stderr?.on('data', (chunk) => {
        const text = chunk.toString();
        lastServerStderr += text;
        if (lastServerStderr.length > 4000) lastServerStderr = lastServerStderr.slice(-4000);
        if (/thinking\s*=\s*1/.test(text)) {
          detectedThinking = true;
          console.log('[local-engine] Detected thinking model — will inject enable_thinking:false');
        }
        process.stderr.write('[local-engine] ' + text);
      });

      serverProcess.stdout?.on('data', (chunk) => {
        process.stdout.write('[local-engine] ' + chunk.toString());
      });

      serverProcess.on('error', (err) => {
        console.error('[local-engine] Process error:', err.message);
        serverProcess = null;
        currentModelPath = null;
        currentModelId = null;
      });

      serverProcess.on('exit', (code) => {
        if (code !== null && code !== 0) {
          const tail = lastServerStderr.trim().split('\n').slice(-5).join('\n');
          console.error(`[local-engine] Server exited with code ${code}${tail ? '\n' + tail : ''}`);
        }
        serverProcess = null;
        currentModelPath = null;
        currentModelId = null;
      });

      await waitForHealth(HEALTH_TIMEOUT_MS);

      currentModelPath = modelPath;
      currentModelId = basename(modelPath);
      return { success: true };
    } catch (err) {
      if (serverProcess) {
        serverProcess.kill('SIGTERM');
        serverProcess = null;
      }
      return { success: false, error: err.message };
    }
  },

  async unloadModel(_modelId) {
    if (!serverProcess) return { success: true };

    serverProcess.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 1500));
    if (serverProcess && !serverProcess.killed) serverProcess.kill('SIGKILL');
    serverProcess = null;
    currentModelPath = null;
    currentModelId = null;
    return { success: true };
  },

  /**
   * streamChat — getEndpoint 미지원 코어용 하위호환.
   * 직접 fetch로 /v1/chat/completions SSE 호출.
   */
  async *streamChat({ messages, model, config }) {
    const url = `http://127.0.0.1:${serverPort}/v1/chat/completions`;
    const body = {
      model: model || currentModelId || 'local',
      messages,
      stream: true,
    };
    if (detectedThinking || adapterConfig.disable_thinking) {
      body.chat_template_kwargs = { enable_thinking: false };
    }
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`LLM error ${resp.status}: ${text}`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') {
          yield { type: 'finish', usage: {} };
          return;
        }
        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) yield { type: 'text', text: delta };
        } catch {}
      }
    }

    yield { type: 'finish', usage: {} };
  },

  async listModels(_params) {
    try {
      const r = await fetch(
        `http://127.0.0.1:${serverPort}/v1/models`,
        { signal: AbortSignal.timeout(3_000) },
      );
      if (r.ok) {
        const d = await r.json();
        return (d.data || []).map((m) => m.id);
      }
    } catch {}
    return currentModelId ? [currentModelId] : [];
  },

  async testConnection(_params) {
    try {
      const r = await fetch(
        `http://127.0.0.1:${serverPort}/health`,
        { signal: AbortSignal.timeout(5_000) },
      );
      if (r.ok) return { ok: true };
      return { ok: false, error: `Health check: ${r.status}` };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },
};
