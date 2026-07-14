import type { UsageEvent } from '../../domain/types.js';
import type { ParsedCodexEntry } from './reader.js';
import { getCachedPricing, type ModelPricing } from '../../services/pricing-fetcher.js';
import { nonNegativeNumber } from '../../utils/numbers.js';

export function mapCodexEntries(entries: ParsedCodexEntry[], agentId = 'codex'): UsageEvent[] {
  const pricing = getCachedPricing();

  return entries.map((entry) => {
    const normalizedModel = normalizeModel(entry.model);
    const inputTokens = nonNegativeNumber(entry.inputTokens);
    const outputTokens = nonNegativeNumber(entry.outputTokens);
    const cachedTokens = nonNegativeNumber(entry.cachedTokens);
    const writtenTokens = nonNegativeNumber(entry.writtenTokens);
    const mcpServers = entry.tools
      .filter((tool) => tool.startsWith('mcp__'))
      .map((tool) => tool.slice(5).split('__')[0] ?? tool);

    return {
      agentId,
      ts: entry.timestamp,
      sessionId: entry.sessionId,
      project: entry.project,
      activity: 'General',
      provider: 'openai',
      model: normalizedModel,
      inputTokens,
      outputTokens,
      cachedTokens,
      writtenTokens,
      costUsd: estimateCost(normalizedModel, inputTokens, outputTokens, cachedTokens, writtenTokens, pricing),
      callCount: 1,
      toolNames: entry.tools.length > 0 ? entry.tools : undefined,
      toolName: entry.tools[0],
      shellCommands: entry.bashCommands.length > 0 ? entry.bashCommands : undefined,
      shellCommand: entry.bashCommands[0] ?? entry.bashCommand,
      mcpServers: mcpServers.length > 0 ? mcpServers : undefined,
      mcpServer: mcpServers[0],
    };
  });
}

function normalizeModel(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes('gpt-5-codex')) return 'openai/gpt-5-codex';
  if (lower.includes('gpt-5.5')) return 'openai/gpt-5.5';
  if (lower.includes('gpt-5.4')) return 'openai/gpt-5.4';
  if (lower.includes('gpt-5.3-codex')) return 'openai/gpt-5.3-codex';
  if (lower.includes('gpt-5')) return 'openai/gpt-5';
  if (lower.includes('gpt-4.1')) return 'openai/gpt-4.1';
  if (lower.includes('gpt-4o')) return 'openai/gpt-4o';
  if (lower.includes('gpt-4')) return 'openai/gpt-4';
  if (lower.includes('o3-mini')) return 'openai/o3-mini';
  if (lower.includes('o3')) return 'openai/o3';
  if (lower.includes('o4-mini')) return 'openai/o4-mini';
  if (lower.includes('o4')) return 'openai/o4';
  return lower || 'unknown';
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
  return nonNegativeNumber(
    nonNegativeNumber(inputTokens) * p.input +
    nonNegativeNumber(outputTokens) * p.output +
    nonNegativeNumber(cachedTokens) * p.cachedInput +
    nonNegativeNumber(writtenTokens) * p.cachedWrite,
  );
}
