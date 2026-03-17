/**
 * OpenRouter Provider - 여러 모델 통합 게이트웨이
 *
 * OpenRouter는 Chat Completions API (/chat/completions)만 지원.
 * @ai-sdk/openai v3가 Responses API를 기본 사용하므로
 * @ai-sdk/openai-compatible 로 Chat Completions 포맷 강제.
 */
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export function createOpenRouterModel(params: {
  model: string;
  apiKey: string;
  baseUrl?: string;
}): LanguageModel {
  const provider = createOpenAICompatible({
    name: 'openrouter',
    apiKey: params.apiKey,
    baseURL: params.baseUrl || OPENROUTER_BASE_URL,
  });

  return provider.chatModel(params.model);
}
