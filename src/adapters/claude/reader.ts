import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

type ClaudeMessage = {
  type: string;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  message?: {
    role?: string;
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
    content?: Array<{
      type: string;
      name?: string;
      input?: Record<string, unknown>;
    }>;
  };
};

export type ParsedClaudeEntry = {
  type: 'assistant';
  timestamp: string;
  sessionId: string;
  project: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  tools: string[];
  bashCommand?: string;
};

export async function parseJsonlFile(
  filePath: string,
  fromMs: number,
  toMs: number,
): Promise<ParsedClaudeEntry[]> {
  const results: ParsedClaudeEntry[] = [];
  let projectFromCwd = '';

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
    let obj: ClaudeMessage;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    if (!projectFromCwd && obj.cwd) {
      projectFromCwd = extractProject(obj.cwd);
    }

    if (obj.type !== 'assistant' || !obj.message) continue;

    const model = obj.message.model ?? '';
    if (!model || model.startsWith('<')) continue;

    const ts = obj.timestamp;
    if (!ts) continue;
    const tsMs = new Date(ts).getTime();
    if (tsMs < fromMs || tsMs > toMs) continue;

    const usage = obj.message.usage ?? {};
    const content = obj.message.content ?? [];

    const tools: string[] = [];
    let bashCommand: string | undefined;

    for (const block of content) {
      if (block.type === 'tool_use' && block.name) {
        tools.push(block.name);
        if (block.name === 'Bash' && block.input?.command && typeof block.input.command === 'string') {
          bashCommand = extractShellCommand(block.input.command);
        }
      }
    }

    results.push({
      type: 'assistant',
      timestamp: ts,
      sessionId: obj.sessionId ?? '',
      project: projectFromCwd,
      model,
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cachedTokens: (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
      tools,
      bashCommand,
    });
  }

  return results;
}

function extractShellCommand(text: string): string {
  const firstLine = text.split('\n')[0]?.trim() ?? '';
  const tokens = firstLine.split(/\s+/);
  const cmd = tokens[0] ?? '';
  if (!cmd) return '';
  const base = cmd.replace(/\\/g, '/').split('/').pop() ?? cmd;
  return base;
}

function extractProject(cwd: string): string {
  const cleaned = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  const parts = cleaned.split('/');
  return parts[parts.length - 1] || 'unknown';
}
