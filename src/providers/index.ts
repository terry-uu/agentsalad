/**
 * Provider Router - 멀티 프로바이더 직접 호출 + Tool Calling
 *
 * Vercel AI SDK를 사용하여 각 프로바이더 API를 직접 호출.
 * 프록시 없이 직접 연결하므로 레이턴시가 최소.
 * Tool calling 지원: tools + stopWhen(stepCountIs) 으로 멀티스텝 자동 처리.
 * 멀티모달 지원: user 메시지의 content를 string | UserContent로 받아
 *   파일 첨부(FilePart/ImagePart)를 LLM에 네이티브 전달.
 *
 * 빌트인: Anthropic, OpenAI, Google (Gemini), Groq, OpenRouter, OpenCode, Moonshot, GLM
 * 플러그인: 에이전트 드레싱으로 설치된 프로바이더 (Ollama, vLLM 등)
 *   - getEndpoint() 지원 시 createOpenAICompatible로 네이티브 연결 (tool calling 포함)
 *   - 미지원 시 wrapAsLanguageModel 폴백 (텍스트 전용)
 *
 * API 에러 발생 시 ProviderError로 분류하여 상위에서 사용자 메시지 전달 가능.
 */
import {
  streamText,
  stepCountIs,
  type ModelMessage,
  type LanguageModel,
  type Tool,
  type UserContent,
} from 'ai';

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

import { logger } from '../logger.js';
import { ProviderError, type ProviderErrorType } from '../types.js';
import { buildSystemPrompt } from './system-prompt.js';
import {
  loadAgentPlugin,
  initAgentPlugin,
  wrapAsLanguageModel,
} from '../dressing/plugin-loader.js';
import { getInstalledDressingByProviderKey } from '../db.js';
import { createAnthropicModel } from './anthropic.js';
import { createOpenAIModel } from './openai.js';
import { createGroqModel } from './groq.js';
import { createOpenRouterModel } from './openrouter.js';
import { createOpenCodeModel } from './opencode.js';
import { createGoogleModel } from './google.js';
import { createMoonshotModel } from './moonshot.js';
import { createGlmModel } from './glm.js';

export { buildSystemPrompt } from './system-prompt.js';

export interface ChatParams {
  messages: Array<{
    role: 'user' | 'assistant' | 'system';
    content: string | UserContent;
  }>;
  agentSystemPrompt: string;
  providerId: string;
  model: string;
  apiKey: string;
  baseUrl?: string;
  tools?: Record<string, Tool>;
  skillPrompts?: string[];
  /** 시간 인지 모드 — 시스템 프롬프트에 현재 시간 주입 */
  timeAware?: boolean;
  /** 스마트 스텝 모드 — 시스템 프롬프트에 플랜 사용법 주입 */
  smartStep?: boolean;
  /** 대상 사용자 닉네임 — 멀티타겟 워크스페이스 안내용 */
  targetName?: string;
  options?: {
    temperature?: number;
    maxOutputTokens?: number;
  };
}

export interface ChatResult {
  text: string;
}

type ModelFactory = (params: {
  model: string;
  apiKey: string;
  baseUrl?: string;
}) => LanguageModel;

const MODEL_FACTORIES: Record<string, ModelFactory> = {
  anthropic: createAnthropicModel,
  openai: createOpenAIModel,
  google: createGoogleModel,
  groq: createGroqModel,
  openrouter: createOpenRouterModel,
  opencode: createOpenCodeModel,
  moonshot: createMoonshotModel,
  glm: createGlmModel,
};

function getModelFactory(providerId: string): ModelFactory {
  // 1. 빌트인 프로바이더 체크
  const builtin = MODEL_FACTORIES[providerId];
  if (builtin) return builtin;

  // 2. 설치된 에이전트 드레싱(플러그인) 체크
  const plugin = loadAgentPlugin(providerId);
  if (plugin) {
    return (params) => {
      const dressing = getInstalledDressingByProviderKey(providerId);
      const config: Record<string, unknown> = dressing?.config_json
        ? JSON.parse(dressing.config_json)
        : {};
      if (params.baseUrl) config.base_url = params.baseUrl;
      if (params.apiKey) config.api_key = params.apiKey;

      // getEndpoint 지원 시 createOpenAICompatible로 네이티브 연결 (tool calling 포함)
      if (plugin.getEndpoint) {
        const endpoint = plugin.getEndpoint(config);
        if (endpoint) {
          const opts: Record<string, unknown> = {
            name: `dressing:${providerId}`,
            baseURL: endpoint.baseUrl,
            apiKey: endpoint.apiKey || 'not-needed',
          };
          // thinking 모델 + disable_thinking: chat_template_kwargs 자동 주입
          if (endpoint.needsThinkingOff) {
            opts.fetch = (url: string, init?: RequestInit) => {
              if (init?.body && typeof init.body === 'string') {
                try {
                  const body = JSON.parse(init.body);
                  body.chat_template_kwargs = { enable_thinking: false };
                  init = { ...init, body: JSON.stringify(body) };
                } catch {
                  /* non-JSON body — pass through */
                }
              }
              return globalThis.fetch(url, init);
            };
          }
          const provider = createOpenAICompatible(
            opts as unknown as Parameters<typeof createOpenAICompatible>[0],
          );
          return provider.chatModel(params.model);
        }
      }

      // getEndpoint 미지원 시 wrapAsLanguageModel 폴백 (텍스트 전용)
      return wrapAsLanguageModel(plugin, providerId, params.model, config);
    };
  }

  throw new Error(
    `Unknown provider: ${providerId}. Supported: ${Object.keys(MODEL_FACTORIES).join(', ')}`,
  );
}

