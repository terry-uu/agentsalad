/**
 * Groq Provider - Groq API 직접 호출
 *
 * Groq는 Chat Completions API (/chat/completions)만 지원.
 * @ai-sdk/openai v3가 Responses API를 기본 사용하므로
 * @ai-sdk/openai-compatible 로 Chat Completions 포맷 강제.
 */
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';

const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';

export function createGroqModel(params: {
  model: string;
  apiKey: string;
  baseUrl?: string;
}): LanguageModel {
  const provider = createOpenAICompatible({
    name: 'groq',
    apiKey: params.apiKey,
    baseURL: params.baseUrl || GROQ_BASE_URL,
  });

  return provider.chatModel(params.model);
}
