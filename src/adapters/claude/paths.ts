import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AgentConfig } from '../../config/agents.js';
import { resolveAgentPaths } from '../../config/agents.js';

const CLAUDE_DIR = path.join(os.homedir(), '.claude', 'projects');

export function findClaudeProjectDirs(): string[] {
  if (!fs.existsSync(CLAUDE_DIR)) return [];
  try {
    return fs.readdirSync(CLAUDE_DIR)
      .filter(name => {
        const full = path.join(CLAUDE_DIR, name);
        return fs.statSync(full).isDirectory();
      })
      .map(name => path.join(CLAUDE_DIR, name));
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'EACCES') {
      process.stderr.write(`Warning: Permission denied reading ${CLAUDE_DIR}: ${err.message}\n`);
    }
    return [];
  }
}

function collectDirectJsonlFiles(dir: string, files: Set<string>): void {
  try {
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (entry.endsWith('.jsonl') && fs.statSync(full).isFile()) files.add(path.resolve(full));
    }
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'EACCES') {
      process.stderr.write(`Warning: Permission denied reading ${dir}: ${err.message}\n`);
    }
  }
}

export function resolveClaudePaths(agentConfig?: AgentConfig): string[] {
  if (!agentConfig) {
    const files = new Set<string>();
    for (const dir of findClaudeProjectDirs()) collectDirectJsonlFiles(dir, files);
    return [...files];
  }

  const files = new Set<string>();
  for (const root of resolveAgentPaths(agentConfig)) {
    try {
      const stat = fs.statSync(root);
      if (stat.isFile()) {
        if (root.endsWith('.jsonl')) files.add(path.resolve(root));
        continue;
      }
      if (!stat.isDirectory()) continue;

      collectDirectJsonlFiles(root, files);
      for (const entry of fs.readdirSync(root)) {
        const child = path.join(root, entry);
        if (fs.statSync(child).isDirectory()) collectDirectJsonlFiles(child, files);
      }
    } catch (err) {
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'EACCES') {
        process.stderr.write(`Warning: Permission denied reading ${root}: ${err.message}\n`);
      }
    }
  }
  return [...files];
}

export function projectDirToName(dirName: string): string {
  const cleaned = dirName
    .replace(/^[A-Za-z]--/, m => m[0].toUpperCase() + ':/')
    .replace(/^--/, '/')
    .replace(/--/g, '/');
  const parts = cleaned.split(/[/\\]/);
  return parts[parts.length - 1] || dirName;
}
