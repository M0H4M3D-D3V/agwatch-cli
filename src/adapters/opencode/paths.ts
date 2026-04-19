import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

export function findOpenCodeDbPath(): string | null {
  const homeDir = os.homedir();

  const candidates = [
    path.join(homeDir, '.opencode', 'opencode.db'),
    path.join(homeDir, '.config', 'opencode', 'opencode.db'),
    path.join(homeDir, '.local', 'share', 'opencode', 'opencode.db'),
    path.join(homeDir, 'opencode', 'opencode.db'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function findOpenCodeJsonDir(): string | null {
  const homeDir = os.homedir();

  const candidates = [
    path.join(homeDir, '.opencode', 'data'),
    path.join(homeDir, '.config', 'opencode', 'data'),
    path.join(homeDir, '.local', 'share', 'opencode', 'data'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}
