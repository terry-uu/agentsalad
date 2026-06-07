/**
 * Conversation Compaction Engine
 *
 * Claude Agent SDK의 자동 compaction 패턴을 재현.
 * 매 턴마다 컨텍스트 토큰을 추정하고, threshold 초과 시:
 * 1. 전체 대화를 conversation_archives에 아카이빙
 * 2. 동일 LLM에게 대화 요약 요청
 * 3. 기존 메시지 삭제 후 요약본 하나로 교체
 *
 * 요약본 + 새 대화가 다시 차면 전부 합쳐서 재요약 (재귀적 compaction).
 *
 * CONTEXT_WINDOWS 맵: 프로바이더:모델별 컨텍스트 윈도우 사이즈.
 * 맵에 없는 모델은 DEFAULT_CONTEXT_WINDOW(128K)로 폴백.
 * 최종 업데이트: 2026-03-30 (Anthropic 4.6, OpenAI 5.4, Gemini 3.1, Groq GPT-OSS 등)
 */

import {
  getAllConversationMessages,
  compactConversation,
  getConversationCount,
} from './db.js';
import { chat } from './providers/index.js';
import { logger } from './logger.js';
import type { ConversationMessage } from './types.js';
import { buildSystemPrompt } from './providers/system-prompt.js';

/** Compaction triggers when estimated tokens exceed this ratio of context window */
const COMPACTION_THRESHOLD_RATIO = 0.75;

/** Minimum messages before compaction is considered (avoid compacting tiny conversations) */
const MIN_MESSAGES_FOR_COMPACTION = 6;

/**
 * Known context window sizes (tokens) per provider+model.
 * Conservative defaults — actual limits may be higher.
 */
const CONTEXT_WINDOWS: Record<string, number> = {
  // Anthropic — 4.6: 1M GA (2026-03-13), 4.5 이하: 200K
  'anthropic:claude-opus-4-6': 1_000_000,
  'anthropic:claude-sonnet-4-6': 1_000_000,
  'anthropic:claude-haiku-4-5-20251001': 200_000,
  'anthropic:claude-sonnet-4-20250514': 200_000,
  'anthropic:claude-opus-4-20250514': 200_000,
  'anthropic:sonnet': 1_000_000,
  'anthropic:opus': 1_000_000,
  'anthropic:haiku': 200_000,

  // OpenAI — GPT-5.4: 1.05M, 5.4 mini: 400K, o3/o4-mini: 200K
  'openai:gpt-5.4': 1_050_000,
  'openai:gpt-5.4-mini': 400_000,
  'openai:o3': 200_000,
  'openai:o4-mini': 200_000,
  'openai:o3-mini': 200_000,
  'openai:gpt-4o': 128_000,
  'openai:gpt-4o-mini': 128_000,

  // Google (Gemini) — 3.1 Pro: 2M, 2.5/3 Flash: 1M
  'google:gemini-3.1-pro-preview': 2_000_000,
  'google:gemini-3-flash-preview': 1_048_576,
  'google:gemini-3.1-flash-lite-preview': 1_048_576,
  'google:gemini-2.5-pro': 1_048_576,
  'google:gemini-2.5-flash': 1_048_576,

  // Groq — LPU 호스팅 모델, 대부분 131K
  'groq:llama-3.3-70b-versatile': 131_072,
  'groq:llama-3.1-8b-instant': 131_072,
  'groq:gpt-oss-120b': 131_072,
  'groq:gpt-oss-20b': 131_072,
  'groq:deepseek-r1-distill-qwen-32b': 128_000,
  'groq:deepseek-r1-distill-llama-70b': 128_000,

  // Moonshot (Kimi) — K2.5: 256K, K2 preview: 256K/128K
  'moonshot:kimi-k2.5': 262_144,
  'moonshot:kimi-k2-0905-preview': 262_144,
  'moonshot:kimi-k2-turbo-preview': 262_144,
  'moonshot:kimi-k2-thinking': 262_144,
  'moonshot:kimi-k2-thinking-turbo': 262_144,
  'moonshot:kimi-k2': 128_000,
  'moonshot:kimi-k2-0711-preview': 128_000,
  'moonshot:moonshot-v1-128k': 128_000,
  'moonshot:moonshot-v1-32k': 32_768,
  'moonshot:moonshot-v1-8k': 8_192,

  // GLM (Zhipu AI) — GLM-5: 200K, GLM-4-Long: 1M, GLM-4.x: 128K~200K
  'glm:glm-5.1': 200_000,
  'glm:glm-5': 200_000,
  'glm:glm-5-turbo': 200_000,
  'glm:glm-4.7': 200_000,
  'glm:glm-4.7-flashx': 200_000,
  'glm:glm-4.7-flash': 200_000,
  'glm:glm-4.6': 200_000,
  'glm:glm-4-long': 1_000_000,
  'glm:glm-4.5-air': 128_000,
  'glm:glm-4.5-airx': 128_000,
  'glm:glm-4-plus': 128_000,
  'glm:glm-4-air': 128_000,
  'glm:glm-4-flash': 128_000,
};