/**
 * API 에러에서 ProviderError 타입과 사용자 메시지를 결정.
 * Vercel AI SDK의 AI_APICallError / AI_RetryError 구조를 파싱.
 */
function classifyApiError(err: unknown): ProviderError {
  const raw = err as Record<string, unknown>;

  // AI_RetryError는 lastError에 원본을 갖고있음
  const source = (raw?.lastError ?? err) as Record<string, unknown>;
  const status = (source?.statusCode ?? source?.status) as number | undefined;
  const body = String(source?.responseBody ?? source?.message ?? '');
  const bodyLower = body.toLowerCase();

  let type: ProviderErrorType = 'unknown';

  if (
    status === 429 ||
    bodyLower.includes('rate limit') ||
    bodyLower.includes('ratelimit')
  ) {
    type = 'rate_limit';
  } else if (
    status === 401 ||
    status === 403 ||
    bodyLower.includes('unauthorized') ||
    bodyLower.includes('invalid api key')
  ) {
    type = 'auth';
  } else if (
    status === 404 ||
    bodyLower.includes('not found') ||
    bodyLower.includes('not supported')
  ) {
    type = 'model_not_found';
  } else if (
    status === 503 ||
    status === 529 ||
    bodyLower.includes('overloaded')
  ) {
    type = 'overloaded';
  } else if (
    bodyLower.includes('context length') ||
    bodyLower.includes('token') ||
    bodyLower.includes('too long')
  ) {
    type = 'context_length';
  }

  const rawMessage = extractErrorMessage(body);
  const userMsg = rawMessage
    ? `⚠️ ${rawMessage}`
    : '⚠️ An error occurred while generating a response. Please try again shortly.';

  return new ProviderError(type, status, userMsg, err);
}

/**
 * API 응답 body에서 사람이 읽을 수 있는 에러 메시지 추출.
 * JSON 구조(OpenRouter, Anthropic 등)를 먼저 시도하고, 실패 시 원본 텍스트.
 */
function extractErrorMessage(body: string): string | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body);
    const msg =
      parsed?.error?.message ?? parsed?.message ?? parsed?.error?.type;
    if (typeof msg === 'string' && msg.length > 0) return msg;
  } catch {
    // JSON이 아닌 경우 원본 사용
  }
  const trimmed = body.length > 200 ? body.slice(0, 200) + '…' : body;
  return trimmed || null;
}

/**
 * Stream chat response from any supported provider.
 * Returns an async iterable of text chunks for real-time delivery.
 * API 에러 시 ProviderError를 throw.
 */
export async function* streamChat(params: ChatParams): AsyncGenerator<string> {
  // 플러그인 프로바이더인 경우 start() 호출 (최초 1회, 빌트인은 no-op)
  if (!MODEL_FACTORIES[params.providerId]) {
    await initAgentPlugin(params.providerId);
  }

  const factory = getModelFactory(params.providerId);
  const model = factory({
    model: params.model,
    apiKey: params.apiKey,
    baseUrl: params.baseUrl,
  });

  const systemPrompt = buildSystemPrompt(
    params.agentSystemPrompt,
    params.skillPrompts,
    params.timeAware,
    params.smartStep,
    params.targetName,
  );

  const messages: ModelMessage[] = params.messages.map((m) => ({
    role: m.role,
    content: m.content as string & UserContent,
  }));

  logger.debug(
    {
      provider: params.providerId,
      model: params.model,
      messageCount: messages.length,
    },
    'Streaming chat request',
  );

  try {
    const hasTools = params.tools && Object.keys(params.tools).length > 0;
    const result = streamText({
      model,
      system: systemPrompt,
      messages,
      ...(hasTools ? { tools: params.tools, stopWhen: stepCountIs(10) } : {}),
      temperature: params.options?.temperature,
      maxOutputTokens: params.options?.maxOutputTokens,
    });

    // fullStream을 사용해야 에러 이벤트를 감지할 수 있음.
    // textStream은 에러를 삼키고 조용히 종료됨 (AI SDK v6 동작).
    for await (const part of result.fullStream) {
      if (part.type === 'text-delta') {
        yield part.text;
      } else if (part.type === 'error') {
        throw part.error;
      }
    }
  } catch (err) {
    if (err instanceof ProviderError) throw err;

    const classified = classifyApiError(err);
    logger.warn(
      {
        provider: params.providerId,
        model: params.model,
        errorType: classified.type,
        statusCode: classified.statusCode,
        rawError: err instanceof Error ? err.message : String(err),
      },
      `Provider error: ${classified.type}`,
    );
    throw classified;
  }
}

/**
 * Non-streaming chat — waits for full response.
 * Use streamChat for real-time delivery to messenger channels.
 */
export async function chat(params: ChatParams): Promise<ChatResult> {
  const chunks: string[] = [];
  for await (const chunk of streamChat(params)) {
    chunks.push(chunk);
  }
  return { text: chunks.join('') };
}
