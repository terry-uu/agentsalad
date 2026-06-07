/**
 * Builtin Skill: terminal — 타임아웃 없는 장시간 셸 실행
 *
 * bash 스킬(run_command, 30초)과 공존하는 장시간 실행 도구.
 * 코딩 에이전트(claude -p, opencode run) 등 완료까지 수 분 걸리는
 * 프로세스를 타임아웃 없이 대기. spawn 사용으로 stdout 버퍼 제한 없음.
 *
 * 시스템 환경을 그대로 상속 — HOME/USERPROFILE 덮어쓰지 않음.
 * 워크스페이스 경로는 CWD + WORKSPACE_DIR 환경변수로 전달.
 */
import { spawn } from 'child_process';
import { tool } from 'ai';
import { z } from 'zod';

import type { BuiltinSkill } from '../types.js';

const MAX_OUTPUT = 256 * 1024; // 256KB (장시간 작업은 출력이 클 수 있음)
const IS_WIN = process.platform === 'win32';

export const terminalSkill: BuiltinSkill = {
  id: 'terminal',
  name: 'Terminal',
  description: '타임아웃 없이 장시간 명령을 실행합니다 (코딩 에이전트 등)',
  category: 'system',
  systemPrompt: `You can execute long-running commands using the run_terminal tool. Unlike run_command (30s timeout), run_terminal has NO timeout — it waits until the process finishes. Use this for coding agents (claude -p, opencode run), builds, deployments, or any task that takes more than 30 seconds. Commands run in your workspace directory.`,
  isAvailable: () => true,
  createTools: (ctx) => ({
    run_terminal: tool({
      description:
        'Execute a long-running command with NO timeout. Waits until the process completes. Use for coding agents, builds, or any task that may take minutes.',
      inputSchema: z.object({
        command: z.string().describe('Shell command to execute'),
      }),
      execute: async ({ command }) => {
        return new Promise((resolve) => {
          const shell = IS_WIN ? process.env.COMSPEC || 'cmd.exe' : '/bin/bash';
          const args = IS_WIN ? ['/c', command] : ['-c', command];

          const child = spawn(shell, args, {
            cwd: ctx.workspacePath,
            env: { ...process.env, WORKSPACE_DIR: ctx.workspacePath },
            stdio: ['ignore', 'pipe', 'pipe'],
          });

          let stdout = '';
          let stderr = '';

          child.stdout.on('data', (chunk: Buffer) => {
            const text = chunk.toString();
            if (stdout.length < MAX_OUTPUT) {
              stdout += text.slice(0, MAX_OUTPUT - stdout.length);
            }
          });

          child.stderr.on('data', (chunk: Buffer) => {
            const text = chunk.toString();
            if (stderr.length < MAX_OUTPUT) {
              stderr += text.slice(0, MAX_OUTPUT - stderr.length);
            }
          });

          child.on('error', (err) => {
            resolve({
              exitCode: 1,
              stdout,
              stderr: err.message,
            });
          });

          child.on('close', (code) => {
            resolve({
              exitCode: code ?? 0,
              stdout,
              stderr,
            });
          });
        });
      },
    }),
  }),
};
