/**
 * 드레싱 플러그인 동적 로더
 *
 * 에이전트 드레싱(LLM 프로바이더)과 채널 드레싱(메신저)을 런타임에 로드.
 * adapter.bundle.js를 require()로 동적 로드 + 메모리 캐싱.
 * 드레싱스토어 폐지 후 플러그인은 저장소에 포함된 내장 번들 또는 로컬 파일로 취급한다.
 * LanguageModelV3 래퍼: 플러그인의 streamChat() 출력을 Vercel AI SDK로 변환.
 * getEndpoint 지원: 플러그인이 OpenAI-compatible 엔드포인트를 직접 제공하면
 *   createOpenAICompatible로 네이티브 연결 (tool calling, 멀티모달 지원).
 *
 * handleWebhook 인터페이스: HTTP 요청의 전체 구성(method, path, query, headers, body)을
 * 플러그인에 투명하게 전달. 코어는 라우팅만 담당, 플랫폼별 로직은 플러그인이 소유.
 *
 * 모델 라이프사이클: start/stop으로 서브프로세스 관리,
 *   getModelStatus/loadModel/unloadModel로 모델 마운트 제어.
 *   코어는 has_model_lifecycle 플래그로 제네릭 처리 — 특정 provider_key 참조 없음.
 * channelSupportsOutbound: 채널의 아웃바운드 메시지 지원 여부 (크론 연결 제어).
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import type { LanguageModel } from 'ai';

import { STORE_DIR } from '../config.js';
import { logger } from '../logger.js';
import {
  getInstalledDressingByProviderKey,
  getInstalledDressingByChannelType,
} from '../db.js';
import type { Channel, OnServiceMessage } from '../types.js';

const require = createRequire(import.meta.url);

// ── Plugin Module Interfaces ──

export interface AgentPluginChunk {
  type: 'text' | 'finish';
  text?: string;
  usage?: { promptTokens?: number; completionTokens?: number };
}

export interface AgentPluginEndpoint {
  baseUrl: string;
  apiKey?: string;
  /** thinking 모델 + disable_thinking 설정 시 true — API 요청에 chat_template_kwargs 주입 필요 */
  needsThinkingOff?: boolean;
}

export interface AgentPluginModelInfo {
  id: string;
  status: 'loaded' | 'unloaded' | 'loading';
  size_bytes?: number;
}

export interface AgentPluginModule {
  streamChat(params: {
    messages: Array<{ role: string; content: string }>;
    model: string;
    config: Record<string, unknown>;
  }): AsyncGenerator<AgentPluginChunk>;
  listModels?(params: { config: Record<string, unknown> }): Promise<string[]>;
  testConnection?(params: {
    config: Record<string, unknown>;
  }): Promise<{ ok: boolean; error?: string }>;

  /** OpenAI-compatible 엔드포인트 반환 — tool calling 네이티브 지원 */
  getEndpoint?(config: Record<string, unknown>): AgentPluginEndpoint | null;

  /** 모델 라이프사이클: 마운트 상태 조회 */
  getModelStatus?(): Promise<AgentPluginModelInfo[]>;
  /** 모델 라이프사이클: GGUF 모델 파일 마운트 */
  loadModel?(modelId: string): Promise<{ success: boolean; error?: string }>;
  /** 모델 라이프사이클: 마운트 해제 (메모리 반환) */
  unloadModel?(modelId: string): Promise<{ success: boolean; error?: string }>;

  /** 플러그인 서브프로세스 시작 (바이너리 없으면 자동 다운로드) */
  start?(config: Record<string, unknown>): Promise<void>;
  /** 플러그인 서브프로세스 종료 */
  stop?(): Promise<void>;
}

export interface ChannelPluginModule {
  createChannel(params: {
    channelId: string;
    config: Record<string, unknown>;
    onMessage: OnServiceMessage;
    onConfigUpdate?: (
      channelId: string,
      config: Record<string, unknown>,
    ) => void;
  }): Channel;
  handleWebhook?(params: {
    method: string;
    path: string;
    query: Record<string, string>;
    headers: Record<string, string>;
    body: string;
    channelId: string;
    onMessage: OnServiceMessage;
  }): { status: number; headers?: Record<string, string>; body: string };
}

// ── 캐시 ──

const agentPluginCache = new Map<string, AgentPluginModule>();
const channelPluginCache = new Map<string, ChannelPluginModule>();

/**
 * 에이전트 플러그인(프로바이더) 로드.
 * DB에서 provider_key로 설치 정보 조회 → adapter.bundle.js require → 캐싱.
 */
