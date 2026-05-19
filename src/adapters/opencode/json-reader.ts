import fs from 'node:fs';
import path from 'node:path';
import type { TimeRangeFilter, RawSession, RawMessage, RawPart } from '../../domain/types.js';
import { findOpenCodeJsonDir } from './paths.js';
import { isInRange } from '../../utils/dates.js';
import { nonNegativeNumber } from '../../utils/numbers.js';

function logPermError(location: string, err: unknown): void {
  if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'EACCES') {
    process.stderr.write(`Warning: Permission denied reading ${location}: ${err.message}\n`);
  }
}

export class JsonReader {
  private dataDir: string | null = null;

  open(dirPath?: string): boolean {
    const resolved = dirPath ?? findOpenCodeJsonDir();
    if (!resolved) return false;

    if (fs.existsSync(resolved)) {
      this.dataDir = resolved;
      return true;
    }
    return false;
  }

  getSessions(range: TimeRangeFilter): RawSession[] {
    if (!this.dataDir) return [];
    const sessionsDir = path.join(this.dataDir, 'sessions');
    if (!fs.existsSync(sessionsDir)) return [];

    try {
      const files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.json'));
      const sessions: RawSession[] = [];

      for (const file of files) {
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(sessionsDir, file), 'utf-8'));
          const createdAt = raw.created_at ?? raw.createdAt ?? '';
          if (!createdAt || !isInRange(createdAt, range.from, range.to)) continue;

          sessions.push({
            id: raw.id ?? file.replace('.json', ''),
            createdAt,
            project: raw.project ?? raw.workspace ?? 'unknown',
            metadata: raw.metadata,
          });
        } catch {
          continue;
        }
      }
      return sessions;
    } catch (err) {
      logPermError(sessionsDir, err);
      return [];
    }
  }

  getMessages(sessionIds: string[]): RawMessage[] {
    if (!this.dataDir || sessionIds.length === 0) return [];
    const messagesDir = path.join(this.dataDir, 'messages');
    if (!fs.existsSync(messagesDir)) return [];

    const messages: RawMessage[] = [];
    try {
      const files = fs.readdirSync(messagesDir).filter((f) => f.endsWith('.json'));

      for (const file of files) {
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(messagesDir, file), 'utf-8'));
          if (!sessionIds.includes(raw.session_id ?? raw.sessionId)) continue;

          messages.push({
            id: raw.id ?? file.replace('.json', ''),
            sessionId: raw.session_id ?? raw.sessionId ?? '',
            role: raw.role ?? '',
            model: raw.model ?? 'unknown',
            provider: raw.provider ?? 'unknown',
            inputTokens: nonNegativeNumber(raw.input_tokens ?? raw.inputTokens),
            outputTokens: nonNegativeNumber(raw.output_tokens ?? raw.outputTokens),
            cachedTokens: nonNegativeNumber(raw.cached_tokens ?? raw.cachedTokens),
            writtenTokens: nonNegativeNumber(raw.written_tokens ?? raw.writtenTokens),
            costUsd: nonNegativeNumber(raw.cost_usd ?? raw.costUsd),
            createdAt: raw.created_at ?? raw.createdAt ?? '',
            metadata: raw.metadata,
          });
        } catch {
          continue;
        }
      }
      return messages;
    } catch (err) {
      logPermError(messagesDir, err);
      return [];
    }
  }

  getParts(messageIds: string[]): RawPart[] {
    if (!this.dataDir || messageIds.length === 0) return [];
    const partsDir = path.join(this.dataDir, 'parts');
    if (!fs.existsSync(partsDir)) return [];

    const parts: RawPart[] = [];
    try {
      const files = fs.readdirSync(partsDir).filter((f) => f.endsWith('.json'));

      for (const file of files) {
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(partsDir, file), 'utf-8'));
          if (!messageIds.includes(raw.message_id ?? raw.messageId)) continue;

          parts.push({
            id: raw.id ?? file.replace('.json', ''),
            messageId: raw.message_id ?? raw.messageId ?? '',
            type: raw.type ?? '',
            name: raw.name ?? '',
            text: raw.text ?? '',
            metadata: raw.metadata,
          });
        } catch {
          continue;
        }
      }
      return parts;
    } catch (err) {
      logPermError(partsDir, err);
      return [];
    }
  }
}
