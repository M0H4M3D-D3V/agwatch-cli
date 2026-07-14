import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { filePathToSessionId } from './paths.js';
import { nonNegativeNumber } from '../../utils/numbers.js';

type JsonObject = Record<string, unknown>;

type CodexLine = {
  timestamp?: string;
  type?: string;
  cwd?: string;
  model?: string;
  usage?: JsonObject;
  payload?: JsonObject;
};

export type ParsedCodexEntry = {
  timestamp: string;
  sessionId: string;
  project: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  writtenTokens: number;
  tools: string[];
  bashCommands: string[];
  bashCommand?: string;
};

export async function parseCodexJsonlFile(
  filePath: string,
  fromMs: number,
  toMs: number,
): Promise<ParsedCodexEntry[]> {
  const results: ParsedCodexEntry[] = [];
  const fallbackSessionId = filePathToSessionId(filePath);
  let sessionId = fallbackSessionId;
  let project = '';
  let model = '';
  let pendingTools: string[] = [];
  let pendingShellCommands: string[] = [];
  let pendingShellCommand: string | undefined;

  let rl: ReturnType<typeof createInterface>;
  try {
    rl = createInterface({
      input: createReadStream(filePath, 'utf8'),
      crlfDelay: Infinity,
    });
  } catch {
    return results;
  }

  for await (const line of rl) {
    if (!line.trim()) continue;

    let obj: CodexLine;
    try {
      obj = JSON.parse(line) as CodexLine;
    } catch {
      continue;
    }

    const payload = asObject(obj.payload) ?? {};
  const payloadSessionId = stringValue(payload.id) ?? stringValue(payload.session_id) ?? stringValue(payload.sessionId);
    if (payloadSessionId && (obj.type === 'session_meta' || !sessionId)) sessionId = payloadSessionId;

    const cwd = stringValue(obj.cwd) ?? stringValue(payload.cwd);
    if (!project && cwd) project = extractProject(cwd);

    const lineModel = stringValue(obj.model) ?? stringValue(payload.model) ?? stringValue(payload.model_slug);
    if (lineModel) model = lineModel;

    const tool = extractTool(payload);
    if (tool.name) {
      pendingTools.push(tool.name);
      if (tool.shellCommand) {
        pendingShellCommand = tool.shellCommand;
        pendingShellCommands.push(tool.shellCommand);
      }
    }

    const usage = findUsage(obj, payload);
    if (!usage) continue;

    const tools = pendingTools;
    const shellCommands = pendingShellCommands;
    const shellCommand = pendingShellCommand;
    pendingTools = [];
    pendingShellCommands = [];
    pendingShellCommand = undefined;

    const ts = obj.timestamp ?? stringValue(payload.timestamp);
    if (!ts) continue;
    const tsMs = new Date(ts).getTime();
    if (!Number.isFinite(tsMs) || tsMs < fromMs || tsMs > toMs) continue;

    const inputTokens = tokenValue(usage, ['input_tokens', 'prompt_tokens', 'inputTokens', 'promptTokens']);
    const outputTokens = tokenValue(usage, ['output_tokens', 'completion_tokens', 'outputTokens', 'completionTokens']);
    const cachedTokens = cachedTokenValue(usage);
    const writtenTokens = tokenValue(usage, ['cache_creation_input_tokens', 'cacheWriteInputTokens', 'written_tokens', 'writtenTokens']);

    if (inputTokens === 0 && outputTokens === 0 && cachedTokens === 0 && writtenTokens === 0) continue;

    results.push({
      timestamp: ts,
      sessionId,
      project: project || 'unknown',
      model: model || 'unknown',
      inputTokens,
      outputTokens,
      cachedTokens,
      writtenTokens,
      tools,
      bashCommands: shellCommands,
      bashCommand: shellCommand,
    });
  }

  return results;
}

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? nonNegativeNumber(value) : 0;
}

function tokenValue(obj: JsonObject, keys: string[]): number {
  for (const key of keys) {
    const n = numberValue(obj[key]);
    if (n > 0) return n;
  }
  return 0;
}

function cachedTokenValue(usage: JsonObject): number {
  const direct = tokenValue(usage, ['cached_tokens', 'cachedTokens', 'cached_input_tokens', 'cachedInputTokens', 'cache_read_input_tokens', 'cacheReadInputTokens']);
  if (direct > 0) return direct;

  const inputDetails = asObject(usage.input_token_details) ?? asObject(usage.inputTokensDetails) ?? asObject(usage.prompt_tokens_details);
  return inputDetails ? tokenValue(inputDetails, ['cached_tokens', 'cachedTokens']) : 0;
}

function findUsage(obj: CodexLine, payload: JsonObject): JsonObject | null {
  const direct = asObject(obj.usage) ?? asObject(payload.usage);
  if (direct) return direct;

  if (obj.type === 'event_msg' && payload.type === 'token_count') {
    const info = asObject(payload.info);
    const last = asObject(info?.last_token_usage);
    if (last) return last;
  }

  const response = asObject(payload.response);
  if (response) {
    const responseUsage = asObject(response.usage);
    if (responseUsage) return responseUsage;
  }

  return null;
}

function extractTool(payload: JsonObject): { name?: string; shellCommand?: string } {
  const type = stringValue(payload.type) ?? '';
  const rawName = stringValue(payload.name) ?? stringValue(payload.tool_name) ?? stringValue(payload.toolName);
  if (!rawName && type !== 'function_call' && type !== 'tool_call') return {};

  const name = rawName ?? type;
  const args = payload.arguments;
  const input = asObject(payload.input);
  const command = typeof args === 'string'
    ? commandFromArguments(args)
    : stringValue(input?.command);

  return {
    name: normalizeToolName(name),
    shellCommand: command ? extractShellCommand(command) : undefined,
  };
}

function commandFromArguments(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const obj = asObject(parsed);
    return stringValue(obj?.command) ?? stringValue(obj?.cmd);
  } catch {
    return undefined;
  }
}

function normalizeToolName(name: string): string {
  const lower = name.toLowerCase().trim();
  if (lower === 'shell' || lower === 'bash' || lower === 'exec_command' || lower === 'shell_command') return 'Bash';
  if (lower === 'read' || lower === 'fileread' || lower === 'file_read') return 'Read';
  if (lower === 'write' || lower === 'filewrite' || lower === 'file_write') return 'Write';
  if (lower === 'edit' || lower === 'apply_patch') return 'Edit';
  if (lower === 'grep' || lower === 'search') return 'Grep';
  if (lower === 'glob' || lower === 'list') return 'Glob';
  if (lower.startsWith('mcp__')) return name;
  return name || 'unknown';
}

function extractShellCommand(text: string): string {
  const firstLine = text.split('\n')[0]?.trim() ?? '';
  const tokens = firstLine.split(/\s+/);
  const cmd = tokens[0] ?? '';
  if (!cmd) return '';
  return cmd.replace(/\\/g, '/').split('/').pop() ?? cmd;
}

function extractProject(cwd: string): string {
  const cleaned = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  const parts = cleaned.split('/');
  return parts[parts.length - 1] || 'unknown';
}
