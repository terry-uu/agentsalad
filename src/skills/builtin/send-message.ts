/**
 * Builtin Skill: send_message — 턴 중간에 유저에게 메시지 전송
 *
 * Smart Step 활성 에이전트 전용. SkillContext.sendMessage 콜백을 통해
 * 플랜 실행 중 개별 결과를 즉시 전달하거나, 단일 턴 내에서
 * 여러 메시지를 나눠 보낼 때 사용.
 */
import { tool } from 'ai';
import { z } from 'zod';

import type { BuiltinSkill } from '../types.js';

export const sendMessageSkill: BuiltinSkill = {
  id: 'send_message',
  name: 'Send Message',
  description: '턴 중간에 유저에게 메시지를 즉시 전송',
  category: 'smart_step',
  systemPrompt: '',
  isAvailable: () => true,
  createTools: (ctx) => ({
    send_message: tool({
      description:
        'Send a message to the user immediately during your turn. Use this to deliver individual results without waiting for your full response.',
      inputSchema: z.object({
        text: z.string().describe('The message text to send to the user'),
      }),
      execute: async ({ text }) => {
        if (!ctx.sendMessage) {
          return { error: 'send_message is not available in this context' };
        }
        if (!text.trim()) {
          return { error: 'Message text cannot be empty' };
        }
        await ctx.sendMessage(text);
        return { sent: true };
      },
    }),
  }),
};
