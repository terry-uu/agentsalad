/**
 * ServerManager — agentsalad 서버 프로세스 생명주기 관리
 *
 * 경량 패키징: Electron 앱에는 dist/ + package.json만 번들.
 * 첫 실행 시 시스템 Node.js를 감지하고, npm install을 자동 실행한 뒤 서버를 시작.
 *
 * PATH 복원: macOS GUI 앱은 터미널 PATH를 상속받지 못함.
 * 로그인 셸($SHELL -lc)에서 실제 PATH를 가져와 모든 child_process에 주입.
 *
 * 상태 흐름:
 *   stopped → (start)
 *     → checking   : PATH 복원 + Node.js 감지
 *     → installing : npm install --production (node_modules 없을 때)
 *     → starting   : 서버 프로세스 spawn + health check
 *     → running    : 서버 정상 가동
 *     → error      : 어느 단계든 실패
 */
import { EventEmitter } from 'events';
import { spawn, execFile, type ChildProcess } from 'child_process';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { app } from 'electron';

export type ServerStatus =
  | 'stopped'
  | 'checking'
  | 'installing'
  | 'starting'
  | 'running'
  | 'error';

const HEALTH_CHECK_URL = 'http://127.0.0.1:3210';
const HEALTH_POLL_MS = 500;
const HEALTH_TIMEOUT_MS = 60_000;
const INSTALL_TIMEOUT_MS = 300_000;
const GRACEFUL_KILL_MS = 3_000;
const LOG_BUFFER_MAX = 300;

export class ServerManager extends EventEmitter {
  private process: ChildProcess | null = null;
  private _status: ServerStatus = 'stopped';
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private healthStartedAt = 0;
  private logBuffer: string[] = [];
  private isExternalServer = false;
  private isStopping = false;
  private runningWatchTimer: ReturnType<typeof setInterval> | null = null;
  /** 로그인 셸에서 복원한 환경변수 (PATH 포함) */
  private shellEnv: Record<string, string> | null = null;

  get status(): ServerStatus {
    return this._status;
  }

  get logs(): string[] {
    return [...this.logBuffer];
  }