/** Fallback context window for unknown models */
const DEFAULT_CONTEXT_WINDOW = 128_000;

/**
 * Estimate token count for a string.
 *
 * Rough heuristic: English ~4 chars/token, CJK ~1.5 chars/token.
 * We use a weighted estimate biased toward CJK for safety (triggers compaction earlier).
 * Exact counting would require per-provider tokenizers — this is good enough
 * for threshold triggering. The API itself enforces the real limit.
 */
export function estimateTokens(text: string): number {
  let asciiChars = 0;
  let nonAsciiChars = 0;

  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) {
      asciiChars++;
    } else {
      nonAsciiChars++;
    }
  }

  return Math.ceil(asciiChars / 4 + nonAsciiChars / 1.5);
}

/**
 * Get the context window size for a provider+model combination.
 */
export function getContextWindow(providerId: string, model: string): number {
  const key = `${providerId}:${model}`;
  if (CONTEXT_WINDOWS[key]) return CONTEXT_WINDOWS[key];

  // Try provider-level defaults
  for (const [k, v] of Object.entries(CONTEXT_WINDOWS)) {
    if (k.startsWith(`${providerId}:`) && k.endsWith(model)) return v;
  }

  // OpenRouter/OpenCode — models are proxied, assume large window
  if (providerId === 'openrouter' || providerId === 'opencode') {
    return 128_000;
  }

  return DEFAULT_CONTEXT_WINDOW;
}

/**
 * Estimate total tokens for a conversation context (system prompt + messages).
 */
export function estimateContextTokens(
  systemPrompt: string,
  messages: Array<{ role: string; content: string }>,
): number {
  let total = estimateTokens(systemPrompt);
  for (const m of messages) {
    total += estimateTokens(m.content) + 4; // +4 for role/message overhead
  }
  return total;
}

/**
 * Check if compaction is needed and execute if so.
 * Returns true if compaction was performed.
 *
 * Call this BEFORE building the API request context.
 */
export async function compactIfNeeded(params: {
  serviceId: string;
  providerId: string;
  model: string;
  apiKey: string;
  baseUrl?: string;
  agentSystemPrompt: string;
}): Promise<boolean> {
  const messageCount = getConversationCount(params.serviceId);
  if (messageCount < MIN_MESSAGES_FOR_COMPACTION) return false;

  const allMessages = getAllConversationMessages(params.serviceId);
  const systemPrompt = buildSystemPrompt(params.agentSystemPrompt);
  const estimatedTokens = estimateContextTokens(
    systemPrompt,
    allMessages.map((m) => ({ role: m.role, content: m.content })),
  );

  const contextWindow = getContextWindow(params.providerId, params.model);
  const threshold = Math.floor(contextWindow * COMPACTION_THRESHOLD_RATIO);

  if (estimatedTokens <= threshold) return false;

  logger.info(
    {
      serviceId: params.serviceId,
      estimatedTokens,
      threshold,
      contextWindow,
      messageCount: allMessages.length,
    },
    'Context threshold exceeded, starting compaction',
  );

  try {
    const summary = await generateSummary(allMessages, params);

    compactConversation(
      params.serviceId,
      allMessages,
      summary,
      estimatedTokens,
    );

    logger.info(
      {
        serviceId: params.serviceId,
        originalMessages: allMessages.length,
        originalTokens: estimatedTokens,
        summaryTokens: estimateTokens(summary),
      },
      'Compaction complete',
    );

    return true;
  } catch (err) {
    logger.error(
      {
        serviceId: params.serviceId,
        err: err instanceof Error ? err.message : String(err),
      },
      'Compaction failed, proceeding with truncated context',
    );
    return false;
  }
}

const SUMMARIZATION_PROMPT = `You are a conversation summarizer. Your task is to create a concise but comprehensive summary of the conversation below.

Rules:
- Preserve all important facts, decisions, user preferences, and context
- Include any commitments, promises, or action items
- Note the user's communication style and language preference
- Keep the summary in the same language as the conversation
- Be concise but don't lose critical details — this summary replaces the full conversation
- Format as a flowing narrative, not a list
- Start with "Previous conversation summary:" followed by the summary

CONVERSATION:
`;

/**
 * Ask the same LLM to summarize the full conversation.
 * Uses non-streaming chat for simplicity (summary is internal, not user-facing).
 */
async function generateSummary(
  messages: ConversationMessage[],
  params: {
    providerId: string;
    model: string;
    apiKey: string;
    baseUrl?: string;
  },
): Promise<string> {
  const conversationText = messages
    .map((m) => `[${m.role}]: ${m.content}`)
    .join('\n\n');

  const result = await chat({
    messages: [
      {
        role: 'user',
        content: SUMMARIZATION_PROMPT + conversationText,
      },
    ],
    agentSystemPrompt: '',
    providerId: params.providerId,
    model: params.model,
    apiKey: params.apiKey,
    baseUrl: params.baseUrl,
    options: { maxOutputTokens: 4096 },
  });

  if (!result.text.trim()) {
    throw new Error('Empty summary returned from provider');
  }

  return result.text.trim();
}