export function loadAgentPlugin(providerKey: string): AgentPluginModule | null {
  const cached = agentPluginCache.get(providerKey);
  if (cached) return cached;

  const dressing = getInstalledDressingByProviderKey(providerKey);
  if (!dressing) return null;

  const pluginDir = path.join(
    STORE_DIR,
    'dressings',
    'agent',
    dressing.folder_name,
  );
  const adapterPath = path.join(pluginDir, 'adapter.bundle.js');

  if (!fs.existsSync(adapterPath)) {
    logger.warn(
      { providerKey, pluginDir },
      'Plugin adapter.bundle.js not found',
    );
    return null;
  }

  try {
    const mod = require(adapterPath) as AgentPluginModule;
    if (typeof mod.streamChat !== 'function') {
      logger.error({ providerKey }, 'Plugin missing streamChat function');
      return null;
    }
    agentPluginCache.set(providerKey, mod);
    logger.info({ providerKey }, 'Agent plugin loaded');
    return mod;
  } catch (err) {
    logger.error({ err, providerKey }, 'Failed to load agent plugin');
    return null;
  }
}

/**
 * 채널 플러그인(메신저) 로드.
 * DB에서 channel_type으로 설치 정보 조회 → adapter.bundle.js require → 캐싱.
 */
export function loadChannelPlugin(
  channelType: string,
): ChannelPluginModule | null {
  const cached = channelPluginCache.get(channelType);
  if (cached) return cached;

  const dressing = getInstalledDressingByChannelType(channelType);
  if (!dressing) return null;

  const pluginDir = path.join(
    STORE_DIR,
    'dressings',
    'channel',
    dressing.folder_name,
  );
  const adapterPath = path.join(pluginDir, 'adapter.bundle.js');

  if (!fs.existsSync(adapterPath)) {
    logger.warn(
      { channelType, pluginDir },
      'Plugin adapter.bundle.js not found',
    );
    return null;
  }

  try {
    const mod = require(adapterPath) as ChannelPluginModule;
    if (typeof mod.createChannel !== 'function') {
      logger.error({ channelType }, 'Plugin missing createChannel function');
      return null;
    }
    channelPluginCache.set(channelType, mod);
    logger.info({ channelType }, 'Channel plugin loaded');
    return mod;
  } catch (err) {
    logger.error({ err, channelType }, 'Failed to load channel plugin');
    return null;
  }
}

/**
 * 캐시 무효화. 플러그인 업데이트/삭제 후 호출.
 */
export function invalidatePluginCache(key: string): void {
  agentPluginCache.delete(key);
  channelPluginCache.delete(key);
  startedPlugins.delete(key);
}

/**
 * 채널 플러그인의 dressing.json에서 supports_outbound를 조회.
 * 빌트인 채널(telegram/discord/slack)은 true.
 * 플러그인 채널은 dressing.json의 supports_outbound 값 (미선언 시 true).
 */
export function channelSupportsOutbound(channelType: string): boolean {
  const builtins = ['telegram', 'discord', 'slack'];
  if (builtins.includes(channelType)) return true;

  const dressing = getInstalledDressingByChannelType(channelType);
  if (!dressing) return true;

  const dressingJsonPath = path.join(
    STORE_DIR,
    'dressings',
    'channel',
    dressing.folder_name,
    'dressing.json',
  );
  try {
    const raw = JSON.parse(fs.readFileSync(dressingJsonPath, 'utf-8'));
    return raw.supports_outbound !== false;
  } catch {
    return true;
  }
}

// ── 플러그인 라이프사이클 ──

const startedPlugins = new Set<string>();

/**
 * 에이전트 플러그인 start() 호출 (최초 1회). 동기 loadAgentPlugin을 깨뜨리지 않기 위해 분리.
 * getModelFactory에서 플러그인 사용 전 await initAgentPlugin() 호출.
 */
export async function initAgentPlugin(providerKey: string): Promise<void> {
  if (startedPlugins.has(providerKey)) return;
  const plugin = loadAgentPlugin(providerKey);
  if (!plugin?.start) {
    startedPlugins.add(providerKey);
    return;
  }

  const dressing = getInstalledDressingByProviderKey(providerKey);
  const config: Record<string, unknown> = dressing?.config_json
    ? JSON.parse(dressing.config_json)
    : {};

  try {
    await plugin.start(config);
    startedPlugins.add(providerKey);
    logger.info({ providerKey }, 'Agent plugin started');
  } catch (err) {
    logger.error({ err, providerKey }, 'Failed to start agent plugin');
    throw err;
  }
}

