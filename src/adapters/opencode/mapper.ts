import type { RawSession, RawMessage, RawPart, UsageEvent } from '../../domain/types.js';
import { fetchPricing, getCachedPricing, type ModelPricing } from '../../services/pricing-fetcher.js';

export { getCachedPricing } from '../../services/pricing-fetcher.js';

export async function initPricing(): Promise<void> {
  try {
    await fetchPricing();
  } catch {}
}

export function mapToUsageEvents(
  sessions: RawSession[],
  messages: RawMessage[],
  parts: RawPart[]
): UsageEvent[] {
  const sessionMap = new Map(sessions.map((s) => [s.id, s]));
  const messageParts = new Map<string, RawPart[]>();
  for (const part of parts) {
    const existing = messageParts.get(part.messageId) ?? [];
    existing.push(part);
    messageParts.set(part.messageId, existing);
  }

  const dynamicPricing = getCachedPricing();
  const events: UsageEvent[] = [];

  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;

    const session = sessionMap.get(msg.sessionId);
    if (!session) continue;

    const msgParts = messageParts.get(msg.id) ?? [];

    const toolNames: string[] = [];
    let shellCommand: string | undefined;
    let mcpServer: string | undefined;

    for (const part of msgParts) {
      if (part.type === 'tool-call' && part.name) {
        toolNames.push(normalizeToolName(part.name));

        if (part.name === 'bash' && part.text) {
          shellCommand = extractShellCommand(part.text);
        }

        if (part.name.startsWith('mcp__') || part.name.includes('mcp')) {
          mcpServer = normalizeMcpServer(part.name);
        }
      }
    }

    const normalizedModel = normalizeModel(msg.model ?? '');

    events.push({
      ts: msg.createdAt || session.createdAt,
      sessionId: msg.sessionId,
      project: normalizeProject(session.project),
      activity: 'General',
      provider: normalizeProvider(msg.provider ?? ''),
      model: normalizedModel,
      inputTokens: msg.inputTokens ?? 0,
      outputTokens: msg.outputTokens ?? 0,
      cachedTokens: msg.cachedTokens ?? 0,
      writtenTokens: msg.writtenTokens ?? 0,
      costUsd: msg.costUsd > 0 ? msg.costUsd : estimateCost(normalizedModel, msg.inputTokens ?? 0, msg.outputTokens ?? 0, msg.cachedTokens ?? 0, dynamicPricing),
      callCount: 1,
      toolName: toolNames.length > 0 ? toolNames.join(', ') : undefined,
      shellCommand,
      mcpServer,
    });
  }

  return events;
}

function normalizeProject(project?: string): string {
  if (!project || project === 'undefined' || project === 'null') return 'unknown';
  const cleaned = project.replace(/\\/g, '/').replace(/\/+$/, '');
  const parts = cleaned.split('/');
  return parts[parts.length - 1] || 'unknown';
}

function normalizeProvider(provider: string): string {
  const lower = (provider ?? '').toLowerCase();
  if (lower.includes('openai')) return 'openai';
  if (lower.includes('anthropic')) return 'anthropic';
  if (lower.includes('google') || lower.includes('gemini')) return 'google';
  if (lower.includes('xai') || lower.includes('x-ai')) return 'xai';
  if (lower.includes('zai')) return 'zai';
  return provider || 'unknown';
}

function normalizeModel(model: string): string {
  const lower = (model ?? '').toLowerCase();

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

  if (lower.includes('claude-opus-4')) return 'anthropic/claude-opus-4';
  if (lower.includes('claude-sonnet-4')) return 'anthropic/claude-sonnet-4';
  if (lower.includes('claude-3.5-sonnet') || lower.includes('claude-3-5-sonnet')) return 'anthropic/claude-3.5-sonnet';
  if (lower.includes('claude-3.5-haiku') || lower.includes('claude-3-5-haiku')) return 'anthropic/claude-3.5-haiku';
  if (lower.includes('claude-3-opus')) return 'anthropic/claude-3-opus';
  if (lower.includes('claude')) return 'anthropic/claude';

  if (lower.includes('gemini-2.5-pro')) return 'google/gemini-2.5-pro';
  if (lower.includes('gemini-2.5-flash')) return 'google/gemini-2.5-flash';
  if (lower.includes('gemini-2')) return 'google/gemini-2';
  if (lower.includes('gemini')) return 'google/gemini';

  if (lower.includes('grok')) return 'xai/grok';

  return model || 'unknown';
}

function normalizeToolName(name: string): string {
  const lower = name.toLowerCase().trim();
  if (lower === 'bash' || lower === 'shell' || lower === 'exec') return 'Bash';
  if (lower === 'read' || lower === 'fileread' || lower === 'file_read') return 'Read';
  if (lower === 'write' || lower === 'filewrite' || lower === 'file_write') return 'Write';
  if (lower === 'edit' || lower === 'fileedit' || lower === 'file_edit') return 'Edit';
  if (lower === 'grep') return 'Grep';
  if (lower === 'glob') return 'Glob';
  if (lower === 'search') return 'Search';
  if (lower === 'list') return 'List';
  if (lower === 'todowrite' || lower === 'todo_write') return 'TodoWrite';
  if (lower === 'task') return 'Task';
  if (lower === 'webfetch' || lower === 'web_fetch') return 'WebFetch';
  if (lower === 'skill') return 'Skill';
  if (lower.startsWith('mcp__')) return name;
  return name || 'unknown';
}

function extractShellCommand(text: string): string {
  const firstLine = text.split('\n')[0]?.trim() ?? '';
  const tokens = firstLine.split(/\s+/);
  const cmd = tokens[0] ?? '';
  if (!cmd) return '';
  const base = cmd.replace(/\\/g, '/').split('/').pop() ?? cmd;
  return base;
}

function normalizeMcpServer(name: string): string {
  if (name.startsWith('mcp__')) {
    const parts = name.slice(5).split('__');
    return parts[0] ?? name;
  }
  return name;
}

function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedTokens: number,
  dynamicPricing: Record<string, ModelPricing> | null,
): number {
  if (!dynamicPricing || !dynamicPricing[model]) return 0;
  const p = dynamicPricing[model];
  const effectiveInput = Math.max(0, inputTokens - cachedTokens);
  return effectiveInput * p.input + outputTokens * p.output + cachedTokens * p.cachedInput;
}
