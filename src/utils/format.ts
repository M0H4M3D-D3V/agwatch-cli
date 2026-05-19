import { finiteNumber, nonNegativeNumber } from './numbers.js';

export function formatMoney(value: number): string {
  const safeValue = finiteNumber(value);
  if (safeValue >= 1_000_000) return `$${(safeValue / 1_000_000).toFixed(2)}M`;
  if (safeValue >= 1_000) return `$${(safeValue / 1_000).toFixed(2)}K`;
  return `$${safeValue.toFixed(2)}`;
}

export function formatInt(value: number): string {
  return finiteNumber(value).toLocaleString('en-US');
}

export function formatTokenCount(value: number): string {
  const safeValue = finiteNumber(value);
  if (safeValue >= 1_000_000_000) return `${(safeValue / 1_000_000_000).toFixed(1)}B`;
  if (safeValue >= 1_000_000) return `${(safeValue / 1_000_000).toFixed(1)}M`;
  if (safeValue >= 1_000) return `${(safeValue / 1_000).toFixed(1)}K`;
  return safeValue.toString();
}

export function formatPercent(value: number, decimals = 0): string {
  return `${finiteNumber(value).toFixed(decimals)}%`;
}

export function formatDuration(ms: number): string {
  const seconds = Math.floor(nonNegativeNumber(ms) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function truncateLabel(label: string, maxLen: number): string {
  if (label.length <= maxLen) return label;
  return label.slice(0, maxLen - 1) + '…';
}

export function padRight(str: string, len: number): string {
  if (str.length >= len) return str.slice(0, len);
  return str + ' '.repeat(len - str.length);
}

export function padLeft(str: string, len: number): string {
  if (str.length >= len) return str.slice(0, len);
  return ' '.repeat(len - str.length) + str;
}

export function renderProgressBar(pct: number, width: number): string {
  const clamped = Math.max(0, Math.min(100, finiteNumber(pct)));
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}
