/**
 * Builtin Skill: google_calendar — Google Calendar 일정 관리
 *
 * gog CLI (v0.12.0+) 서브커맨드로 Calendar 조작.
 * events: `gog calendar events [calendarId] --days N --max N`
 * create: `gog calendar create <calendarId> --summary ... --from ... --to ...`
 */
import { tool } from 'ai';
import { z } from 'zod';

import type { BuiltinSkill } from '../../types.js';
import { isGogAvailable, runGog } from './index.js';

export const googleCalendarSkill: BuiltinSkill = {
  id: 'google_calendar',
  name: 'Google Calendar',
  description: 'Google Calendar 일정 조회/생성 (gog CLI 필요)',
  category: 'google',
  systemPrompt: `You can manage Google Calendar using calendar_list and calendar_create tools. List upcoming events or create new ones. When creating events, use RFC3339 format for times (e.g. "2026-03-17T14:00:00+09:00").`,
  isAvailable: () => isGogAvailable(),
  createTools: () => ({
    calendar_list: tool({
      description:
        'List upcoming calendar events. Optionally filter by date range.',
      inputSchema: z.object({
        days: z
          .number()
          .optional()
          .default(7)
          .describe('Number of days to look ahead (default 7)'),
        max: z
          .number()
          .optional()
          .default(20)
          .describe('Max events to return (default 20)'),
      }),
      execute: async ({ days, max }) => {
        const result = await runGog(
          `calendar events --days ${days} --max ${max}`,
        );
        return result;
      },
    }),
    calendar_create: tool({
      description: 'Create a new calendar event.',
      inputSchema: z.object({
        summary: z.string().describe('Event title/summary'),
        from: z
          .string()
          .describe(
            'Start time in RFC3339 format (e.g. "2026-03-17T14:00:00+09:00")',
          ),
        to: z
          .string()
          .optional()
          .describe(
            'End time in RFC3339 format (defaults to 1 hour after start)',
          ),
        description: z.string().optional().describe('Event description'),
        location: z.string().optional().describe('Event location'),
      }),
      execute: async ({ summary, from, to, description, location }) => {
        const esc = (s: string) => s.replace(/'/g, "'\\''");
        let args = `calendar create primary --summary '${esc(summary)}' --from '${esc(from)}'`;
        if (to) args += ` --to '${esc(to)}'`;
        if (description) args += ` --description '${esc(description)}'`;
        if (location) args += ` --location '${esc(location)}'`;
        const result = await runGog(args);
        return result;
      },
    }),
  }),
};
