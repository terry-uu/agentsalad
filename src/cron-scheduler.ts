/**
 * Cron Scheduler — 서비스 단위 예약 작업 실행 엔진
 *
 * 10초 간격으로 service_crons 테이블의 due 작업을 체크하여
 * service-router의 processCronMessage를 통해 실행.
 * daily 크론은 다음 날 같은 시간으로, once 크론은 실행 후 삭제.
 *
 * 제한적 병렬 실행: worker pool 패턴으로 최대 CRON_CONCURRENCY개 동시 처리.
 * - 서로 다른 서비스의 크론은 병렬로 실행해 지연 최소화
 * - LLM API rate limit은 동시성 제한(기본 3)으로 보호
 * - everyone 템플릿 확장 시 child도 동일 동시성 제한 적용
 * - SQLite 쓰기는 서비스별 분리(대화 이력)되어 충돌 없음
 */
import { TIMEZONE } from './config.js';
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

/**
 * daily 크론의 next_run을 다음 날 같은 시간으로 계산.
 * 시스템 타임존 기준으로 HH:MM을 해석.
 */
export function computeDailyNextRun(timeHHMM: string): string {
  const [h, m] = timeHHMM.split(':').map(Number);
  const now = new Date();

  const todayAtTime = new Date(now);
  todayAtTime.setHours(h, m, 0, 0);

  const next =
    todayAtTime.getTime() > now.getTime()
      ? todayAtTime
      : new Date(todayAtTime.getTime() + 24 * 60 * 60 * 1000);

  return next.toISOString();
}

/**
 * once 크론의 next_run 초기값 계산.
 * schedule_time이 ISO datetime이므로 그대로 사용.
 */
export function computeOnceNextRun(isoDatetime: string): string | null {
  const target = new Date(isoDatetime);
  if (isNaN(target.getTime())) return null;
  return target.toISOString();
}

function buildScheduleLabel(type: string, time: string): string {
  if (type === 'daily') return `매일 ${time}`;
  const d = new Date(time);
  if (isNaN(d.getTime())) return `단발 ${time}`;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
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
          if (item.schedule_type === 'daily') {
            const nextRun = computeDailyNextRun(item.schedule_time);
            updateServiceCronAfterRun(item.service_id, item.cron_id, nextRun);
          } else {
            updateServiceCronAfterRun(item.service_id, item.cron_id, null);
          }
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
    { pollIntervalMs: POLL_INTERVAL_MS, timezone: TIMEZONE },
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
