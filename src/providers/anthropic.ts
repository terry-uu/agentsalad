/**
 * Anthropic Provider - Claude 모델 직접 호출
 * @ai-sdk/anthropic 사용
 */
import { createAnthropic } from '@ai-sdk/anthropic';
import type { LanguageModel } from 'ai';

export function createAnthropicModel(params: {
  model: string;
  apiKey: string;
  baseUrl?: string;
}): LanguageModel {
  const provider = createAnthropic({
    apiKey: params.apiKey,
    baseURL: params.baseUrl || undefined,
  });

  return provider(params.model);
}
