/**
 * Builtin Skill: bash — 셸 명령 실행
 *
 * 에이전트 워크스페이스를 cwd로 하여 셸 명령을 실행.
 * 타임아웃 30초, stdout+stderr 크기 제한.
 */
import { exec } from 'child_process';
import { tool } from 'ai';
import { z } from 'zod';

import type { BuiltinSkill } from '../types.js';

const EXEC_TIMEOUT = 30_000;
const MAX_OUTPUT = 64 * 1024; // 64KB

export const bashSkill: BuiltinSkill = {
  id: 'bash',
  name: 'Shell Command',
  description: '워크스페이스에서 셸 명령을 실행합니다',
  category: 'system',
  systemPrompt: `You can execute shell commands using the run_command tool. Commands run in your workspace directory with a 30-second timeout. Use this for file processing, data transformation, or system queries.`,
  isAvailable: () => true,
  createTools: (ctx) => ({
    run_command: tool({
      description:
        'Execute a shell command in the agent workspace directory. Returns stdout and stderr.',
      inputSchema: z.object({
        command: z.string().describe('Shell command to execute'),
      }),
      execute: async ({ command }) => {
        return new Promise((resolve) => {
          exec(
            command,
            {
              cwd: ctx.workspacePath,
              timeout: EXEC_TIMEOUT,
              maxBuffer: MAX_OUTPUT,
              env: { ...process.env, HOME: ctx.workspacePath },
            },
            (error, stdout, stderr) => {
              if (error) {
                resolve({
                  exitCode: error.code ?? 1,
                  stdout: stdout.slice(0, MAX_OUTPUT),
                  stderr: stderr.slice(0, MAX_OUTPUT) || error.message,
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
        });
      },
    }),
  }),
};
