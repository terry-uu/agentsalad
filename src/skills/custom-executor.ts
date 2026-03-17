/**
 * Custom Skill Script Executor
 *
 * 파일 기반 + 인라인 스크립트 실행 엔진.
 * 파일 기반(기본): store/skills/<skill-id>/run.sh 실행.
 * 인라인(하위호환): DB에 저장된 스크립트 본문을 bash -c로 실행.
 * 입력: JSON stdin + INPUT_* 환경변수 (이중 전달).
 * 출력: stdout/stderr/exitCode 수집.
 */
import { exec } from 'child_process';
import { logger } from '../logger.js';

const MAX_OUTPUT = 64 * 1024; // 64KB

export interface ScriptResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function buildInputEnv(input: Record<string, unknown>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    env[`INPUT_${key.toUpperCase()}`] = String(value ?? '');
  }
  return env;
}

function runScript(
  command: string,
  input: Record<string, unknown>,
  workspacePath: string,
  timeoutMs: number,
): Promise<ScriptResult> {
  const inputEnv = buildInputEnv(input);
  const inputJson = JSON.stringify(input);

  return new Promise((resolve) => {
    const child = exec(
      command,
      {
        cwd: workspacePath,
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT,
        shell: '/bin/bash',
        env: {
          ...process.env,
          HOME: workspacePath,
          ...inputEnv,
          INPUT_JSON: inputJson,
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          const timedOut = error.killed || error.signal === 'SIGTERM';
          if (timedOut) {
            logger.debug({ timeoutMs }, 'Custom skill script timed out');
          }
          resolve({
            exitCode: error.code ?? 1,
            stdout: stdout.slice(0, MAX_OUTPUT),
            stderr: timedOut
              ? `Script timed out after ${timeoutMs}ms`
              : stderr.slice(0, MAX_OUTPUT) || error.message,
          });
          return;
        }
        resolve({
          exitCode: 0,
          stdout: stdout.slice(0, MAX_OUTPUT),
          stderr: stderr.slice(0, MAX_OUTPUT),
        });
      },
    );

    child.stdin?.write(JSON.stringify(input));
    child.stdin?.end();
  });
}

/**
 * 파일 기반 스크립트 실행 (기본 경로).
 * store/skills/<skill-id>/run.sh 를 직접 실행한다.
 */
export async function executeScriptFile(
  scriptPath: string,
  input: Record<string, unknown>,
  workspacePath: string,
  timeoutMs: number,
): Promise<ScriptResult> {
  const command = `bash ${escapeShellArg(scriptPath)}`;
  return runScript(command, input, workspacePath, timeoutMs);
}

/**
 * 인라인 스크립트 실행 (하위 호환용).
 * DB에 저장된 스크립트 본문을 bash -c로 실행.
 */
export async function executeCustomScript(
  script: string,
  input: Record<string, unknown>,
  workspacePath: string,
  timeoutMs: number,
): Promise<ScriptResult> {
  const command = `bash -c ${escapeShellArg(script)}`;
  return runScript(command, input, workspacePath, timeoutMs);
}

/** 셸 인자를 single-quote로 이스케이프 */
function escapeShellArg(arg: string): string {
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}
