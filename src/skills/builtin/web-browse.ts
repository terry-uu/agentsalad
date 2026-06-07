/**
 * Builtin Skill: web_browse — Chrome Extension 기반 브라우저 제어 (12개 도구)
 *
 * Playwright를 제거하고, 유저의 실제 Chrome에 설치된 Agent Salad Extension으로
 * browser-use 스타일 state-first, index-based 상호작용을 구현.
 *
 * 핵심 흐름: browse_state → 인덱스 맵 확인 → browse_click/type/select → browse_state 재확인
 * Extension이 연결되지 않으면 모든 도구가 안내 메시지를 반환.
 *
 * 스크린샷은 Extension의 chrome.tabs.captureVisibleTab()으로 캡처,
 * base64 PNG를 workspace에 저장 후 채팅으로 전송.
 */
import { tool } from 'ai';
import { z } from 'zod';
import { join } from 'path';
import { mkdirSync, writeFileSync } from 'fs';

import type { BuiltinSkill, SkillContext } from '../types.js';
import { browserBridge } from './browser-bridge.js';
import { logger } from '../../logger.js';

const NOT_CONNECTED =
  'Browser extension not connected. Install the Agent Salad Browser extension in Chrome and connect to this server.';

function ensureConnected(): void {
  if (!browserBridge.isConnected()) throw new Error(NOT_CONNECTED);
}

async function cmd(
  action: string,
  params: Record<string, unknown> = {},
  timeout?: number,
): Promise<unknown> {
  ensureConnected();
  return browserBridge.sendCommand(action, params, timeout);
}

