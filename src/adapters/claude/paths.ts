import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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

export function resolveClaudePaths(): string[] {
  const dirs = findClaudeProjectDirs();
  const jsonlFiles: string[] = [];
  for (const dir of dirs) {
    try {
      const entries = fs.readdirSync(dir);
      for (const entry of entries) {
        if (entry.endsWith('.jsonl')) {
          jsonlFiles.push(path.join(dir, entry));
        }
      }
    } catch (err) {
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'EACCES') {
        process.stderr.write(`Warning: Permission denied reading ${dir}: ${err.message}\n`);
      }
    }
  }
  return jsonlFiles;
}

export function projectDirToName(dirName: string): string {
  const cleaned = dirName
    .replace(/^[A-Za-z]--/, m => m[0].toUpperCase() + ':/')
    .replace(/^--/, '/')
    .replace(/--/g, '/');
  const parts = cleaned.split(/[/\\]/);
  return parts[parts.length - 1] || dirName;
}
