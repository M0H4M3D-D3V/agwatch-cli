import dayjs from 'dayjs';
import type { TimeRange, TimeRangeFilter } from '../domain/types.js';
import { AppError } from '../utils/errors.js';

function parseDate(value: string, option: string): dayjs.Dayjs {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new AppError(`${option} must use YYYY-MM-DD format`, 'INVALID_DATE_RANGE');
  }

  const parsed = dayjs(value);
  if (!parsed.isValid() || parsed.format('YYYY-MM-DD') !== value) {
    throw new AppError(`${option} is not a valid calendar date`, 'INVALID_DATE_RANGE');
  }
  return parsed;
}

export function resolveTimeRange(range?: TimeRange, from?: string, to?: string): TimeRangeFilter {
  if ((from && !to) || (!from && to)) {
    throw new AppError('--from and --to must be provided together', 'INVALID_DATE_RANGE');
  }

  if (from && to) {
    const parsedFrom = parseDate(from, '--from');
    const parsedTo = parseDate(to, '--to');
    if (parsedFrom.isAfter(parsedTo, 'day')) {
      throw new AppError('--from must be on or before --to', 'INVALID_DATE_RANGE');
    }
    const fromDate = parsedFrom.startOf('day').toDate();
    const toDate = parsedTo.endOf('day').toDate();
    return { from: fromDate, to: toDate, label: `${from} to ${to}` };
  }

  const resolved = range ?? '7d';
  const now = dayjs();

  switch (resolved) {
    case 'today': {
      const from = now.startOf('day').toDate();
      const to = now.endOf('day').toDate();
      return { from, to, label: 'Today' };
    }
    case '7d': {
      const from = now.subtract(6, 'day').startOf('day').toDate();
      const to = now.endOf('day').toDate();
      return { from, to, label: '7 Days' };
    }
    case '30d': {
      const from = now.subtract(29, 'day').startOf('day').toDate();
      const to = now.endOf('day').toDate();
      return { from, to, label: '30 Days' };
    }
    case 'month': {
      const from = now.startOf('month').toDate();
      const to = now.endOf('day').toDate();
      return { from, to, label: 'This Month' };
    }
    default: {
      throw new AppError(`Unsupported time range: ${String(resolved)}`, 'INVALID_TIME_RANGE');
    }
  }
}

export const RANGE_KEYS: Record<string, TimeRange> = {
  t: 'today',
  '7': '7d',
  '3': '30d',
  m: 'month',
};

export const RANGE_TABS: { key: TimeRange; label: string; shortcut: string }[] = [
  { key: 'today', label: 'Today', shortcut: 't' },
  { key: '7d', label: '7 Days', shortcut: '7' },
  { key: '30d', label: '30 Days', shortcut: '3' },
  { key: 'month', label: 'This Month', shortcut: 'm' },
];
