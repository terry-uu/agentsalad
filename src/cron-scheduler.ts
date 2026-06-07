/**
 * Cron Scheduler — 서비스 단위 예약 작업 실행 엔진
 *
 * 10초 간격으로 service_crons 테이블의 due 작업을 체크하여
 * service-router의 processCronMessage를 통해 실행.
 * schedule_type별 next_run 계산:
 *   weekly: 다음 매칭 요일+시간 (구 daily 통합 — 전체요일 선택 시 매일 반복)
 *   once: 실행 후 삭제
 *   interval: now + interval_minutes
 *
 * 타임존 처리: 내부 저장/비교는 UTC. 사용자 로컬 시간("07:00")은
 * Intl API로 TIMEZONE 설정값 기준 UTC 변환. 시스템 TZ에 의존하지 않음.
 *
 * 제한적 병렬 실행: worker pool 패턴으로 최대 CRON_CONCURRENCY개 동시 처리.
 * - 서로 다른 서비스의 크론은 병렬로 실행해 지연 최소화
 * - LLM API rate limit은 동시성 제한(기본 3)으로 보호
 * - everyone 템플릿 확장 시 child도 동일 동시성 제한 적용
 * - SQLite 쓰기는 서비스별 분리(대화 이력)되어 충돌 없음
 */
import { getTimezone } from './config.js';
import {
  getDueServiceCrons,
  getTargetById,
  listConcreteServicesForTemplate,
  updateServiceCronAfterRun,
  cleanupOrphanedOnceCrons,
} from './db.js';
import { processCronMessage } from './service-router.js';
import { logger } from './logger.js';

const POLL_INTERVAL_MS = 10_000;
const CRON_CONCURRENCY = 3;

let running = false;

// ── Timezone-aware date utilities ──

/**
 * 특정 타임존의 "지금" 날짜/시간 구성요소를 추출.
 * Intl.DateTimeFormat으로 시스템 TZ와 무관하게 동작.
 */
function getNowInTimezone(tz: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  dayOfWeek: number;
} {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    weekday: 'short',
  }).formatToParts(now);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';

  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  return {
    year: parseInt(get('year')),
    month: parseInt(get('month')),
    day: parseInt(get('day')),
    hour: parseInt(get('hour')),
    minute: parseInt(get('minute')),
    dayOfWeek: weekdayMap[get('weekday')] ?? 0,
  };
}

/**
 * 타임존 로컬 시간 → UTC ISO 문자열 변환.
 * "2026-04-03 07:00 in Asia/Seoul" → "2026-04-02T22:00:00.000Z"
 *
 * Intl API로 해당 시점의 UTC 오프셋을 계산하여 변환.
 * DST(서머타임) 있는 타임존도 자동 대응.
 */
export function localTimeToUtcIso(
  year: number,
  month: number,
  day: number,
  h: number,
  m: number,
  tz: string,
): string {
  // 1. 대략적인 UTC 시간으로 Date 생성 (오프셋 추정용)
  const approx = new Date(Date.UTC(year, month - 1, day, h, m, 0));

  // 2. 해당 시점에서의 TZ 오프셋 계산: UTC 시간과 로컬 시간의 차이
  const utcParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(approx);
  const localParts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(approx);

  const toMin = (parts: Intl.DateTimeFormatPart[]) => {
    const g = (type: string) =>
      parseInt(parts.find((p) => p.type === type)?.value ?? '0');
    return g('day') * 1440 + g('hour') * 60 + g('minute');
  };

  const offsetMin = toMin(localParts) - toMin(utcParts);

  // 3. 원하는 로컬 시간에서 오프셋을 빼서 UTC로 변환
  const utc = new Date(Date.UTC(year, month - 1, day, h, m, 0));
  utc.setUTCMinutes(utc.getUTCMinutes() - offsetMin);

  return utc.toISOString();
}

