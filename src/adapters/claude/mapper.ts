import type { UsageEvent } from '../../domain/types.js';
import type { ParsedClaudeEntry } from './reader.js';
import { getCachedPricing, type ModelPricing } from '../../services/pricing-fetcher.js';
import { nonNegativeNumber } from '../../utils/numbers.js';

const CLAUDE_MODEL_MAP: Record<string, string[]> = {
  'anthropic/claude-opus-4':     ['claude-opus-4-1', 'claude-opus-4-0', 'opus-4'],
  'anthropic/claude-sonnet-4':   ['claude-sonnet-4-5', 'claude-sonnet-4-6', 'sonnet-4'],
  'anthropic/claude-3.5-sonnet': ['claude-3-5-sonnet', 'claude-3.5-sonnet'],
  'anthropic/claude-3.5-haiku':  ['claude-3-5-haiku', 'claude-3.5-haiku'],
  'anthropic/claude-3-opus':     ['claude-3-opus'],
};

function normalizeModel(raw: string): string {
  const lower = raw.toLowerCase();
  for (const [canonical, patterns] of Object.entries(CLAUDE_MODEL_MAP)) {
    for (const p of patterns) {
      if (lower.includes(p)) return canonical;
    }
  }
  if (lower.includes('claude')) return 'anthropic/claude';
  return raw || 'unknown';
}

function normalizeToolName(name: string): string {
  const lower = name.toLowerCase().trim();
  if (lower === 'bash') return 'Bash';
  if (lower === 'read' || lower === 'fileread') return 'Read';
  if (lower === 'write' || lower === 'filewrite') return 'Write';
  if (lower === 'edit' || lower === 'fileedit') return 'Edit';
  if (lower === 'glob') return 'Glob';
  if (lower === 'grep') return 'Grep';
  if (lower === 'webfetch' || lower === 'web_fetch') return 'WebFetch';
  if (lower === 'websearch' || lower === 'web_search') return 'WebSearch';
  if (lower === 'agent') return 'Agent';
  if (lower.startsWith('mcp__')) return name;
  return name || 'unknown';
}

export function mapClaudeEntries(entries: ParsedClaudeEntry[]): UsageEvent[] {
  const pricing = getCachedPricing();

  return entries.map((entry) => {
    const normalizedModel = normalizeModel(entry.model);
    const toolNames = entry.tools.map(normalizeToolName);
    const inputTokens = nonNegativeNumber(entry.inputTokens);
    const outputTokens = nonNegativeNumber(entry.outputTokens);
    const cachedTokens = nonNegativeNumber(entry.cachedTokens);
    const writtenTokens = nonNegativeNumber(entry.writtenTokens);
    let mcpServer: string | undefined;
    for (const t of entry.tools) {
      if (t.startsWith('mcp__')) {
        const parts = t.slice(5).split('__');
        mcpServer = parts[0] ?? t;
        break;
      }
    }

    return {
      ts: entry.timestamp,
      sessionId: entry.sessionId,
      project: entry.project,
      activity: 'General',
      provider: 'anthropic',
      model: normalizedModel,
      inputTokens,
      outputTokens,
      cachedTokens,
      writtenTokens,
      costUsd: estimateCost(normalizedModel, inputTokens, outputTokens, cachedTokens, writtenTokens, pricing),
      callCount: 1,
      toolName: toolNames.length > 0 ? toolNames.join(', ') : undefined,
      shellCommand: entry.bashCommand,
      mcpServer,
    };
  });
}

function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedTokens: number,
  writtenTokens: number,
  pricing: Record<string, ModelPricing> | null,
): number {
  if (!pricing || !pricing[model]) return 0;
  const p = pricing[model];
  const safeInput = nonNegativeNumber(inputTokens);
  const safeOutput = nonNegativeNumber(outputTokens);
  const safeCached = nonNegativeNumber(cachedTokens);
  const safeWritten = nonNegativeNumber(writtenTokens);
  return nonNegativeNumber(safeInput * p.input + safeOutput * p.output + safeCached * p.cachedInput + safeWritten * p.cachedWrite);
}
