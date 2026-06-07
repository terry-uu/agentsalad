/**
 * File Cache — 워크스페이스 문서 파일의 로컬 파싱 캐시 관리
 *
 * 바이너리 문서를 로컬에서 텍스트로 파싱하여 캐시.
 * 지원 포맷: PDF(pdf-parse), Excel(xlsx), Word(mammoth), HWP(@ohah/hwpjs).
 * 최초 read_file 시 LLM 네이티브 전달과 동시에 캐시 생성.
 * 이후 read_file은 캐시된 텍스트를 반환하여 토큰 비용 절감.
 * 원본 파일의 mtime 변경 감지 시 캐시를 무효화하고 재생성.
 *
 * 캐시 위치: 원본 파일과 같은 디렉토리의 .file-cache/ 하위.
 * uploads/report.pdf  → uploads/.file-cache/report.pdf.txt
 * _shared/data.xlsx   → _shared/.file-cache/data.xlsx.txt
 * docs/proposal.docx  → docs/.file-cache/proposal.docx.txt
 * docs/공문.hwp        → docs/.file-cache/공문.hwp.txt
 * 이미지는 로컬 파싱 불가 → 캐시 대상이 아님 (항상 네이티브).
 */
import {
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
  mkdirSync,
} from 'node:fs';
import { join, basename, dirname } from 'node:path';

import { logger } from '../../logger.js';

interface CacheMeta {
  mtime: number;
  size: number;
  parsedAt: string;
}

const TEXT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.json',
  '.csv',
  '.xml',
  '.html',
  '.htm',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.cfg',
  '.conf',
  '.log',
  '.js',
  '.ts',
  '.jsx',
  '.tsx',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.c',
  '.cpp',
  '.h',
  '.hpp',
  '.cs',
  '.sh',
  '.bash',
  '.sql',
  '.r',
  '.lua',
  '.pl',
  '.swift',
  '.kt',
  '.scala',
  '.env',
  '.gitignore',
  '.dockerfile',
  '.makefile',
]);

const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.ico',
  '.svg',
]);

const DOCUMENT_EXTENSIONS = new Set([
  '.pdf',
  '.xlsx',
  '.xls',
  '.docx',
  '.doc',
  '.hwp',
  '.hwpx',
]);

export type FileCategory = 'text' | 'document' | 'image' | 'unknown';

/** 파일 확장자 기반 카테고리 판별 */
export function classifyFile(filename: string): FileCategory {
  const ext =
    filename.lastIndexOf('.') >= 0
      ? filename.slice(filename.lastIndexOf('.')).toLowerCase()
      : '';
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  if (DOCUMENT_EXTENSIONS.has(ext)) return 'document';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  return 'unknown';
}

