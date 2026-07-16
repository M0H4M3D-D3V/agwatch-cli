import type { ProviderUsageData, ProviderUsageLimit } from './types.js';
import { clampPct, formatDateShort } from './format-utils.js';

type JsonObject = Record<string, unknown>;

export type UsageLimitExtractionOptions = {
  aliases?: Record<string, string>;
  observedAt?: number;
};

const PERCENT_KEYS = [
  'used_percent',
  'used_percentage',
  'usedPercent',
  'usedPercentage',
  'percent_used',
  'percentUsed',
  'usage_percent',
  'usage_percentage',
  'usagePercent',
  'usagePercentage',
  'utilization_percent',
  'utilizationPercent',
  'percentage',
  'percent',
  'utilization',
];
const RESET_AT_KEYS = ['reset_at', 'resets_at', 'resetAt', 'nextResetTime', 'next_reset_time'];
const RESET_AFTER_KEYS = ['reset_after_seconds', 'resetAfterSeconds', 'resetInSec', 'reset_in_seconds'];
const WINDOW_SECONDS_KEYS = ['limit_window_seconds', 'limitWindowSeconds', 'window_seconds', 'windowSeconds'];
const LABEL_KEYS = [
  'label',
  'display_name',
  'displayName',
  'name',
  'title',
  'model',
  'model_name',
  'modelName',
  'limit_name',
  'limitName',
  'window_name',
  'windowName',
];
const CONTEXT_RE = /usage|quota|limit|window|rolling|hour|day|week|month|session|token|用量|额度|限制/i;
const EXCLUDED_RE = /discount|tax|saving|profile|completion|analytics|battery/i;
const GENERIC_LABEL_RE = /^(?:data|items?|limits?|quotas?|records?|usage)$/i;

type LabelMetadata = { label: string; id?: string };

function objectValue(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\s*\d+(?:\.\d+)?\s*%?\s*$/.test(value)) return Number.parseFloat(value);
  return null;
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function humanize(value: string): string {
  const text = value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_:/-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim();
  return text || 'Usage limit';
}