  private getAppRoot(): string {
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'app-server');
    }
    return app.getAppPath();
  }

  // ── 셸 환경 복원 ──────────────────────────────────────────

  /**
   * macOS/Linux GUI 앱은 터미널 PATH를 상속받지 못함.
   * 사용자의 로그인 셸을 통해 실제 환경변수를 가져온다.
   * Windows는 GUI도 시스템 PATH를 상속하므로 불필요.
   */
  private resolveShellEnv(): Promise<Record<string, string>> {
    if (this.shellEnv) return Promise.resolve(this.shellEnv);
    if (process.platform === 'win32') {
      this.shellEnv = { ...process.env } as Record<string, string>;
      return Promise.resolve(this.shellEnv);
    }

    return new Promise((resolve) => {
      const loginShell = process.env.SHELL || '/bin/zsh';
      this.appendLog(`[setup] Resolving PATH from ${loginShell}...`);

      const child = execFile(loginShell, ['-lc', 'env'], {
        timeout: 5_000,
        encoding: 'utf-8',
      }, (err, stdout) => {
        if (err || !stdout) {
          this.appendLog('[setup] Shell env resolution failed, using fallback PATH');
          this.shellEnv = this.buildFallbackEnv();
          resolve(this.shellEnv);
          return;
        }

        const env: Record<string, string> = {};
        for (const line of stdout.split('\n')) {
          const idx = line.indexOf('=');
          if (idx > 0) {
            env[line.slice(0, idx)] = line.slice(idx + 1);
          }
        }

        if (env.PATH) {
          this.appendLog(`[setup] PATH resolved (${env.PATH.split(':').length} entries)`);
        }
        this.shellEnv = { ...process.env, ...env } as Record<string, string>;
        resolve(this.shellEnv);
      });
    });
  }

  /** 셸 env 실패 시 흔한 Node.js 경로를 직접 추가 */
  private buildFallbackEnv(): Record<string, string> {
    const home = process.env.HOME || '';
    const extra = [
      '/usr/local/bin',
      '/opt/homebrew/bin',
      `${home}/.nvm/versions/node`,
      `${home}/.volta/bin`,
      `${home}/.fnm/aliases/default/bin`,
    ];
    const currentPath = process.env.PATH || '/usr/bin:/bin';
    return {
      ...process.env,
      PATH: `${extra.join(':')}:${currentPath}`,
    } as Record<string, string>;
  }

  // ── 외부 서버 감지 ─────────────────────────────────────────

  async detectRunningServer(): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.get(HEALTH_CHECK_URL, { timeout: 2_000 }, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 500) {
          this.appendLog('[electron] Detected existing server on :3210');
          this.isExternalServer = true;
          this.setStatus('running');
          resolve(true);
        } else {
          resolve(false);
        }
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
    });
  }

  // ── 메인 시작 흐름 ────────────────────────────────────────

  async start(): Promise<void> {
    if (
      this._status === 'checking' ||
      this._status === 'installing' ||
      this._status === 'starting' ||
      this._status === 'running'
    )
      return;

    this.isExternalServer = false;
    this.isStopping = false;
    this.logBuffer = [];

    try {
      this.setStatus('checking');

      // 0) 셸 PATH 복원
      const env = await this.resolveShellEnv();

      // 1) Node.js 감지
      await this.detectNode(env);

      // 2) node_modules 없으면 설치
      const appRoot = this.getAppRoot();
      const modulesDir = path.join(appRoot, 'node_modules');
      if (!fs.existsSync(modulesDir)) {
        this.setStatus('installing');
        await this.runNpmInstall(appRoot, env);
      }

      // 3) 서버 시작
      this.setStatus('starting');
      this.spawnServer(appRoot, env);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.appendLog(`[electron] Setup failed: ${msg}`);
      this.setStatus('error');
    }
  }

  // ── Node.js 감지 ──────────────────────────────────────────

  private detectNode(env: Record<string, string>): Promise<void> {
    return new Promise((resolve, reject) => {
      this.appendLog('[setup] Checking Node.js...');
      const check = spawn('node', ['--version'], {
        stdio: 'pipe',
        env,
      });
      let version = '';

      check.stdout?.on('data', (d: Buffer) => {
        version += d.toString().trim();
      });

      check.on('error', () => {
        reject(
          new Error(
            'Node.js not found. Install Node.js 20+ from https://nodejs.org',
          ),
        );
      });

      check.on('exit', (code) => {
        if (code !== 0) {
          reject(new Error('Node.js check failed'));
          return;
        }
        this.appendLog(`[setup] Node.js ${version} detected`);

        const major = parseInt(version.replace('v', ''), 10);
        if (major < 20) {
          reject(
            new Error(
              `Node.js ${version} is too old. Version 20+ required.`,
            ),
          );
          return;
        }
        resolve();
      });
    });
  }

  // ── npm install ───────────────────────────────────────────

  private runNpmInstall(
    appRoot: string,
    env: Record<string, string>,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      this.appendLog('[setup] Installing dependencies (npm install)...');
      this.appendLog('[setup] This may take a minute on first launch.');

      const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      const child = spawn(
        npmCmd,
        ['install', '--production', '--no-optional'],
        {
          cwd: appRoot,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: INSTALL_TIMEOUT_MS,
        },
      );

      child.stdout?.on('data', (chunk: Buffer) => {
        const line = chunk.toString().trimEnd();
        if (line) this.appendLog(`[npm] ${line}`);
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        const line = chunk.toString().trimEnd();
        if (line && !line.startsWith('npm warn')) {
          this.appendLog(`[npm] ${line}`);
        }
      });

      child.on('error', (err) => {
        reject(new Error(`npm install failed: ${err.message}`));
      });

      child.on('exit', (code) => {
        if (code === 0) {
          this.appendLog('[setup] Dependencies installed successfully.');
          resolve();
        } else {
          reject(new Error(`npm install exited with code ${code}`));
        }
      });
    });
  }

  // ── 서버 프로세스 spawn ───────────────────────────────────

  private spawnServer(
    appRoot: string,
    env: Record<string, string>,
  ): void {
    const serverEntry = path.join(appRoot, 'dist', 'index.js');
    this.appendLog(`[electron] Starting server: node ${serverEntry}`);

    this.process = spawn('node', [serverEntry], {
      cwd: appRoot,
      env: {
        ...env,
        NODE_ENV: 'production',
        WEB_UI_ENABLED: 'true',
        WEB_UI_HOST: '127.0.0.1',
        WEB_UI_PORT: '3210',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.process.stdout?.on('data', (chunk: Buffer) => {
      this.appendLog(chunk.toString().trimEnd());
    });

    this.process.stderr?.on('data', (chunk: Buffer) => {
      this.appendLog(`[stderr] ${chunk.toString().trimEnd()}`);
    });

    this.process.on('error', (err) => {
      this.appendLog(`[electron] Process error: ${err.message}`);
      this.cleanupProcess();
      this.setStatus('error');
    });

    this.process.on('exit', (code, signal) => {
      this.appendLog(
        `[electron] Process exited (code=${code}, signal=${signal})`,
      );
      this.cleanupProcess();
      if (this.isStopping) return;
      if (this._status === 'running' || this._status === 'starting') {
        this.setStatus(code === 0 ? 'stopped' : 'error');
      }
    });

    this.startHealthCheck();
  }

  // ── 서버 정지 ─────────────────────────────────────────────

  async stop(): Promise<void> {
    this.stopHealthCheck();
    this.stopRunningWatch();

    if (this.isExternalServer) {
      this.isExternalServer = false;
      this.setStatus('stopped');
      return;
    }

    if (!this.process || this.process.killed) {
      this.setStatus('stopped');
      return;
    }

    this.isStopping = true;
    this.appendLog('[electron] Stopping server (SIGTERM)...');
    this.process.kill('SIGTERM');

    const exited = await this.waitForExit(GRACEFUL_KILL_MS);
    if (!exited && this.process && !this.process.killed) {
      this.appendLog('[electron] Graceful shutdown timeout, sending SIGKILL');
      this.process.kill('SIGKILL');
      await this.waitForExit(2_000);
    }

    this.cleanupProcess();
    this.isStopping = false;
    this.setStatus('stopped');
  }

  // ── Health check ──────────────────────────────────────────

  private startHealthCheck(): void {
    this.healthStartedAt = Date.now();
    this.healthTimer = setInterval(() => {
      this.checkHealth();
    }, HEALTH_POLL_MS);
  }

  private stopHealthCheck(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  private checkHealth(): void {
    if (this._status !== 'starting') {
      this.stopHealthCheck();
      return;
    }

    if (Date.now() - this.healthStartedAt > HEALTH_TIMEOUT_MS) {
      this.appendLog('[electron] Health check timeout (60s)');
      this.stopHealthCheck();
      this.setStatus('error');
      return;
    }

    const req = http.get(HEALTH_CHECK_URL, { timeout: 2_000 }, (res) => {
      if (res.statusCode && res.statusCode >= 200 && res.statusCode < 500) {
        this.stopHealthCheck();
        this.appendLog('[electron] Server is ready');
        this.setStatus('running');
      }
      res.resume();
    });
    req.on('error', () => {});
    req.on('timeout', () => req.destroy());
  }

  // ── Running watch ─────────────────────────────────────────

  private startRunningWatch(): void {
    this.stopRunningWatch();
    this.runningWatchTimer = setInterval(() => {
      const req = http.get(HEALTH_CHECK_URL, { timeout: 3_000 }, (res) => {
        res.resume();
      });
      req.on('error', () => {
        if (this._status === 'running') {
          this.appendLog('[electron] Server is no longer reachable');
          this.stopRunningWatch();
          this.isExternalServer = false;
          this.setStatus('stopped');
        }
      });
      req.on('timeout', () => req.destroy());
    }, 5_000);
  }

  private stopRunningWatch(): void {
    if (this.runningWatchTimer) {
      clearInterval(this.runningWatchTimer);
      this.runningWatchTimer = null;
    }
  }

  // ── 내부 유틸 ─────────────────────────────────────────────

  private setStatus(status: ServerStatus): void {
    if (this._status === status) return;
    this._status = status;
    this.emit('status-changed', status);

    if (status === 'running') {
      this.startRunningWatch();
    } else {
      this.stopRunningWatch();
    }
  }

  private appendLog(line: string): void {
    this.logBuffer.push(line);
    if (this.logBuffer.length > LOG_BUFFER_MAX) {
      this.logBuffer.shift();
    }
    this.emit('log', line);
  }

  private waitForExit(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (!this.process || this.process.killed) {
        resolve(true);
        return;
      }
      const timer = setTimeout(() => {
        this.process?.removeListener('exit', onExit);
        resolve(false);
      }, ms);
      const onExit = () => {
        clearTimeout(timer);
        resolve(true);
      };
      this.process.once('exit', onExit);
    });
  }

  private cleanupProcess(): void {
    this.stopHealthCheck();
    this.process = null;
  }
}
