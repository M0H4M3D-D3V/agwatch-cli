export function finiteNumber(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function nonNegativeNumber(value: unknown, fallback = 0): number {
  return Math.max(0, finiteNumber(value, fallback));
}
