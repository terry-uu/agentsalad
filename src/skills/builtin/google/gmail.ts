/**
 * Builtin Skill: google_gmail — Gmail 읽기/검색/전송
 *
 * gog CLI로 Gmail 조작. 설치 필요: brew install gogcli
 * OAuth 설정 필요: gog auth credentials + gog auth add
 */
import { tool } from 'ai';
import { z } from 'zod';

import type { BuiltinSkill } from '../../types.js';
import { isGogAvailable, runGog } from './index.js';

export const googleGmailSkill: BuiltinSkill = {
  id: 'google_gmail',
  name: 'Gmail',
  description: 'Gmail 검색, 읽기, 전송 (gog CLI 필요)',
  category: 'google',
  systemPrompt: `You can access Gmail using gmail_search, gmail_read, and gmail_send tools. Use standard Gmail search operators for queries (e.g., "newer_than:7d", "from:user@example.com", "is:unread").`,
  isAvailable: () => isGogAvailable(),
  createTools: () => ({
    gmail_search: tool({
      description: 'Search Gmail messages. Uses Gmail search operators.',
      inputSchema: z.object({
        query: z
          .string()
          .describe('Gmail search query (e.g., "newer_than:7d is:unread")'),
        max: z
          .number()
          .optional()
          .default(10)
          .describe('Max results (default 10)'),
      }),
      execute: async ({ query, max }) => {
        const result = await runGog(
          `gmail search '${query.replace(/'/g, "\\'")}' --max ${max}`,
        );
        return result;
      },
    }),
    gmail_read: tool({
      description: 'Read a specific Gmail message by ID.',
      inputSchema: z.object({
        messageId: z.string().describe('Gmail message ID'),
      }),
      execute: async ({ messageId }) => {
        const result = await runGog(`gmail get ${messageId}`);
        return result;
      },
    }),
    gmail_send: tool({
      description: 'Send an email via Gmail.',
      inputSchema: z.object({
        to: z.string().describe('Recipient email address'),
        subject: z.string().describe('Email subject'),
        body: z.string().describe('Email body text'),
      }),
      execute: async ({ to, subject, body }) => {
        const result = await runGog(
          `gmail send --to '${to}' --subject '${subject.replace(/'/g, "\\'")}' --body '${body.replace(/'/g, "\\'")}'`,
        );
        return result;
      },
    }),
  }),
};
