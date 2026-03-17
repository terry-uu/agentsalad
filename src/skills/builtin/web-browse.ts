/**
 * Builtin Skill: web_browse — Playwright 헤드리스 브라우저
 *
 * Playwright로 웹페이지를 자동화. navigate → content/click/type 패턴.
 * Playwright가 설치되지 않은 환경에서는 isAvailable()이 false를 반환.
 *
 * 추후 Playwright 설치 시 활성화:
 *   npm install playwright
 *   npx playwright install chromium
 */
import { tool } from 'ai';
import { z } from 'zod';

import type { BuiltinSkill } from '../types.js';

let playwrightAvailable: boolean | null = null;

function checkPlaywright(): boolean {
  if (playwrightAvailable !== null) return playwrightAvailable;
  try {
    require.resolve('playwright');
    playwrightAvailable = true;
  } catch {
    playwrightAvailable = false;
  }
  return playwrightAvailable;
}

export const webBrowseSkill: BuiltinSkill = {
  id: 'web_browse',
  name: 'Web Browser',
  description: 'Playwright로 웹 브라우저를 제어합니다',
  category: 'web',
  systemPrompt: `You can control a headless web browser using browse_navigate, browse_content, browse_click, and browse_type tools. Navigate to a page first, then interact with it.`,
  isAvailable: () => checkPlaywright(),
  createTools: () => {
    if (!checkPlaywright()) return {};

    // Dynamic import — playwright 미설치 환경에서 타입 에러 방지
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const pw = require('playwright');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let browserPromise: Promise<any> | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let currentPage: any = null;

    async function getBrowser() {
      if (!browserPromise) {
        browserPromise = pw.chromium.launch({ headless: true });
      }
      return browserPromise;
    }

    async function getPage() {
      if (!currentPage || currentPage.isClosed()) {
        const browser = await getBrowser();
        currentPage = await browser.newPage();
      }
      return currentPage;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools: Record<string, any> = {
      browse_navigate: tool({
        description:
          'Navigate the browser to a URL and return the page text content.',
        inputSchema: z.object({ url: z.string().url() }),
        execute: async ({ url }) => {
          const page = await getPage();
          await page.goto(url, {
            waitUntil: 'domcontentloaded',
            timeout: 20_000,
          });
          const title = await page.title();
          const text = await page.innerText('body').catch(() => '');
          return { title, url: page.url(), content: text.slice(0, 8000) };
        },
      }),
      browse_content: tool({
        description: 'Get the current page text content without navigating.',
        inputSchema: z.object({}),
        execute: async () => {
          const page = await getPage();
          const title = await page.title();
          const text = await page.innerText('body').catch(() => '');
          return { title, url: page.url(), content: text.slice(0, 8000) };
        },
      }),
      browse_click: tool({
        description:
          'Click an element on the current page by CSS selector or text.',
        inputSchema: z.object({
          selector: z.string().describe('CSS selector or text to click'),
        }),
        execute: async ({ selector }) => {
          const page = await getPage();
          try {
            await page.click(selector, { timeout: 5000 });
            return { success: true, clicked: selector };
          } catch {
            try {
              await page.getByText(selector).first().click({ timeout: 5000 });
              return { success: true, clicked: selector };
            } catch (err) {
              return {
                error: `Could not click "${selector}": ${err instanceof Error ? err.message : String(err)}`,
              };
            }
          }
        },
      }),
      browse_type: tool({
        description: 'Type text into an input element on the current page.',
        inputSchema: z.object({
          selector: z.string().describe('CSS selector of the input element'),
          text: z.string().describe('Text to type'),
        }),
        execute: async ({ selector, text }) => {
          const page = await getPage();
          try {
            await page.fill(selector, text, { timeout: 5000 });
            return { success: true, selector, typed: text.length + ' chars' };
          } catch (err) {
            return {
              error: `Could not type into "${selector}": ${err instanceof Error ? err.message : String(err)}`,
            };
          }
        },
      }),
    };
    return tools;
  },
};