/**
 * 모든 시작된 에이전트 플러그인 종료. 프로세스 종료 시 호출.
 */
export async function stopAllPlugins(): Promise<void> {
  for (const key of startedPlugins) {
    const plugin = agentPluginCache.get(key);
    if (plugin?.stop) {
      try {
        await plugin.stop();
        logger.info({ providerKey: key }, 'Agent plugin stopped');
      } catch (err) {
        logger.error({ err, providerKey: key }, 'Failed to stop agent plugin');
      }
    }
  }
  startedPlugins.clear();
}

// ── LanguageModelV3 래퍼 ──

/**
 * 에이전트 플러그인의 streamChat() 출력을 Vercel AI SDK LanguageModelV3로 래핑.
 * streamText()에서 직접 사용 가능한 LanguageModel 객체를 반환.
 *
 * 제약: 플러그인은 텍스트 생성만 지원. Tool calling은 미지원 (빌트인 프로바이더 사용 권장).
 */
export function wrapAsLanguageModel(
  plugin: AgentPluginModule,
  providerKey: string,
  modelId: string,
  config: Record<string, unknown>,
): LanguageModel {
  let textIdCounter = 0;

  const makeUsage = (u: {
    promptTokens?: number;
    completionTokens?: number;
  }) => ({
    inputTokens: {
      total: u.promptTokens ?? 0,
      noCache: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: u.completionTokens ?? 0, reasoning: undefined },
  });
  const stopReason = { type: 'stop' as const, raw: 'stop' };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- LanguageModelV3 spec 전체 구현 대신 필수 최소 필드만 cast
  const model: any = {
    specificationVersion: 'v3',
    provider: `dressing:${providerKey}`,
    modelId,
    supportedUrls: {},

    async doGenerate(options: {
      prompt: Array<{ role: string; content: unknown }>;
    }) {
      const messages = promptToSimpleMessages(options.prompt);
      const chunks: string[] = [];
      let usage = { promptTokens: 0, completionTokens: 0 };

      for await (const chunk of plugin.streamChat({
        messages,
        model: modelId,
        config,
      })) {
        if (chunk.type === 'text' && chunk.text) chunks.push(chunk.text);
        if (chunk.type === 'finish' && chunk.usage) {
          usage = {
            promptTokens: chunk.usage.promptTokens ?? 0,
            completionTokens: chunk.usage.completionTokens ?? 0,
          };
        }
      }

      return {
        content: [{ type: 'text' as const, text: chunks.join('') }],
        finishReason: stopReason,
        usage: makeUsage(usage),
        warnings: [],
      };
    },

    async doStream(options: {
      prompt: Array<{ role: string; content: unknown }>;
    }) {
      const messages = promptToSimpleMessages(options.prompt);
      const gen = plugin.streamChat({ messages, model: modelId, config });
      const textId = `text-${++textIdCounter}`;

      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          controller.enqueue({ type: 'text-start', id: textId });

          let usage = { promptTokens: 0, completionTokens: 0 };

          try {
            for await (const chunk of gen) {
              if (chunk.type === 'text' && chunk.text) {
                controller.enqueue({
                  type: 'text-delta',
                  id: textId,
                  delta: chunk.text,
                });
              }
              if (chunk.type === 'finish' && chunk.usage) {
                usage = {
                  promptTokens: chunk.usage.promptTokens ?? 0,
                  completionTokens: chunk.usage.completionTokens ?? 0,
                };
              }
            }
          } catch (err) {
            controller.enqueue({ type: 'error', error: err });
          }

          controller.enqueue({ type: 'text-end', id: textId });
          controller.enqueue({
            type: 'finish',
            finishReason: stopReason,
            usage: makeUsage(usage),
          });
          controller.close();
        },
      });

      return { stream };
    },
  };

  return model as LanguageModel;
}

/**
 * LanguageModelV3Prompt → 단순 { role, content } 배열 변환.
 * 플러그인은 단순 메시지 형식을 받으므로, 멀티파트를 텍스트로 평탄화.
 */
function promptToSimpleMessages(
  prompt: Array<{ role: string; content: unknown }>,
): Array<{ role: string; content: string }> {
  return prompt.map((msg) => {
    if (typeof msg.content === 'string') {
      return { role: msg.role, content: msg.content };
    }
    if (Array.isArray(msg.content)) {
      const text = (msg.content as Array<{ type: string; text?: string }>)
        .filter((p) => p.type === 'text' && p.text)
        .map((p) => p.text!)
        .join('');
      return { role: msg.role, content: text };
    }
    return { role: msg.role, content: String(msg.content) };
  });
}
