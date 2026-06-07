/**
 * OpenAI Provider - GPT 모델 직접 호출
 * @ai-sdk/openai 사용
 */
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';

export function createOpenAIModel(params: {
  model: string;
  apiKey: string;
  baseUrl?: string;
}): LanguageModel {
  const provider = createOpenAI({
    apiKey: params.apiKey,
    baseURL: params.baseUrl || undefined,
  });

  return provider(params.model);
}
