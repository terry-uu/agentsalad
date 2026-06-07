/**
 * OpenCode Provider (Zen gateway) — 모델 유형에 따라 자동 라우팅
 *
 * GPT 계열 → OpenAI Responses API (/responses) via @ai-sdk/openai
 * Claude 계열 → Anthropic Messages API (/messages) via @ai-sdk/anthropic
 * 그 외 (MiniMax, GLM, Kimi 등) → Chat Completions (/chat/completions) via @ai-sdk/openai-compatible
 *
 * @ai-sdk/openai v3 에서 compatibility 옵션이 삭제되어,
 * OpenAI-compatible 모델은 별도 패키지(@ai-sdk/openai-compatible)로 처리.
 */
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createAnthropic } from '@ai-sdk/anthropic';
import type { LanguageModel } from 'ai';

function getModelFormat(model: string): 'openai' | 'anthropic' | 'compatible' {
  if (model.startsWith('gpt-')) return 'openai';
  if (model.startsWith('claude-')) return 'anthropic';
  return 'compatible';
}

export function createOpenCodeModel(params: {
  model: string;
  apiKey: string;
  baseUrl?: string;
}): LanguageModel {
  if (!params.baseUrl) {
    throw new Error(
      'OpenCode provider requires a base_url. Configure it in LLM Provider settings.',
    );
  }

  const format = getModelFormat(params.model);

  if (format === 'anthropic') {
    const provider = createAnthropic({
      apiKey: params.apiKey,
      baseURL: params.baseUrl,
    });
    return provider(params.model);
  }

  if (format === 'compatible') {
    const provider = createOpenAICompatible({
      name: 'opencode',
      apiKey: params.apiKey,
      baseURL: params.baseUrl,
    });
    return provider.chatModel(params.model);
  }

  const provider = createOpenAI({
    apiKey: params.apiKey,
    baseURL: params.baseUrl,
  });
  return provider(params.model);
}
