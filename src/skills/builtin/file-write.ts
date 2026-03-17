/**
 * Builtin Skill: file_write — 워크스페이스 파일 쓰기
 *
 * 타겟별 워크스페이스에 파일을 생성/수정한다. _shared/ 경로로 공용 폴더 쓰기 가능.
 * 하위 디렉토리가 없으면 자동 생성.
 */
import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { tool } from 'ai';
import { z } from 'zod';

import type { BuiltinSkill } from '../types.js';
import { resolveWorkspacePath } from '../workspace.js';

const MAX_WRITE_SIZE = 1024 * 1024; // 1MB

export const fileWriteSkill: BuiltinSkill = {
  id: 'file_write',
  name: 'File Write',
  description: '워크스페이스에 파일을 생성/수정합니다',
  category: 'file',
  systemPrompt: `You can write files to your workspace using the write_file tool. Provide a relative path and content. Subdirectories are created automatically. Use _shared/ prefix for the shared folder.`,
  isAvailable: () => true,
  createTools: (ctx) => ({
    write_file: tool({
      description:
        'Write or create a file in the workspace. Provide a relative path and content. Use _shared/ for shared folder.',
      inputSchema: z.object({
        path: z
          .string()
          .describe(
            'Relative file path within workspace (use _shared/ for shared folder)',
          ),
        content: z.string().describe('File content to write'),
      }),
      execute: async ({ path, content }) => {
        if (content.length > MAX_WRITE_SIZE) {
          return {
            error: `Content too large (${Math.round(content.length / 1024)}KB). Max: ${MAX_WRITE_SIZE / 1024}KB`,
          };
        }
        const fullPath = resolveWorkspacePath(
          ctx.workspacePath,
          path,
          ctx.agentWorkspacePath,
        );
        mkdirSync(dirname(fullPath), { recursive: true });
        writeFileSync(fullPath, content, 'utf-8');
        return { success: true, path, size: content.length };
      },
    }),
  }),
};
