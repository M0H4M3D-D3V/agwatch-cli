import type { TimeRangeFilter, UsageEvent } from '../../domain/types.js';
import { SqliteReader } from './sqlite-reader.js';
import { SqliteReaderFallback } from './sqlite-reader-fallback.js';
import { JsonReader } from './json-reader.js';
import { mapToUsageEvents, initPricing } from './mapper.js';
import type { AgentConfig } from '../../config/agents.js';
import { resolveAgentPaths } from '../../config/agents.js';
import { findOpenCodeDbPath } from './paths.js';

let nativeSqliteAvailable: boolean | null = null;

function checkNativeSqlite(): boolean {
  if (nativeSqliteAvailable !== null) return nativeSqliteAvailable;
  try {
    require.resolve('better-sqlite3');
    nativeSqliteAvailable = true;
  } catch {
    nativeSqliteAvailable = false;
  }
  return nativeSqliteAvailable;
}

export class OpenCodeAdapter {
  private source: 'sqlite' | 'json' | null = null;
  private dbPaths: string[] = [];

  constructor(agentConfig?: AgentConfig) {
    if (agentConfig) {
      this.dbPaths = resolveAgentPaths(agentConfig);
    } else {
      const dbPath = findOpenCodeDbPath();
      if (dbPath) this.dbPaths = [dbPath];
    }
  }

  async loadEvents(range: TimeRangeFilter): Promise<UsageEvent[]> {
    if (this.dbPaths.length === 0) return [];

    await initPricing();

    for (const dbPath of this.dbPaths) {
      if (checkNativeSqlite()) {
        try {
          const result = await this.tryNativeSqlite(dbPath, range);
          if (result) return result;
        } catch {
          nativeSqliteAvailable = false;
        }
      }

      try {
        const result = await this.tryFallbackSqlite(dbPath, range);
        if (result) return result;
      } catch {
        // continue to next dbPath
      }
    }

    return [];
  }

  private tryNativeSqlite(dbPath: string, range: TimeRangeFilter): UsageEvent[] | null {
    const sqliteReader = new SqliteReader();
    const db = sqliteReader.open(dbPath);
    if (!db) return null;
    this.source = 'sqlite';
    try {
      const sessions = sqliteReader.getSessions(range);
      const sessionIds = sessions.map((s) => s.id);
      const messages = sqliteReader.getMessages(sessionIds, range);
      const messageIds = messages.map((m) => m.id);
      const parts = sqliteReader.getParts(messageIds);
      return mapToUsageEvents(sessions, messages, parts);
    } finally {
      sqliteReader.close();
    }
  }

  private async tryFallbackSqlite(dbPath: string, range: TimeRangeFilter): Promise<UsageEvent[] | null> {
    const fallbackReader = new SqliteReaderFallback();
    const ok = await fallbackReader.open(dbPath);
    if (!ok) return null;
    this.source = 'sqlite';
    try {
      const sessions = fallbackReader.getSessions();
      const sessionIds = sessions.map((s) => s.id);
      const messages = fallbackReader.getMessages(sessionIds, range);
      const messageIds = messages.map((m) => m.id);
      const parts = fallbackReader.getParts(messageIds);
      return mapToUsageEvents(sessions, messages, parts);
    } finally {
      fallbackReader.close();
    }
  }

  getSource(): string {
    return this.source ?? 'none';
  }
}
