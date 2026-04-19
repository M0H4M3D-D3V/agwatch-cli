import dayjs from 'dayjs';
import type { TimeRange, TimeRangeFilter } from '../domain/types.js';

export function resolveTimeRange(range?: TimeRange, from?: string, to?: string): TimeRangeFilter {
  if (from && to) {
    const fromDate = dayjs(from).startOf('day').toDate();
    const toDate = dayjs(to).endOf('day').toDate();
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
      const from = now.subtract(6, 'day').startOf('day').toDate();
      const to = now.endOf('day').toDate();
      return { from, to, label: '7 Days' };
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
