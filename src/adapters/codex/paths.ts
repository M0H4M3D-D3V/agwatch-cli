import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AgentConfig } from '../../config/agents.js';
import { resolveAgentPaths } from '../../config/agents.js';

const CODEX_SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');

function collectJsonlFiles(entryPath: string, out: string[]): void {
  try {
    const stat = fs.statSync(entryPath);
    if (stat.isFile()) {
      if (entryPath.endsWith('.jsonl')) out.push(entryPath);
      return;
    }

    if (!stat.isDirectory()) return;
    for (const name of fs.readdirSync(entryPath)) {
      collectJsonlFiles(path.join(entryPath, name), out);
    }
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'EACCES') {
      process.stderr.write(`Warning: Permission denied reading ${entryPath}: ${err.message}\n`);
    }
  }
}

export function resolveCodexPaths(agentConfig?: AgentConfig): string[] {
  const roots = agentConfig ? resolveAgentPaths(agentConfig) : (fs.existsSync(CODEX_SESSIONS_DIR) ? [CODEX_SESSIONS_DIR] : []);
  const files: string[] = [];
  for (const root of roots) collectJsonlFiles(root, files);
  return files;
}

export function filePathToSessionId(filePath: string): string {
  return path.basename(filePath).replace(/\.jsonl$/i, '');
}
