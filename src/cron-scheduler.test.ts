import { describe, it, expect } from 'vitest';

import {
  computeWeeklyNextRun,
  computeIntervalNextRun,
  computeOnceNextRun,
  parseScheduleDays,
  mapConcurrent,
  localTimeToUtcIso,
} from './cron-scheduler.js';

const TZ_SEOUL = 'Asia/Seoul';
const TZ_UTC = 'UTC';
const TZ_NY = 'America/New_York';

describe('localTimeToUtcIso', () => {
  it('converts KST local time to UTC correctly', () => {
    // 2026-04-03 07:00 KST = 2026-04-02 22:00 UTC
    const result = localTimeToUtcIso(2026, 4, 3, 7, 0, TZ_SEOUL);
    expect(result).toBe('2026-04-02T22:00:00.000Z');
  });

  it('converts UTC local time without offset', () => {
    const result = localTimeToUtcIso(2026, 4, 3, 7, 0, TZ_UTC);
    expect(result).toBe('2026-04-03T07:00:00.000Z');
  });

  it('handles midnight crossing (KST 01:00 = previous day UTC 16:00)', () => {
    // 2026-04-03 01:00 KST = 2026-04-02 16:00 UTC
    const result = localTimeToUtcIso(2026, 4, 3, 1, 0, TZ_SEOUL);
    expect(result).toBe('2026-04-02T16:00:00.000Z');
  });
});

describe('computeWeeklyNextRun', () => {
  it('returns future UTC ISO for a given timezone', () => {
    const result = computeWeeklyNextRun(
      '07:00',
      [0, 1, 2, 3, 4, 5, 6],
      TZ_SEOUL,
    );
    expect(result).not.toBeNull();
    const d = new Date(result!);
    expect(d.getTime()).toBeGreaterThan(Date.now());
  });

  it('returns null for empty days array', () => {
    expect(computeWeeklyNextRun('08:00', [], TZ_SEOUL)).toBeNull();
  });

  it('produces different UTC times for different timezones with same local time', () => {
    const seoulResult = computeWeeklyNextRun(
      '12:00',
      [0, 1, 2, 3, 4, 5, 6],
      TZ_SEOUL,
    );
    const utcResult = computeWeeklyNextRun(
      '12:00',
      [0, 1, 2, 3, 4, 5, 6],
      TZ_UTC,
    );
    expect(seoulResult).not.toBeNull();
    expect(utcResult).not.toBeNull();
    // KST noon = UTC 03:00, UTC noon = UTC 12:00 → 9hr difference
    const diff = Math.abs(
      new Date(utcResult!).getTime() - new Date(seoulResult!).getTime(),
    );
    // Allow ±1 day variation but at least 8hr offset
    expect(diff % (24 * 3600_000)).toBeGreaterThanOrEqual(8 * 3600_000);
  });
});

describe('computeIntervalNextRun', () => {
  it('returns future time offset by interval minutes', () => {
    const before = Date.now();
    const result = new Date(computeIntervalNextRun(30)).getTime();
    const expected = before + 30 * 60_000;
    expect(result).toBeGreaterThanOrEqual(expected - 100);
    expect(result).toBeLessThanOrEqual(expected + 100);
  });
});

describe('parseScheduleDays', () => {
  it('parses comma-separated day numbers', () => {
    expect(parseScheduleDays('1,3,5')).toEqual([1, 3, 5]);
  });

  it('returns empty for null/undefined', () => {
    expect(parseScheduleDays(null)).toEqual([]);
    expect(parseScheduleDays(undefined)).toEqual([]);
  });

  it('filters invalid values', () => {
    expect(parseScheduleDays('0,7,-1,3,abc')).toEqual([0, 3]);
  });
});

describe('computeOnceNextRun', () => {
  it('preserves UTC for Z-suffixed datetime', () => {
    const iso = '2030-06-15T14:00:00Z';
    const result = computeOnceNextRun(iso, TZ_SEOUL);
    expect(result).toBe('2030-06-15T14:00:00.000Z');
  });

  it('converts timezone-naive datetime using provided TZ', () => {
    // "2030-06-15T14:00:00" in KST → UTC 05:00
    const result = computeOnceNextRun('2030-06-15T14:00:00', TZ_SEOUL);
    expect(result).toBe('2030-06-15T05:00:00.000Z');
  });

  it('returns null for invalid datetime', () => {
    expect(computeOnceNextRun('not-a-date')).toBeNull();
  });
});

describe('mapConcurrent', () => {
  it('executes all items and returns results in order', async () => {
    const items = [1, 2, 3, 4, 5];
    const results = await mapConcurrent(items, async (n) => n * 10, 3);
    expect(results).toEqual([10, 20, 30, 40, 50]);
  });

  it('respects concurrency limit', async () => {
    let active = 0;
    let maxActive = 0;
    const LIMIT = 3;

    const items = Array.from({ length: 10 }, (_, i) => i);
    await mapConcurrent(
      items,
      async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 50));
        active--;
      },
      LIMIT,
    );

    expect(maxActive).toBeLessThanOrEqual(LIMIT);
    expect(maxActive).toBe(LIMIT);
    expect(active).toBe(0);
  });

  it('runs faster than sequential when concurrency > 1', async () => {
    const items = Array.from({ length: 6 }, (_, i) => i);
    const DELAY = 50;

    const seqStart = Date.now();
    for (const item of items) {
      await new Promise((r) => setTimeout(r, DELAY));
    }
    const seqTime = Date.now() - seqStart;

    const parStart = Date.now();
    await mapConcurrent(
      items,
      async () => {
        await new Promise((r) => setTimeout(r, DELAY));
      },
      3,
    );
    const parTime = Date.now() - parStart;

    expect(parTime).toBeLessThan(seqTime * 0.75);
  });

  it('handles empty items', async () => {
    const results = await mapConcurrent([], async () => 1, 3);
    expect(results).toEqual([]);
  });

  it('handles concurrency larger than items', async () => {
    const items = [1, 2];
    const results = await mapConcurrent(items, async (n) => n + 1, 10);
    expect(results).toEqual([2, 3]);
  });

  it('propagates errors from individual tasks', async () => {
    const items = [1, 2, 3];
    await expect(
      mapConcurrent(
        items,
        async (n) => {
          if (n === 2) throw new Error('boom');
          return n;
        },
        2,
      ),
    ).rejects.toThrow('boom');
  });

  it('simulates cron-like workload: mixed fast and slow tasks', async () => {
    const log: string[] = [];
    const tasks = [
      { id: 'svc-A', delay: 100 },
      { id: 'svc-B', delay: 30 },
      { id: 'svc-C', delay: 60 },
      { id: 'svc-D', delay: 20 },
      { id: 'svc-E', delay: 80 },
    ];

    const start = Date.now();
    const results = await mapConcurrent(
      tasks,
      async (task) => {
        log.push(`start:${task.id}`);
        await new Promise((r) => setTimeout(r, task.delay));
        log.push(`end:${task.id}`);
        return task.id;
      },
      3,
    );

    const elapsed = Date.now() - start;

    expect(results).toEqual(['svc-A', 'svc-B', 'svc-C', 'svc-D', 'svc-E']);

    expect(elapsed).toBeLessThan(200);

    expect(log[0]).toBe('start:svc-A');
    expect(log[1]).toBe('start:svc-B');
    expect(log[2]).toBe('start:svc-C');
  });
});