function directLabelMetadata(obj: JsonObject): LabelMetadata | undefined {
  const label = LABEL_KEYS
    .map((key) => obj[key])
    .find((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0 && entry.length <= 80);
  if (!label) return undefined;
  const id = ['id', 'key', 'slug', 'code']
    .map((key) => obj[key])
    .find((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
  return { label, id };
}

function nestedLabelMetadata(value: unknown, depth: number = 0): LabelMetadata | undefined {
  if (depth >= 4) return undefined;
  const children = Array.isArray(value) ? value : Object.values(objectValue(value) ?? {});
  for (const child of children) {
    const obj = objectValue(child);
    if (!obj) continue;
    if (percentageFrom(obj) != null) continue;
    const metadata = directLabelMetadata(obj);
    if (metadata) return metadata;
  }
  for (const child of children) {
    const obj = objectValue(child);
    if (child && typeof child === 'object' && (!obj || percentageFrom(obj) == null)) {
      const metadata = nestedLabelMetadata(child, depth + 1);
      if (metadata) return metadata;
    }
  }
  return undefined;
}

function durationLabelFrom(obj: JsonObject): string | undefined {
  const seconds = WINDOW_SECONDS_KEYS
    .map((key) => numberValue(obj[key]))
    .find((value): value is number => value != null && value > 0);
  if (seconds == null) return undefined;

  const units: Array<[number, string]> = [
    [86_400, 'day'],
    [3_600, 'hour'],
    [60, 'minute'],
  ];
  for (const [unitSeconds, unit] of units) {
    if (seconds >= unitSeconds && seconds % unitSeconds === 0) {
      const amount = seconds / unitSeconds;
      return `${amount} ${unit}${amount === 1 ? '' : 's'}`;
    }
  }
  return `${seconds} seconds`;
}

function parseReset(obj: JsonObject, observedAt: number): { resetDate: string; resetAt?: number } {
  for (const key of RESET_AT_KEYS) {
    const raw = obj[key];
    let resetAt: number | undefined;
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
      resetAt = raw > 1e11 ? raw : raw * 1000;
    } else if (typeof raw === 'string' && raw.trim()) {
      if (/^\d+(?:\.\d+)?$/.test(raw.trim())) {
        const numeric = Number(raw);
        resetAt = numeric > 1e11 ? numeric : numeric * 1000;
      } else {
        const parsed = new Date(raw).getTime();
        if (Number.isFinite(parsed)) resetAt = parsed;
      }
    }
    if (resetAt) return { resetAt, resetDate: formatDateShort(new Date(resetAt)) };
  }

  for (const key of RESET_AFTER_KEYS) {
    const seconds = numberValue(obj[key]);
    if (seconds != null && seconds > 0) {
      const resetAt = observedAt + seconds * 1000;
      return { resetAt, resetDate: formatDateShort(new Date(resetAt)) };
    }
  }

  return { resetDate: '--' };
}

function percentageFrom(obj: JsonObject): number | null {
  for (const key of PERCENT_KEYS) {
    const value = numberValue(obj[key]);
    if (value != null && value >= 0) return clampPct(value);
  }

  const ratioPairs: Array<[string, string]> = [
    ['used', 'total'],
    ['used', 'limit'],
    ['used', 'maximum'],
    ['consumed', 'limit'],
    ['consumed', 'total'],
    ['current', 'maximum'],
    ['current', 'limit'],
    ['usage', 'limit'],
  ];
  for (const [usedKey, totalKey] of ratioPairs) {
    const used = numberValue(obj[usedKey]);
    const total = numberValue(obj[totalKey]);
    if (used != null && total != null && used >= 0 && total > 0) return clampPct((used / total) * 100);
  }
  return null;
}

function aliasFor(obj: JsonObject, path: string[], aliases: Record<string, string>): { key?: string; label?: string } {
  const type = typeof obj.type === 'string' ? obj.type : '';
  const unit = typeof obj.unit === 'string' || typeof obj.unit === 'number' ? String(obj.unit) : '';
  const semanticPath = path.filter((part) => !/^\d+$/.test(part)).reverse();
  const candidates = [unit && type ? `${type}:${unit}` : '', ...semanticPath, type].filter(Boolean);
  for (const candidate of candidates) {
    const label = aliases[normalizeKey(candidate)];
    if (label) return { key: candidate, label };
  }
  return { key: candidates[0] };
}

export function extractUsageLimits(payload: unknown, options: UsageLimitExtractionOptions = {}): ProviderUsageLimit[] {
  const aliases = Object.fromEntries(
    Object.entries(options.aliases ?? {}).map(([key, label]) => [normalizeKey(key), label]),
  );
  const observedAt = options.observedAt ?? Date.now();
  const limits: ProviderUsageLimit[] = [];
  const seen = new Set<string>();
  let visited = 0;

  function walk(value: unknown, path: string[], depth: number): void {
    if (depth > 12 || visited++ > 10_000) return;
    if (Array.isArray(value)) {
      for (let i = 0; i < Math.min(value.length, 1_000); i++) walk(value[i], [...path, String(i)], depth + 1);
      return;
    }
    const obj = objectValue(value);
    if (!obj) return;

    const percentage = percentageFrom(obj);
    if (percentage != null) {
      const alias = aliasFor(obj, path, aliases);
      const directMetadata = directLabelMetadata(obj);
      const nestedMetadata = directMetadata ? undefined : nestedLabelMetadata(obj);
      const explicitLabel = directMetadata?.label ?? nestedMetadata?.label;
      const durationLabel = durationLabelFrom(obj);
      const context = `${path.join(' ')} ${String(obj.type ?? '')} ${String(obj.name ?? '')} ${explicitLabel ?? ''}`;
      if ((alias.label || CONTEXT_RE.test(context)) && !EXCLUDED_RE.test(context)) {
        const semanticPathKey = [...path].reverse().find((part) => !/^\d+$/.test(part)) ?? alias.key ?? 'usage';
        const inferredKey = alias.key ?? semanticPathKey;
        if (explicitLabel || durationLabel || alias.label || !GENERIC_LABEL_RE.test(inferredKey)) {
          const label = explicitLabel
            ? humanize(explicitLabel)
            : durationLabel ?? alias.label ?? humanize(inferredKey);
          const explicitId = ['id', 'key', 'model', 'model_name', 'modelName']
            .map((key) => obj[key])
            .find((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
            ?? directMetadata?.id
            ?? nestedMetadata?.id;
          const type = typeof obj.type === 'string' ? obj.type : undefined;
          const unit = typeof obj.unit === 'string' || typeof obj.unit === 'number' ? String(obj.unit) : undefined;
          const typedId = type && unit ? `${type}:${unit}` : undefined;
          const id = explicitId ?? typedId ?? (path.join('/') || alias.key || semanticPathKey);
          const reset = parseReset(obj, observedAt);
          const dedupeKey = [
            normalizeKey(id),
            normalizeKey(label),
            percentage,
            reset.resetAt ?? reset.resetDate,
          ].join(':');
          if (!seen.has(dedupeKey)) {
            seen.add(dedupeKey);
            limits.push({ id, label, usedPercent: percentage, ...reset });
          }
        }
      }
    }

    for (const [key, child] of Object.entries(obj)) walk(child, [...path, key], depth + 1);
  }

  walk(payload, [], 0);
  const totals = new Map<string, number>();
  for (const limit of limits) totals.set(normalizeKey(limit.label), (totals.get(normalizeKey(limit.label)) ?? 0) + 1);
  const occurrences = new Map<string, number>();
  return limits.map((limit) => {
    const key = normalizeKey(limit.label);
    if ((totals.get(key) ?? 0) <= 1) return limit;
    const occurrence = (occurrences.get(key) ?? 0) + 1;
    occurrences.set(key, occurrence);
    return { ...limit, label: `${limit.label} (${occurrence})` };
  });
}

function findLimit(limits: ProviderUsageLimit[], pattern: RegExp): ProviderUsageLimit | undefined {
  return limits.find((limit) => pattern.test(`${limit.id ?? ''} ${limit.label}`));
}

function findExactLimit(limits: ProviderUsageLimit[], ids: string[]): ProviderUsageLimit | undefined {
  const normalized = new Set(ids.map(normalizeKey));
  return limits.find((limit) => limit.id && normalized.has(normalizeKey(limit.id)));
}

export function legacyFieldsFromLimits(limits: ProviderUsageLimit[]): Pick<ProviderUsageData,
  'sessionUsedPct' | 'weeklyUsedPct' | 'sessionResetDate' | 'weeklyResetDate' | 'monthlyUsedPct' | 'monthlyResetDate'> {
  const session = findExactLimit(limits, ['primary_window', 'five_hour', 'rollingUsage', 'TOKENS_LIMIT:3'])
    ?? findLimit(limits, /primary_window|five_hour|rolling|\b\d+\s*(?:h|hours?)\b|\d+\s*小时|tokens_limit:3/i);
  const weekly = findExactLimit(limits, ['secondary_window', 'seven_day', 'weeklyUsage', 'TOKENS_LIMIT:6'])
    ?? findLimit(limits, /secondary_window|seven_day|week|每周|7\s*day|tokens_limit:6/i);
  const monthly = findExactLimit(limits, ['monthlyUsage', 'monthly']) ?? findLimit(limits, /month|每月/i);
  return {
    sessionUsedPct: session?.usedPercent ?? 0,
    weeklyUsedPct: weekly?.usedPercent ?? 0,
    sessionResetDate: session?.resetDate ?? '--',
    weeklyResetDate: weekly?.resetDate ?? '--',
    monthlyUsedPct: monthly?.usedPercent,
    monthlyResetDate: monthly?.resetDate,
  };
}

export function getProviderLimits(data: ProviderUsageData): ProviderUsageLimit[] {
  return data.limits ?? [];
}
