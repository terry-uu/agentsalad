/**
 * Agent Salad - Configuration
 *
 * 서비스 플랫폼 전역 설정. STORE_DIR(데이터 저장소), TIMEZONE, Web UI 설정만 관리.
 */
import path from 'path';

const PROJECT_ROOT = process.cwd();

export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

// Web UI (management only; chat still happens in channels)
export const WEB_UI_ENABLED =
  (process.env.WEB_UI_ENABLED || 'true').toLowerCase() !== 'false';
export const WEB_UI_HOST = process.env.WEB_UI_HOST || '127.0.0.1';
export const WEB_UI_PORT = parseInt(process.env.WEB_UI_PORT || '3210', 10);
