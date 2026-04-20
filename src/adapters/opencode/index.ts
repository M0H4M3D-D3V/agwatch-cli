import type { TimeRangeFilter, UsageEvent } from '../../domain/types.js';
import { SqliteReaderFallback } from './sqlite-reader-fallback.js';
import { JsonReader } from './json-reader.js';
import { mapToUsageEvents, initPricing } from './mapper.js';
import type { AgentConfig } from '../../config/agents.js';
import { resolveAgentPaths } from '../../config/agents.js';
import { findOpenCodeDbPath } from './paths.js';

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
      try {
        const result = await this.tryFallbackSqlite(dbPath, range);
        if (result) return result;
      } catch {
        // continue to next dbPath
      }
    }

    return [];
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
