/**
 * Agent Salad - Configuration
 *
 * 서비스 플랫폼 전역 설정. STORE_DIR, TIMEZONE, Web UI, Browser 설정 관리.
 *
 * STORE_DIR 결정 순서:
 *  1. AGENTSALAD_STORE_DIR 환경변수 (Electron 패키징에서 userData 경로 주입)
 *  2. process.cwd()/store (개발 환경 기본값)
 * Electron 패키징 시 process.cwd()가 앱 번들 내부로 잡히면
 * 업데이트 시 데이터가 소실되므로, 반드시 userData로 분리한다.
 *
 * TIMEZONE 결정 순서 (DB > env > system):
 *  1. server_settings DB의 'timezone' 값 (Web UI에서 변경 가능)
 *  2. process.env.TZ (Docker run -e TZ=Asia/Seoul)
 *  3. Intl.DateTimeFormat 시스템 감지 (fallback)
 * 내부 시간 계산은 모두 UTC. 입출력 경계에서만 TIMEZONE으로 변환.
 *
 * Browser 환경변수:
 *  BROWSER_HEADLESS=true   → headless 모드 (기본: false, headed 모드로 창이 열림)
 *  BROWSER_CDP_URL=http://localhost:9222  → 기존 Chrome에 CDP로 연결
 *    Chrome 실행: /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
 */
import path from 'path';

const PROJECT_ROOT = process.cwd();

export const STORE_DIR = process.env.AGENTSALAD_STORE_DIR
  ? path.resolve(process.env.AGENTSALAD_STORE_DIR)
  : path.resolve(PROJECT_ROOT, 'store');

// ── Timezone (동적) ──

const SYSTEM_TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

let _timezone: string = SYSTEM_TIMEZONE;
let _timezoneSource: 'db' | 'env' | 'system' = process.env.TZ
  ? 'env'
  : 'system';

/** initDb() 이후 호출. DB에 저장된 타임존이 있으면 그것을 우선 사용. */
export function initTimezone(dbTimezone: string | null): void {
  if (dbTimezone) {
    _timezone = dbTimezone;
    _timezoneSource = 'db';
  }
}

/** 현재 서버 타임존 (IANA ID). 모든 시간 변환은 이 값을 사용. */
export function getTimezone(): string {
  return _timezone;
}

/** 타임존 소스 (db / env / system). 디버그 및 UI 표시용. */
export function getTimezoneSource(): 'db' | 'env' | 'system' {
  return _timezoneSource;
}

/** Web UI에서 타임존 변경 시 호출. */
export function setTimezone(tz: string): void {
  _timezone = tz;
  _timezoneSource = 'db';
}

/** Web UI에서 "Auto" 선택 시 호출. DB 설정을 제거하고 시스템 감지로 복귀. */
export function resetTimezone(): void {
  _timezone = SYSTEM_TIMEZONE;
  _timezoneSource = process.env.TZ ? 'env' : 'system';
}

/** @deprecated 하위 호환용. getTimezone() 사용 권장. */
export const TIMEZONE = SYSTEM_TIMEZONE;

// Web UI (management only; chat still happens in channels)
export const WEB_UI_ENABLED =
  (process.env.WEB_UI_ENABLED || 'true').toLowerCase() !== 'false';
export const WEB_UI_HOST = process.env.WEB_UI_HOST || '127.0.0.1';
export const WEB_UI_PORT = parseInt(process.env.WEB_UI_PORT || '3210', 10);
