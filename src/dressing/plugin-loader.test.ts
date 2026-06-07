import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  wrapAsLanguageModel,
  invalidatePluginCache,
  stopAllPlugins,
  type AgentPluginModule,
  type AgentPluginChunk,
  type AgentPluginEndpoint,
  type AgentPluginModelInfo,
} from './plugin-loader.js';

function createMockPlugin(
  chunks: AgentPluginChunk[] = [
    { type: 'text', text: 'Hello ' },
    { type: 'text', text: 'World' },
    { type: 'finish', usage: { promptTokens: 10, completionTokens: 5 } },
  ],
): AgentPluginModule {
  return {
    async *streamChat() {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  };
}

describe('wrapAsLanguageModel', () => {
  it('returns object with LanguageModelV3 required fields', () => {
    const model = wrapAsLanguageModel(
      createMockPlugin(),
      'test',
      'test-model',
      {},
    );

    expect(model).toBeDefined();
    expect((model as any).specificationVersion).toBe('v3');
    expect((model as any).provider).toBe('dressing:test');
    expect((model as any).modelId).toBe('test-model');
  });

  it('doGenerate collects all text chunks', async () => {
    const model = wrapAsLanguageModel(
      createMockPlugin(),
      'test',
      'model-1',
      {},
    );

    const result = await (model as any).doGenerate({
      prompt: [{ role: 'user', content: 'hi' }],
    });

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toBe('Hello World');
  });

  it('doGenerate returns usage from finish chunk', async () => {
    const model = wrapAsLanguageModel(
      createMockPlugin(),
      'test',
      'model-1',
      {},
    );

    const result = await (model as any).doGenerate({
      prompt: [{ role: 'user', content: 'hi' }],
    });

    expect(result.usage.inputTokens.total).toBe(10);
    expect(result.usage.outputTokens.total).toBe(5);
  });

  it('doGenerate handles empty response', async () => {
    const emptyPlugin = createMockPlugin([
      { type: 'finish', usage: { promptTokens: 0, completionTokens: 0 } },
    ]);
    const model = wrapAsLanguageModel(emptyPlugin, 'test', 'model-1', {});

    const result = await (model as any).doGenerate({
      prompt: [{ role: 'user', content: 'hi' }],
    });

    expect(result.content[0].text).toBe('');
  });

  it('doStream emits correct stream parts', async () => {
    const model = wrapAsLanguageModel(
      createMockPlugin(),
      'test',
      'model-1',
      {},
    );

    const { stream } = await (model as any).doStream({
      prompt: [{ role: 'user', content: 'hi' }],
    });

    const reader = stream.getReader();
    const parts: any[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
    }

    expect(parts[0].type).toBe('stream-start');
    expect(parts[1].type).toBe('text-start');

    const textDeltas = parts.filter((p) => p.type === 'text-delta');
    expect(textDeltas).toHaveLength(2);
    expect(textDeltas[0].delta).toBe('Hello ');
    expect(textDeltas[1].delta).toBe('World');

    const finish = parts.find((p) => p.type === 'finish');
    expect(finish).toBeDefined();
    expect(finish.usage.inputTokens.total).toBe(10);
    expect(finish.usage.outputTokens.total).toBe(5);
  });

  it('doStream handles multipart prompt (array content)', async () => {
    const capturedMessages: any[] = [];
    const capturePlugin: AgentPluginModule = {
      async *streamChat({ messages }) {
        capturedMessages.push(...messages);
        yield { type: 'text', text: 'ok' };
        yield {
          type: 'finish',
          usage: { promptTokens: 1, completionTokens: 1 },
        };
      },
    };

    const model = wrapAsLanguageModel(capturePlugin, 'test', 'm', {});
    await (model as any).doGenerate({
      prompt: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'part1 ' },
            { type: 'text', text: 'part2' },
            { type: 'image', image: 'data:...' },
          ],
        },
      ],
    });

    expect(capturedMessages[0].content).toBe('part1 part2');
  });

  it('doGenerate passes config to plugin', async () => {
    let receivedConfig: Record<string, unknown> = {};
    const configPlugin: AgentPluginModule = {
      async *streamChat({ config }) {
        receivedConfig = config;
        yield {
          type: 'finish',
          usage: { promptTokens: 0, completionTokens: 0 },
        };
      },
    };

    const model = wrapAsLanguageModel(configPlugin, 'test', 'm', {
      base_url: 'http://localhost:11434',
    });
    await (model as any).doGenerate({
      prompt: [{ role: 'user', content: 'hi' }],
    });

    expect(receivedConfig.base_url).toBe('http://localhost:11434');
  });
});

describe('invalidatePluginCache', () => {
  it('is callable without error', () => {
    expect(() => invalidatePluginCache('nonexistent-key')).not.toThrow();
  });
});

describe('AgentPluginModule extended interface', () => {
  it('accepts plugin with getEndpoint', () => {
    const plugin: AgentPluginModule = {
      async *streamChat() {
        yield { type: 'finish', usage: {} };
      },
      getEndpoint(): AgentPluginEndpoint | null {
        return { baseUrl: 'http://127.0.0.1:18200/v1' };
      },
    };
    expect(plugin.getEndpoint!({})).toEqual({
      baseUrl: 'http://127.0.0.1:18200/v1',
    });
  });

  it('accepts plugin with lifecycle methods', async () => {
    let started = false;
    let stopped = false;
    const plugin: AgentPluginModule = {
      async *streamChat() {
        yield { type: 'finish', usage: {} };
      },
      async start() {
        started = true;
      },
      async stop() {
        stopped = true;
      },
      async getModelStatus(): Promise<AgentPluginModelInfo[]> {
        return [{ id: 'test.gguf', status: 'loaded' }];
      },
      async loadModel(id: string) {
        return { success: true };
      },
      async unloadModel(id: string) {
        return { success: true };
      },
    };

    await plugin.start!({});
    expect(started).toBe(true);
    expect(await plugin.getModelStatus!()).toHaveLength(1);
    expect((await plugin.loadModel!('test.gguf')).success).toBe(true);
    expect((await plugin.unloadModel!('test.gguf')).success).toBe(true);
    await plugin.stop!();
    expect(stopped).toBe(true);
  });
});

describe('stopAllPlugins', () => {
  it('is callable without error when no plugins started', async () => {
    await expect(stopAllPlugins()).resolves.not.toThrow();
  });
});