/**
 * weekly 크론의 next_run 계산.
 * days 배열(0=일..6=토)에서 현재 시점 이후 가장 가까운 요일+시간을 찾는다.
 * 오늘이 매칭 요일이고 아직 시간이 안 지났으면 오늘 실행.
 * Intl API로 TIMEZONE 기준 로컬 시간을 UTC로 변환 — 시스템 TZ와 무관.
 */
export function computeWeeklyNextRun(
  timeHHMM: string,
  days: number[],
  tz?: string,
): string | null {
  if (days.length === 0) return null;
  const [h, m] = timeHHMM.split(':').map(Number);
  if (isNaN(h) || isNaN(m)) return null;

  const timezone = tz ?? getTimezone();
  const now = new Date();
  const local = getNowInTimezone(timezone);

  for (let offset = 0; offset <= 7; offset++) {
    const candidateDay = (local.dayOfWeek + offset) % 7;
    if (!days.includes(candidateDay)) continue;

    // 후보 날짜 = 오늘(로컬) + offset일
    const candidateDate = new Date(
      Date.UTC(local.year, local.month - 1, local.day),
    );
    candidateDate.setUTCDate(candidateDate.getUTCDate() + offset);
    const cY = candidateDate.getUTCFullYear();
    const cM = candidateDate.getUTCMonth() + 1;
    const cD = candidateDate.getUTCDate();

    const candidateUtcIso = localTimeToUtcIso(cY, cM, cD, h, m, timezone);
    if (new Date(candidateUtcIso).getTime() > now.getTime()) {
      return candidateUtcIso;
    }
  }

  // fallback: 다음 주 첫 매칭 요일
  const sorted = [...days].sort((a, b) => a - b);
  const daysUntil = (sorted[0] - local.dayOfWeek + 7) % 7 || 7;
  const fbDate = new Date(Date.UTC(local.year, local.month - 1, local.day));
  fbDate.setUTCDate(fbDate.getUTCDate() + daysUntil);
  return localTimeToUtcIso(
    fbDate.getUTCFullYear(),
    fbDate.getUTCMonth() + 1,
    fbDate.getUTCDate(),
    h,
    m,
    timezone,
  );
}

/**
 * interval 크론의 next_run 계산.
 * 현재 시점에서 intervalMinutes 뒤. 절대 시각이므로 타임존 무관.
 */
export function computeIntervalNextRun(intervalMinutes: number): string {
  return new Date(Date.now() + intervalMinutes * 60_000).toISOString();
}

/**
 * once 크론의 next_run 초기값 계산.
 * LLM이 생성한 ISO datetime. TZ 미포함 문자열은 TIMEZONE 기준 해석.
 */
export function computeOnceNextRun(
  isoDatetime: string,
  tz?: string,
): string | null {
  const target = new Date(isoDatetime);
  if (isNaN(target.getTime())) return null;

  // ISO에 Z나 +offset이 포함된 경우: 이미 절대 시각이므로 그대로 사용
  if (/[Zz]|[+-]\d{2}:?\d{2}$/.test(isoDatetime.trim())) {
    return target.toISOString();
  }

  // TZ 미포함 ("2026-04-03T15:00:00"): TIMEZONE 기준 로컬 시간으로 해석
  const timezone = tz ?? getTimezone();
  const y = target.getFullYear();
  const mo = target.getMonth() + 1;
  const d = target.getDate();
  const h = target.getHours();
  const mi = target.getMinutes();
  return localTimeToUtcIso(y, mo, d, h, mi, timezone);
}

/** weekly schedule_days 문자열을 숫자 배열로 파싱 */
export function parseScheduleDays(
  scheduleDays: string | null | undefined,
): number[] {
  if (!scheduleDays) return [];
  return scheduleDays
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !isNaN(n) && n >= 0 && n <= 6);
}

const DAY_LABELS = ['일', '월', '화', '수', '목', '금', '토'];

