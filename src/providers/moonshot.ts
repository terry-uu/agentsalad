/**
 * Moonshot AI Provider (Kimi) — 전용 SDK(@ai-sdk/moonshotai)로 직접 호출
 *
 * Kimi K2/K2.5, moonshot-v1 시리즈 지원.
 * 전용 SDK가 base URL, 에러 처리, thinking mode 등을 내부 관리.
 * base_url이 비어있으면 SDK 기본값(https://api.moonshot.ai/v1) 사용.
 */
import { createMoonshotAI } from '@ai-sdk/moonshotai';
import type { LanguageModel } from 'ai';

export function createMoonshotModel(params: {
  model: string;
  apiKey: string;
  baseUrl?: string;
}): LanguageModel {
  const provider = createMoonshotAI({
    apiKey: params.apiKey,
    baseURL: params.baseUrl || undefined,
  });

  return provider(params.model);
}
