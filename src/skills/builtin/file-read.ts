/**
 * Builtin Skill: file_read — 워크스페이스 파일 읽기 (멀티모달 지원)
 *
 * 타겟별 워크스페이스 내 파일을 읽는다. _shared/ 경로로 공용 폴더 접근 가능.
 * 경로 탈출 방지: resolveWorkspacePath로 스코핑.
 *
 * 파일 타입별 자동 처리 (에이전트 개입 없음):
 * - 텍스트: UTF-8 직접 읽기 (512KB 제한)
 * - 문서(PDF, Excel): 캐시 있으면 캐시, 없으면 네이티브 + 백그라운드 캐시 생성
 * - 이미지: 항상 toModelOutput media (캐시 불가)
 */
import { readFileSync, existsSync, statSync } from 'fs';
import { tool } from 'ai';
import { z } from 'zod';

import type { BuiltinSkill } from '../types.js';
import { resolveWorkspacePath } from '../workspace.js';
import {
  classifyFile,
  readCache,
  writeCache,
  parseDocument,
} from './file-cache.js';

const MAX_TEXT_SIZE = 512 * 1024; // 512KB — 텍스트 컨텍스트 직접 소비
const PARSE_FAILED_MARKER = '__PARSE_FAILED__';

/** 확장자 → MIME type 매핑 */
function inferMediaType(filename: string): string {
  const ext =
    filename.lastIndexOf('.') >= 0
      ? filename.slice(filename.lastIndexOf('.')).toLowerCase()
      : '';
  const map: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.xlsx':
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.xls': 'application/vnd.ms-excel',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml',
  };
  return map[ext] || 'application/octet-stream';
}

/** execute 반환 타입: toModelOutput에서 분기 판단용 */
interface TextResult {
  content: string;
  size: number;
}

interface NativeResult {
  nativeData: string;
  mediaType: string;
  filename: string;
}

interface ErrorResult {
  error: string;
}

type ReadFileOutput = TextResult | NativeResult | ErrorResult;

function isError(o: ReadFileOutput): o is ErrorResult {
  return 'error' in o;
}

function isNative(o: ReadFileOutput): o is NativeResult {
  return 'nativeData' in o;
}

export const fileReadSkill: BuiltinSkill = {
  id: 'file_read',
  name: 'File Read',
  description:
    '워크스페이스 내 파일을 읽습니다 (PDF, 이미지, Excel 등 멀티모달 지원)',
  category: 'file',
  systemPrompt: `You can read files from your workspace using the read_file tool. Specify a relative path within your workspace. Use _shared/ prefix to access the shared folder.
Supported file types:
- Text files (.txt, .md, .json, .csv, etc.): Read as UTF-8 text
- Documents (.pdf, .xlsx): Automatically returns cached text if available, or sends natively on first read
- Images (.png, .jpg, .gif, .webp): Always sent natively for visual understanding
Just call read_file with the path — the system handles format and caching automatically.`,
  isAvailable: () => true,
  createTools: (ctx) => ({
    read_file: tool({
      description:
        'Read a file from the workspace. Supports text, PDF, Excel, and images. Use _shared/ prefix for shared folder. The system automatically handles caching and native delivery.',
      inputSchema: z.object({
        path: z
          .string()
          .describe(
            'Relative file path within workspace (use _shared/ for shared folder)',
          ),
      }),
      execute: async ({ path }): Promise<ReadFileOutput> => {
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

        const filename = path.split('/').pop() || path;
        const category = classifyFile(filename);

        if (category === 'text' || category === 'unknown') {
          if (stat.size > MAX_TEXT_SIZE) {
            return {
              error: `File too large (${Math.round(stat.size / 1024)}KB). Max for text: ${MAX_TEXT_SIZE / 1024}KB`,
            };
          }
          return {
            content: readFileSync(fullPath, 'utf-8'),
            size: stat.size,
          };
        }

        if (category === 'image') {
          const buffer = readFileSync(fullPath);
          return {
            nativeData: buffer.toString('base64'),
            mediaType: inferMediaType(filename),
            filename,
          };
        }

        // category === 'document' (PDF, Excel)
        // 캐시 우선: 있으면 무조건 캐시 반환
        const cached = readCache(fullPath);
        if (cached !== null) {
          if (cached === PARSE_FAILED_MARKER) {
            const buffer = readFileSync(fullPath);
            return {
              nativeData: buffer.toString('base64'),
              mediaType: inferMediaType(filename),
              filename,
            };
          }
          return { content: cached, size: Buffer.byteLength(cached, 'utf-8') };
        }

        // 캐시 없음: 네이티브 전송 + 백그라운드 캐시 생성
        const buffer = readFileSync(fullPath);

        parseDocument(buffer, filename)
          .then((parsed) => {
            writeCache(fullPath, parsed ?? PARSE_FAILED_MARKER);
          })
          .catch(() => {
            writeCache(fullPath, PARSE_FAILED_MARKER);
          });

        return {
          nativeData: buffer.toString('base64'),
          mediaType: inferMediaType(filename),
          filename,
        };
      },
      toModelOutput({ output }: { output: ReadFileOutput }) {
        if (isError(output)) {
          return {
            type: 'content' as const,
            value: [{ type: 'text' as const, text: JSON.stringify(output) }],
          };
        }
        if (isNative(output)) {
          return {
            type: 'content' as const,
            value: [
              {
                type: 'media' as const,
                data: output.nativeData,
                mediaType: output.mediaType,
              },
            ],
          };
        }
        return {
          type: 'content' as const,
          value: [
            { type: 'text' as const, text: (output as TextResult).content },
          ],
        };
      },
    }),
  }),
};