/** 원본 파일 디렉토리 기준 .file-cache/ 경로 */
function ensureCacheDir(originalFilePath: string): string {
  const dir = join(dirname(originalFilePath), '.file-cache');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function getCacheTextPath(cachePath: string, filename: string): string {
  return join(cachePath, `${basename(filename)}.txt`);
}

function getCacheMetaPath(cachePath: string, filename: string): string {
  return join(cachePath, `${basename(filename)}.meta.json`);
}

/**
 * 캐시가 유효한지 확인 (mtime 기반).
 * 캐시는 원본 파일과 같은 디렉토리의 .file-cache/ 에 위치.
 */
export function readCache(originalFilePath: string): string | null {
  const fname = basename(originalFilePath);
  const cachePath = join(dirname(originalFilePath), '.file-cache');
  const textPath = getCacheTextPath(cachePath, fname);
  const metaPath = getCacheMetaPath(cachePath, fname);

  if (!existsSync(textPath) || !existsSync(metaPath)) return null;

  try {
    const meta: CacheMeta = JSON.parse(readFileSync(metaPath, 'utf-8'));
    const stat = statSync(originalFilePath);
    if (stat.mtimeMs !== meta.mtime || stat.size !== meta.size) {
      return null;
    }
    return readFileSync(textPath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * 파싱된 텍스트를 캐시에 저장.
 * 캐시는 원본 파일과 같은 디렉토리의 .file-cache/ 에 위치.
 */
export function writeCache(originalFilePath: string, parsedText: string): void {
  const fname = basename(originalFilePath);
  try {
    const cachePath = ensureCacheDir(originalFilePath);
    const stat = statSync(originalFilePath);
    const meta: CacheMeta = {
      mtime: stat.mtimeMs,
      size: stat.size,
      parsedAt: new Date().toISOString(),
    };
    writeFileSync(getCacheTextPath(cachePath, fname), parsedText, 'utf-8');
    writeFileSync(
      getCacheMetaPath(cachePath, fname),
      JSON.stringify(meta),
      'utf-8',
    );
  } catch (err) {
    logger.warn(
      {
        filename: fname,
        err: err instanceof Error ? err.message : String(err),
      },
      'Failed to write file cache',
    );
  }
}

/**
 * PDF 파일을 텍스트로 파싱.
 * 이미지나 복잡한 표는 소실될 수 있음 (fallback용).
 */
export async function parsePdf(buffer: Buffer): Promise<string> {
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  const result = await parser.getText();
  return result.text;
}

/**
 * Excel 파일을 시트별 마크다운 테이블로 변환.
 */
export async function parseExcel(buffer: Buffer): Promise<string> {
  const XLSX = await import('xlsx');
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheets: string[] = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rows: string[][] = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
    }) as string[][];

    if (rows.length === 0) continue;

    const header = rows[0].map((c: unknown) => String(c ?? ''));
    const separator = header.map(() => '---');
    const body = rows
      .slice(1)
      .map((row: unknown[]) => row.map((c: unknown) => String(c ?? '')));

    const table = [
      `## ${sheetName}`,
      '',
      `| ${header.join(' | ')} |`,
      `| ${separator.join(' | ')} |`,
      ...body.map((row) => `| ${row.join(' | ')} |`),
    ].join('\n');

    sheets.push(table);
  }

  return sheets.join('\n\n');
}

/**
 * Word(.docx) 파일을 마크다운으로 변환.
 * mammoth는 .docx(OOXML) 전용.
 */
export async function parseDocx(buffer: Buffer): Promise<string> {
  const mammoth = (await import('mammoth')) as unknown as {
    convertToMarkdown: (input: {
      buffer: Buffer;
    }) => Promise<{ value: string }>;
  };
  const result = await mammoth.convertToMarkdown({ buffer });
  return result.value;
}

/**
 * Word(.doc) 레거시 바이너리 파일을 텍스트로 변환.
 * word-extractor 사용 (OLE 기반, 외부 의존성 없음).
 */
export async function parseDoc(buffer: Buffer): Promise<string> {
  // @ts-expect-error word-extractor has no type declarations
  const { default: WordExtractor } = await import('word-extractor');
  const extractor = new WordExtractor();
  const doc = await extractor.extract(buffer);
  return doc.getBody();
}

/**
 * HWP 파일(CFB 포맷)을 마크다운으로 변환.
 * @ohah/hwpjs NAPI 바인딩 사용.
 */
export async function parseHwp(buffer: Buffer): Promise<string> {
  const hwpjs = await import('@ohah/hwpjs');
  const result = hwpjs.toMarkdown(buffer);
  return result.markdown;
}

/**
 * HWPX 파일(ZIP+XML 포맷)을 텍스트로 변환.
 * @ssabrojs/hwpxjs 사용. .hwpx는 ZIP 안에 OWPML XML이 들어있는 개방형 포맷.
 */
export async function parseHwpx(buffer: Buffer): Promise<string> {
  const { HwpxReader } = await import('@ssabrojs/hwpxjs');
  const reader = new HwpxReader();
  const arrayBuffer = new Uint8Array(buffer).buffer;
  await reader.loadFromArrayBuffer(arrayBuffer);
  return await reader.extractText();
}

/**
 * 문서 파일을 로컬에서 텍스트로 파싱.
 * 파싱 실패 시 null 반환 (LLM 네이티브에 의존).
 */
export async function parseDocument(
  buffer: Buffer,
  filename: string,
): Promise<string | null> {
  const ext =
    filename.lastIndexOf('.') >= 0
      ? filename.slice(filename.lastIndexOf('.')).toLowerCase()
      : '';

  try {
    if (ext === '.pdf') return await parsePdf(buffer);
    if (ext === '.xlsx' || ext === '.xls') return await parseExcel(buffer);
    if (ext === '.docx') return await parseDocx(buffer);
    if (ext === '.doc') return await parseDoc(buffer);
    if (ext === '.hwp') return await parseHwp(buffer);
    if (ext === '.hwpx') return await parseHwpx(buffer);
    return null;
  } catch (err) {
    logger.warn(
      { filename, err: err instanceof Error ? err.message : String(err) },
      'Local document parsing failed',
    );
    return null;
  }
}
