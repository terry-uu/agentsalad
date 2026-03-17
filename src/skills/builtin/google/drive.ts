/**
 * Builtin Skill: google_drive — Google Drive 파일 관리
 *
 * gog CLI로 Drive 조작. 파일 목록/검색/다운로드/업로드.
 * 다운로드는 에이전트 워크스페이스에 저장.
 */
import { tool } from 'ai';
import { z } from 'zod';

import type { BuiltinSkill } from '../../types.js';
import { isGogAvailable, runGog } from './index.js';

export const googleDriveSkill: BuiltinSkill = {
  id: 'google_drive',
  name: 'Google Drive',
  description: 'Google Drive 파일 조회/다운로드/업로드 (gog CLI 필요)',
  category: 'google',
  systemPrompt: `You can manage Google Drive files using drive_list, drive_download, and drive_upload tools. Downloaded files are saved to your workspace.`,
  isAvailable: () => isGogAvailable(),
  createTools: (ctx) => ({
    drive_list: tool({
      description: 'List or search files in Google Drive.',
      inputSchema: z.object({
        query: z
          .string()
          .optional()
          .describe(
            'Drive search query (e.g., "mimeType=\'application/pdf\'")',
          ),
        max: z
          .number()
          .optional()
          .default(20)
          .describe('Max results (default 20)'),
      }),
      execute: async ({ query, max }) => {
        const args = query
          ? `drive ls --query '${query.replace(/'/g, "\\'")}' --max ${max}`
          : `drive ls --max ${max}`;
        return runGog(args);
      },
    }),
    drive_download: tool({
      description: 'Download a file from Google Drive to the agent workspace.',
      inputSchema: z.object({
        fileId: z.string().describe('Google Drive file ID'),
        filename: z
          .string()
          .optional()
          .describe('Output filename (auto-detected if omitted)'),
      }),
      execute: async ({ fileId, filename }) => {
        const outPath = filename
          ? `${ctx.workspacePath}/${filename}`
          : ctx.workspacePath;
        const result = await runGog(
          `drive download ${fileId} --out '${outPath}'`,
        );
        return result;
      },
    }),
    drive_upload: tool({
      description: 'Upload a file from the agent workspace to Google Drive.',
      inputSchema: z.object({
        path: z.string().describe('Relative file path in workspace to upload'),
        parentId: z
          .string()
          .optional()
          .describe('Parent folder ID in Drive (root if omitted)'),
      }),
      execute: async ({ path, parentId }) => {
        const fullPath = `${ctx.workspacePath}/${path}`;
        let args = `drive upload '${fullPath}'`;
        if (parentId) args += ` --parent ${parentId}`;
        return runGog(args);
      },
    }),
  }),
};
