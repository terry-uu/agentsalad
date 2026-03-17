/**
 * Builtin Skill: web_fetch — URL 콘텐츠 가져오기
 *
 * HTTP/HTTPS URL에서 콘텐츠를 가져와 텍스트로 변환.
 * HTML은 주요 텍스트만 추출 (스크립트/스타일/네비게이션 제거).
 */
import { tool } from 'ai';
import { z } from 'zod';

import type { BuiltinSkill } from '../types.js';

const MAX_RESPONSE_SIZE = 256 * 1024; // 256KB
const FETCH_TIMEOUT = 15_000;

/** 간이 HTML → 텍스트 변환 (cheerio 없이 동작, 설치 시 대체 가능) */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_RESPONSE_SIZE);
}

export const webFetchSkill: BuiltinSkill = {
  id: 'web_fetch',
  name: 'Web Fetch',
  description: 'URL에서 웹페이지 내용을 가져옵니다',
  category: 'web',
  systemPrompt: `You can fetch web page content using the fetch_url tool. Provide a full URL (https://...). The HTML is converted to plain text automatically.`,
  isAvailable: () => true,
  createTools: () => ({
    fetch_url: tool({
      description:
        'Fetch content from a URL and return it as plain text. HTML tags are stripped.',
      inputSchema: z.object({
        url: z
          .string()
          .url()
          .describe('Full URL to fetch (must start with http:// or https://)'),
      }),
      execute: async ({ url }) => {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
          const response = await fetch(url, {
            signal: controller.signal,
            headers: { 'User-Agent': 'AgentSalad/1.0 (Bot)' },
          });
          clearTimeout(timeout);

          if (!response.ok) {
            return { error: `HTTP ${response.status}: ${response.statusText}` };
          }

          const contentType = response.headers.get('content-type') || '';
          const raw = await response.text();

          if (
            contentType.includes('text/html') ||
            contentType.includes('application/xhtml')
          ) {
            return { content: htmlToText(raw), url, contentType: 'html' };
          }
          return {
            content: raw.slice(0, MAX_RESPONSE_SIZE),
            url,
            contentType: contentType.split(';')[0],
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('abort'))
            return { error: `Fetch timeout (${FETCH_TIMEOUT / 1000}s)` };
          return { error: `Fetch failed: ${msg}` };
        }
      },
    }),
  }),
};
