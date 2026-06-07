/**
 * Google Gemini Provider - Gemini 모델 직접 호출
 * @ai-sdk/google 사용
 */
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { LanguageModel } from 'ai';

export function createGoogleModel(params: {
  model: string;
  apiKey: string;
  baseUrl?: string;
}): LanguageModel {
  const provider = createGoogleGenerativeAI({
    apiKey: params.apiKey,
    baseURL: params.baseUrl || undefined,
  });

  return provider(params.model);
}
