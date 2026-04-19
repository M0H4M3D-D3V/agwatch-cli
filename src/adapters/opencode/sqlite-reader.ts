import Database from 'better-sqlite3';
import type { TimeRangeFilter, RawSession, RawMessage, RawPart } from '../../domain/types.js';
import { findOpenCodeDbPath } from './paths.js';

export class SqliteReader {
  private db: Database.Database | null = null;

  open(dbPath?: string): Database.Database | null {
    const resolvedPath = dbPath ?? findOpenCodeDbPath();
    if (!resolvedPath) return null;

    try {
      this.db = new Database(resolvedPath, { readonly: true });
      return this.db;
    } catch {
      return null;
    }
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  getSessions(range?: TimeRangeFilter): RawSession[] {
    if (!this.db) return [];
    try {
      let query = `
        SELECT s.id, s.time_created, s.project_id, s.directory, s.title,
               p.name as project_name
        FROM session s
        LEFT JOIN project p ON s.project_id = p.id
      `;
      const params: (string | number)[] = [];

      if (range) {
        query += ` WHERE s.time_created >= ? AND s.time_created <= ?`;
        params.push(range.from.getTime(), range.to.getTime());
      }

      query += ` ORDER BY s.time_created DESC`;

      const sessions = this.db.prepare(query).all(...params) as Record<string, unknown>[];

      return sessions.map((row) => ({
        id: String(row.id ?? ''),
        createdAt: new Date(Number(row.time_created)).toISOString(),
        project: String(row.project_name ?? row.directory ?? 'unknown'),
        metadata: {
          directory: row.directory,
          title: row.title,
          project_id: row.project_id,
        },
      }));
    } catch {
      return [];
    }
  }

  getMessages(sessionIds: string[], range: TimeRangeFilter): RawMessage[] {
    if (!this.db || sessionIds.length === 0) return [];
    try {
      const fromMs = range.from.getTime();
      const toMs = range.to.getTime();
      const placeholders = sessionIds.map(() => '?').join(',');
      const rows = this.db.prepare(`
        SELECT id, session_id, time_created, data
        FROM message
        WHERE session_id IN (${placeholders})
          AND time_created >= ? AND time_created <= ?
        ORDER BY time_created ASC
      `).all(...sessionIds, fromMs, toMs) as { id: string; session_id: string; time_created: number; data: string }[];

      const messages: RawMessage[] = [];

      for (const row of rows) {
        try {
          const d = JSON.parse(row.data);

          if (d.role === 'assistant') {
            const tokens = d.tokens ?? {};
            const cache = tokens.cache ?? {};

            messages.push({
              id: row.id,
              sessionId: row.session_id,
              role: 'assistant',
              model: d.modelID ?? 'unknown',
              provider: d.providerID ?? 'unknown',
              inputTokens: tokens.input ?? 0,
              outputTokens: tokens.output ?? 0,
              cachedTokens: (cache.read ?? 0) + (cache.write ?? 0),
              writtenTokens: cache.write ?? 0,
              costUsd: d.cost ?? 0,
              createdAt: new Date(row.time_created).toISOString(),
              metadata: {
                agent: d.agent,
                mode: d.mode,
                reasoning: tokens.reasoning ?? 0,
                totalTokens: tokens.total ?? 0,
                cacheRead: cache.read ?? 0,
                cacheWrite: cache.write ?? 0,
              },
            });
          } else if (d.role === 'user') {
            const model = d.model ?? {};
            messages.push({
              id: row.id,
              sessionId: row.session_id,
              role: 'user',
              model: model.modelID ?? 'unknown',
              provider: model.providerID ?? 'unknown',
              inputTokens: 0,
              outputTokens: 0,
              cachedTokens: 0,
              writtenTokens: 0,
              costUsd: 0,
              createdAt: new Date(row.time_created).toISOString(),
              metadata: {
                agent: d.agent,
              },
            });
          }
        } catch {
          continue;
        }
      }

      return messages;
    } catch {
      return [];
    }
  }

  getParts(messageIds: string[]): RawPart[] {
    if (!this.db || messageIds.length === 0) return [];
    try {
      const placeholders = messageIds.map(() => '?').join(',');
      const rows = this.db.prepare(`
        SELECT id, message_id, session_id, data
        FROM part
        WHERE message_id IN (${placeholders})
      `).all(...messageIds) as { id: string; message_id: string; session_id: string; data: string }[];

      const parts: RawPart[] = [];

      for (const row of rows) {
        try {
          const d = JSON.parse(row.data);
          const partType = d.type ?? 'unknown';

          if (partType === 'tool') {
            const toolName = d.tool ?? 'unknown';
            const state = d.state ?? {};
            const input = state.input ?? {};

            parts.push({
              id: row.id,
              messageId: row.message_id,
              type: 'tool-call',
              name: toolName,
              text: typeof input.command === 'string' ? input.command : '',
              metadata: {
                status: state.status,
                callID: d.callID,
              },
            });
          } else if (partType === 'step-finish') {
            parts.push({
              id: row.id,
              messageId: row.message_id,
              type: 'step-finish',
              name: '',
              text: '',
              metadata: {
                tokens: d.tokens,
                cost: d.cost,
                reason: d.reason,
              },
            });
          }
        } catch {
          continue;
        }
      }

      return parts;
    } catch {
      return [];
    }
  }
}
