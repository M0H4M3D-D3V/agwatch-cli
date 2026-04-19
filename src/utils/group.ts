export function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const existing = map.get(key);
    if (existing) {
      existing.push(item);
    } else {
      map.set(key, [item]);
    }
  }
  return map;
}

export function sortByDesc<T>(items: T[], keyFn: (item: T) => number): T[] {
  return [...items].sort((a, b) => keyFn(b) - keyFn(a));
}

export function sumBy<T>(items: T[], keyFn: (item: T) => number): number {
  return items.reduce((acc, item) => acc + keyFn(item), 0);
}

export function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}
