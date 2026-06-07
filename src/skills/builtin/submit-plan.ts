/**
 * Builtin Skill: submit_plan — 구조화된 실행 계획 제출
 *
 * Smart Step 활성 에이전트 전용. 에이전트가 복잡한 멀티스텝 작업을
 * 분석한 후 실행 계획을 제출하면, 시스템이 _plan-{serviceId}.json으로
 * 저장하고 plan-executor가 배치 단위로 순차 실행을 중재.
 *
 * 서비스별 플랜 파일: 멀티타겟 환경에서 동일 에이전트의 여러 서비스가
 * 동시에 플랜을 실행해도 파일 충돌 없음.
 */
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tool } from 'ai';
import { z } from 'zod';

import type { BuiltinSkill } from '../types.js';

export interface PlanStep {
  description: string;
  status: 'pending' | 'done' | 'error';
}

export interface PlanFile {
  summary: string;
  steps: PlanStep[];
  batch_size: number;
  started_at: string;
  current_batch: number;
}

export const submitPlanSkill: BuiltinSkill = {
  id: 'submit_plan',
  name: 'Submit Plan',
  description: '구조화된 실행 계획을 제출하여 시스템이 단계별 자동 실행을 중재',
  category: 'smart_step',
  systemPrompt: '',
  isAvailable: () => true,
  createTools: (ctx) => ({
    submit_plan: tool({
      description:
        'Submit a structured execution plan for a complex multi-step task. The system will automatically execute each batch of steps in sequence. Only use this when the task genuinely requires multiple turns.',
      inputSchema: z.object({
        summary: z.string().describe('Brief summary of the overall task'),
        steps: z
          .array(
            z.object({
              description: z
                .string()
                .describe('Specific, actionable description for this step'),
            }),
          )
          .min(1)
          .describe('Ordered list of steps to execute'),
        batch_size: z
          .number()
          .min(1)
          .max(10)
          .default(3)
          .describe('Number of steps to process per turn (1-10, default 3)'),
      }),
      execute: async ({ summary, steps, batch_size }) => {
        const maxSteps =
          ((ctx as unknown as Record<string, unknown>)
            .maxPlanSteps as number) || 10;

        if (steps.length > maxSteps) {
          return {
            error: `Plan exceeds maximum step count (${steps.length}/${maxSteps}). Reduce the number of steps.`,
          };
        }

        if (steps.some((s) => !s.description.trim())) {
          return { error: 'All steps must have a non-empty description.' };
        }

        const plan: PlanFile = {
          summary,
          steps: steps.map((s) => ({
            description: s.description,
            status: 'pending' as const,
          })),
          batch_size: Math.min(batch_size, steps.length),
          started_at: new Date().toISOString(),
          current_batch: 0,
        };

        // 플랜 파일은 에이전트 워크스페이스 루트에 서비스별로 저장
        const serviceId = ctx.serviceId || 'unknown';
        const planDir = ctx.agentWorkspacePath;
        if (!existsSync(planDir)) mkdirSync(planDir, { recursive: true });
        const planPath = join(planDir, `_plan-${serviceId}.json`);
        writeFileSync(planPath, JSON.stringify(plan, null, 2), 'utf-8');

        const totalBatches = Math.ceil(steps.length / plan.batch_size);

        return {
          accepted: true,
          total_steps: steps.length,
          batch_size: plan.batch_size,
          total_batches: totalBatches,
          message: `Plan accepted. ${steps.length} steps will be executed in ${totalBatches} batches.`,
        };
      },
    }),
  }),
};
