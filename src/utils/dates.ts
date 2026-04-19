import dayjs from 'dayjs';

export function toDayKey(dateStr: string): string {
  return dayjs(dateStr).format('YYYY-MM-DD');
}

export function formatDayShort(dateStr: string): string {
  return dayjs(dateStr).format('MMM DD');
}

export function isInRange(dateStr: string, from: Date, to: Date): boolean {
  const d = dayjs(dateStr);
  return d.isAfter(dayjs(from).subtract(1, 'ms')) && d.isBefore(dayjs(to).add(1, 'ms'));
}
