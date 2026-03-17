/**
 * Builtin Skill: file_list — 워크스페이스 파일 목록
 *
 * 타겟별 워크스페이스의 파일/디렉토리 목록을 조회한다.
 * _shared/ 경로로 공용 폴더 조회 가능. 재귀 탐색 1단계.
 */
import { readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { tool } from 'ai';
import { z } from 'zod';

import type { BuiltinSkill } from '../types.js';
import { resolveWorkspacePath } from '../workspace.js';

const MAX_ENTRIES = 200;

interface FileEntry {
  name: string;
  type: 'file' | 'directory';
  size?: number;
}

function listDir(dirPath: string, basePath: string): FileEntry[] {
  const entries: FileEntry[] = [];
  try {
    const items = readdirSync(dirPath, { withFileTypes: true });
    for (const item of items) {
      if (entries.length >= MAX_ENTRIES) break;
      const fullPath = join(dirPath, item.name);
      const relPath = relative(basePath, fullPath);
      if (item.isDirectory()) {
        entries.push({ name: relPath + '/', type: 'directory' });
      } else if (item.isFile()) {
        const stat = statSync(fullPath);
        entries.push({ name: relPath, type: 'file', size: stat.size });
      }
    }
  } catch {
    /* permission errors etc */
  }
  return entries;
}

export const fileListSkill: BuiltinSkill = {
  id: 'file_list',
  name: 'File List',
  description: '워크스페이스 파일 목록을 조회합니다',
  category: 'file',
  systemPrompt: `You can list files in your workspace using the list_files tool. Optionally specify a subdirectory path. Use _shared/ to list the shared folder.`,
  isAvailable: () => true,
  createTools: (ctx) => ({
    list_files: tool({
      description:
        'List files and directories in the workspace. Optionally specify a subdirectory. Use _shared/ for the shared folder.',
      inputSchema: z.object({
        directory: z
          .string()
          .optional()
          .describe(
            'Relative subdirectory path (default: workspace root, use _shared/ for shared folder)',
          ),
      }),
      execute: async ({ directory }) => {
        const targetPath = directory
          ? resolveWorkspacePath(
              ctx.workspacePath,
              directory,
              ctx.agentWorkspacePath,
            )
          : ctx.workspacePath;
        const basePath =
          directory?.replace(/^[/\\]+/, '').startsWith('_shared') &&
          ctx.agentWorkspacePath
            ? join(ctx.agentWorkspacePath, '_shared')
            : ctx.workspacePath;
        const entries = listDir(targetPath, basePath);
        return {
          entries,
          count: entries.length,
          truncated: entries.length >= MAX_ENTRIES,
        };
      },
    }),
  }),
};
