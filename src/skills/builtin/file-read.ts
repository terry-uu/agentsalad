/**
 * Builtin Skill: file_read — 워크스페이스 파일 읽기
 *
 * 타겟별 워크스페이스 내 파일을 읽는다. _shared/ 경로로 공용 폴더 접근 가능.
 * 경로 탈출 방지: resolveWorkspacePath로 스코핑.
 */
import { readFileSync, existsSync, statSync } from 'fs';
import { tool } from 'ai';
import { z } from 'zod';

import type { BuiltinSkill } from '../types.js';
import { resolveWorkspacePath } from '../workspace.js';

const MAX_READ_SIZE = 512 * 1024; // 512KB

export const fileReadSkill: BuiltinSkill = {
  id: 'file_read',
  name: 'File Read',
  description: '워크스페이스 내 파일을 읽습니다',
  category: 'file',
  systemPrompt: `You can read files from your workspace using the read_file tool. Specify a relative path within your workspace. Use _shared/ prefix to access the shared folder.`,
  isAvailable: () => true,
  createTools: (ctx) => ({
    read_file: tool({
      description:
        'Read a file from the workspace. Provide a relative path. Use _shared/ prefix for shared folder.',
      inputSchema: z.object({
        path: z
          .string()
          .describe(
            'Relative file path within workspace (use _shared/ for shared folder)',
          ),
      }),
      execute: async ({ path }) => {
        const fullPath = resolveWorkspacePath(
          ctx.workspacePath,
          path,
          ctx.agentWorkspacePath,
        );
        if (!existsSync(fullPath)) {
          return { error: `File not found: ${path}` };
        }
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          return { error: `Path is a directory, not a file: ${path}` };
        }
        if (stat.size > MAX_READ_SIZE) {
          return {
            error: `File too large (${Math.round(stat.size / 1024)}KB). Max: ${MAX_READ_SIZE / 1024}KB`,
          };
        }
        return { content: readFileSync(fullPath, 'utf-8'), size: stat.size };
      },
    }),
  }),
};