export const webBrowseSkill: BuiltinSkill = {
  id: 'web_browse',
  name: 'Web Browser',
  description: 'Chrome Extension으로 유저의 실제 브라우저를 제어합니다',
  category: 'web',
  systemPrompt: `You have direct control over the user's real Chrome browser via an extension.

## When to use browser tools
- The user asks you to do something ON a website (click, type, read, navigate, post, search, play, etc.)
- You are already in the middle of a browser interaction
- The task requires seeing or interacting with web page content
In these cases, you MUST use the browser tools. NEVER pretend you did something without actually calling the tools. NEVER say "I clicked" or "I typed" unless you actually called browse_click or browse_type.

## How to use browser tools
1. ALWAYS call browse_state FIRST to see the current page and available elements with their indices.
2. Use the index numbers from browse_state to interact: browse_click(index), browse_type(index, text), etc.
3. After performing an action, call browse_state again to verify the result.
4. NEVER guess or fabricate what is on the page. If you haven't called browse_state, you don't know what's there.

## Rules
- Do NOT guess CSS selectors — use indices only.
- Do NOT claim you performed an action unless the tool call succeeded.
- If browse_state shows the page changed, re-read it before acting.`,
  isAvailable: () => true,
  createTools: (ctx: SkillContext) => ({
    browse_state: tool({
      description:
        "Get the current tab's interactive elements as an indexed list. ALWAYS call this first before interacting. Returns [index]<tag attrs /> text format.",
      inputSchema: z.object({
        viewportOnly: z
          .boolean()
          .optional()
          .describe(
            'Only show elements visible in the current viewport (default: false)',
          ),
      }),
      execute: async ({ viewportOnly }) => {
        try {
          const res = (await cmd('state', {
            viewportOnly: viewportOnly ?? false,
          })) as { _raw_text?: string };
          return res._raw_text ?? JSON.stringify(res);
        } catch (err) {
          return formatError('browse_state', err);
        }
      },
    }),

    browse_navigate: tool({
      description:
        'Navigate the active tab to a URL. Returns the final URL and page title.',
      inputSchema: z.object({
        url: z
          .string()
          .describe('URL to navigate to (https:// prefix optional)'),
      }),
      execute: async ({ url }) => {
        try {
          return await cmd('navigate', { url }, 30_000);
        } catch (err) {
          return formatError('browse_navigate', err);
        }
      },
    }),

    browse_click: tool({
      description: 'Click an element by its index from browse_state.',
      inputSchema: z.object({
        index: z
          .number()
          .int()
          .describe('Element index from browse_state output'),
      }),
      execute: async ({ index }) => {
        try {
          return await cmd('click', { index });
        } catch (err) {
          return formatError('browse_click', err);
        }
      },
    }),

    browse_type: tool({
      description:
        'Type text into an input element by its index. Clears existing value first.',
      inputSchema: z.object({
        index: z.number().int().describe('Element index from browse_state'),
        text: z.string().describe('Text to type'),
      }),
      execute: async ({ index, text }) => {
        try {
          return await cmd('type', { index, text });
        } catch (err) {
          return formatError('browse_type', err);
        }
      },
    }),

    browse_keys: tool({
      description: 'Send keyboard input (e.g. "Enter", "Ctrl+a", "Escape").',
      inputSchema: z.object({
        keys: z
          .string()
          .describe('Key combo: "Enter", "Tab", "Ctrl+a", "Shift+Tab", etc.'),
      }),
      execute: async ({ keys }) => {
        try {
          return await cmd('keys', { keys });
        } catch (err) {
          return formatError('browse_keys', err);
        }
      },
    }),

    browse_select: tool({
      description: 'Select an option from a <select> dropdown by index.',
      inputSchema: z.object({
        index: z
          .number()
          .int()
          .describe('Element index of the <select> from browse_state'),
        value: z.string().describe('Option value or visible text to select'),
      }),
      execute: async ({ index, value }) => {
        try {
          return await cmd('select', { index, value });
        } catch (err) {
          return formatError('browse_select', err);
        }
      },
    }),

    browse_screenshot: tool({
      description:
        'Take a screenshot of the current tab. Saved to workspace and sent to the user in chat.',
      inputSchema: z.object({
        filename: z
          .string()
          .optional()
          .describe('Optional filename (default: screenshot-<timestamp>.png)'),
      }),
      execute: async ({ filename }) => {
        try {
          const res = (await cmd('screenshot', {}, 10_000)) as {
            screenshot?: string;
            url?: string;
            title?: string;
          };
          if (!res.screenshot) return { error: 'No screenshot data returned' };

          const fname = filename || `screenshot-${Date.now()}.png`;
          const screenshotDir = join(ctx.workspacePath, '_screenshots');
          mkdirSync(screenshotDir, { recursive: true });
          const filePath = join(screenshotDir, fname);

          const base64 = res.screenshot.replace(/^data:image\/\w+;base64,/, '');
          const buffer = Buffer.from(base64, 'base64');
          writeFileSync(filePath, buffer);

          logger.debug({ filePath, bytes: buffer.length }, 'Screenshot saved');

          let sentToChat = false;
          if (ctx.sendPhoto) {
            try {
              await ctx.sendPhoto(filePath, res.title || undefined);
              sentToChat = true;
            } catch (photoErr) {
              logger.warn(
                {
                  err:
                    photoErr instanceof Error
                      ? photoErr.message
                      : String(photoErr),
                },
                'Failed to send screenshot to chat',
              );
            }
          }

          return {
            success: true,
            path: filePath,
            relativePath: `_screenshots/${fname}`,
            url: res.url,
            title: res.title,
            sizeBytes: buffer.length,
            sentToChat,
          };
        } catch (err) {
          return formatError('browse_screenshot', err);
        }
      },
    }),

    browse_scroll: tool({
      description: 'Scroll the page up or down.',
      inputSchema: z.object({
        direction: z.enum(['up', 'down']).describe('Scroll direction'),
        pixels: z
          .number()
          .optional()
          .describe('Pixels to scroll (default: 500)'),
      }),
      execute: async ({ direction, pixels }) => {
        try {
          return await cmd('scroll', { direction, pixels });
        } catch (err) {
          return formatError('browse_scroll', err);
        }
      },
    }),

    browse_eval: tool({
      description: 'Execute JavaScript code in the current tab.',
      inputSchema: z.object({
        code: z.string().describe('JavaScript code to evaluate'),
      }),
      execute: async ({ code }) => {
        try {
          return await cmd('eval', { code });
        } catch (err) {
          return formatError('browse_eval', err);
        }
      },
    }),

    browse_tabs: tool({
      description: 'List all open browser tabs.',
      inputSchema: z.object({}),
      execute: async () => {
        try {
          return await cmd('tabs');
        } catch (err) {
          return formatError('browse_tabs', err);
        }
      },
    }),

    browse_tab_switch: tool({
      description: 'Switch to a different tab by its index from browse_tabs.',
      inputSchema: z.object({
        tabIndex: z
          .number()
          .int()
          .describe('Tab index from browse_tabs output'),
      }),
      execute: async ({ tabIndex }) => {
        try {
          return await cmd('tab_switch', { tabIndex });
        } catch (err) {
          return formatError('browse_tab_switch', err);
        }
      },
    }),

    browse_wait: tool({
      description: 'Wait for an element or text to appear on the page.',
      inputSchema: z.object({
        selector: z.string().optional().describe('CSS selector to wait for'),
        text: z.string().optional().describe('Text content to wait for'),
        timeout: z
          .number()
          .optional()
          .describe('Max wait time in ms (default: 5000, max: 30000)'),
      }),
      execute: async ({ selector, text, timeout }) => {
        try {
          const waitTimeout = Math.min(timeout ?? 5000, 30000);
          return await cmd(
            'wait',
            { selector, text, timeout: waitTimeout },
            waitTimeout + 2000,
          );
        } catch (err) {
          return formatError('browse_wait', err);
        }
      },
    }),
  }),
};

function formatError(tool: string, err: unknown): { error: string } {
  const msg = err instanceof Error ? err.message : String(err);
  logger.warn({ tool, err: msg }, `${tool} failed`);
  return { error: msg };
}
