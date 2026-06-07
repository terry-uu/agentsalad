/**
 * 드레싱 플러그인 런타임 — 공개 API 재수출
 *
 * 드레싱스토어/구매/라이선스 검증 플로우는 제거되었다.
 * 현재 드레싱은 저장소에 포함된 내장 플러그인 또는 로컬 플러그인으로 로드한다.
 */
export {
  loadAgentPlugin,
  loadChannelPlugin,
  wrapAsLanguageModel,
  invalidatePluginCache,
  initAgentPlugin,
  stopAllPlugins,
  channelSupportsOutbound,
  type AgentPluginModule,
  type ChannelPluginModule,
  type AgentPluginChunk,
} from './plugin-loader.js';