function buildScheduleLabel(
  type: string,
  time: string,
  intervalMinutes?: number | null,
  scheduleDays?: string | null,
): string {
  if (type === 'weekly') {
    const days = parseScheduleDays(scheduleDays);
    const dayStr =
      days.length === 7 ? '매일' : days.map((d) => DAY_LABELS[d]).join(',');
    return `${dayStr} ${time}`;
  }
  if (type === 'interval' && intervalMinutes) {
    const label =
      intervalMinutes >= 60
        ? `${intervalMinutes / 60}시간`
        : `${intervalMinutes}분`;
    return `${label}마다`;
  }
  const d = new Date(time);
  if (isNaN(d.getTime())) return `단발 ${time}`;
  const tz = getTimezone();
  const fmt = new Intl.DateTimeFormat('sv-SE', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return fmt.format(d);
}

/**
 * Worker pool 기반 동시 실행. 최대 concurrency개의 worker가
 * items를 순서대로 꺼내 fn을 실행. JS 싱글 스레드에서
 * index++은 원자적이므로 경합 없음 (await 이전에 증가 완료).
 * @internal 테스트용 export
 */
export async function mapConcurrent<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return results;
}

type DueItem = ReturnType<typeof getDueServiceCrons>[number];

async function processItem(item: DueItem): Promise<boolean> {
  const scheduleLabel = buildScheduleLabel(
    item.schedule_type,
    item.schedule_time,
    item.interval_minutes,
    item.schedule_days,
  );
  const notify = item.notify === 1;
  const target = getTargetById(item.target_id);
  const isEveryoneTemplate = target?.target_type === 'everyone';

  if (isEveryoneTemplate) {
    const childServices = listConcreteServicesForTemplate(item.service_id);
    logger.info(
      {
        serviceId: item.service_id,
        cronId: item.cron_id,
        childCount: childServices.length,
      },
      'Cron: expanding everyone template to concrete services',
    );
    const results = await mapConcurrent(
      childServices,
      (child) =>
        processCronMessage(
          child.id,
          item.name,
          item.prompt,
          item.skill_hint || '[]',
          scheduleLabel,
          notify,
        ),
      CRON_CONCURRENCY,
    );
    return results.every(Boolean);
  }

  return processCronMessage(
    item.service_id,
    item.name,
    item.prompt,
    item.skill_hint || '[]',
    scheduleLabel,
    notify,
  );
}

async function tick(): Promise<void> {
  try {
    const dueItems = getDueServiceCrons();
    if (dueItems.length === 0) return;

    logger.info({ count: dueItems.length }, 'Cron: found due jobs');

    await mapConcurrent(
      dueItems,
      async (item) => {
        const ok = await processItem(item);
        if (ok) {
          let nextRun: string | null = null;
          if (item.schedule_type === 'weekly') {
            const days = parseScheduleDays(item.schedule_days);
            nextRun = computeWeeklyNextRun(item.schedule_time, days);
          } else if (
            item.schedule_type === 'interval' &&
            item.interval_minutes
          ) {
            nextRun = computeIntervalNextRun(item.interval_minutes);
          }
          // once → nextRun stays null → service_cron 삭제
          updateServiceCronAfterRun(item.service_id, item.cron_id, nextRun);
        } else {
          logger.warn(
            { serviceId: item.service_id, cronId: item.cron_id },
            'Cron execution failed or skipped',
          );
        }
      },
      CRON_CONCURRENCY,
    );

    cleanupOrphanedOnceCrons();
  } catch (err) {
    logger.error({ err }, 'Error in cron scheduler tick');
  }
}

export function startCronScheduler(): void {
  if (running) {
    logger.debug('Cron scheduler already running');
    return;
  }
  running = true;
  logger.info(
    { pollIntervalMs: POLL_INTERVAL_MS, timezone: getTimezone() },
    'Cron scheduler started',
  );

  const loop = async () => {
    await tick();
    if (running) setTimeout(loop, POLL_INTERVAL_MS);
  };
  loop();
}

export function stopCronScheduler(): void {
  running = false;
}
