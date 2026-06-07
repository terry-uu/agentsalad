/**
 * Google Skills — gog CLI 공통 유틸
 *
 * gog (https://gogcli.sh) CLI 도구를 child_process로 호출.
 * 설치 여부 확인 + JSON 출력 파싱 공통 로직.
 */
import { execSync, exec } from 'child_process';

let gogAvailable: boolean | null = null;

export function isGogAvailable(): boolean {
  if (gogAvailable !== null) return gogAvailable;
  try {
    execSync('gog --version', { timeout: 5000, stdio: 'pipe' });
    gogAvailable = true;
  } catch {
    gogAvailable = false;
  }
  return gogAvailable;
}

const GOG_TIMEOUT = 30_000;
const MAX_OUTPUT = 128 * 1024; // 128KB

export interface GogResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

/** gog 명령 실행 후 JSON 파싱 결과 반환 */
export function runGog(args: string): Promise<GogResult> {
  return new Promise((resolve) => {
    exec(
      `gog ${args} --json`,
      {
        timeout: GOG_TIMEOUT,
        maxBuffer: MAX_OUTPUT,
      },
      (error, stdout, stderr) => {
        if (error) {
          resolve({ success: false, error: stderr || error.message });
          return;
        }
        try {
          const data = JSON.parse(stdout);
          resolve({ success: true, data });
        } catch {
          resolve({ success: true, data: stdout.trim() });
        }
      },
    );
  });
}
