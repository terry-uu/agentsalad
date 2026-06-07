/**
 * GLM Provider (Zhipu AI) — OpenAI-compatible API 직접 호출
 *
 * GLM-5, GLM-4.7, GLM-4.5 시리즈 지원.
 * 공식 1st-party SDK 미존재, OpenAI-compatible API(@ai-sdk/openai-compatible) 사용.
 * base_url이 비어있으면 기본값(https://open.bigmodel.cn/api/paas/v4) 사용.
 */
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';

const DEFAULT_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4';

export function createGlmModel(params: {
  model: string;
  apiKey: string;
  baseUrl?: string;
}): LanguageModel {
  const provider = createOpenAICompatible({
    name: 'glm',
    apiKey: params.apiKey,
    baseURL: params.baseUrl || DEFAULT_BASE_URL,
  });

  return provider.chatModel(params.model);
}
