import type { UsageEvent } from './types.js';

const ACTIVITY_KEYWORDS: [string, string[]][] = [
  ['Debugging', ['debug', 'fix', 'bug', 'error', 'issue', 'broken', 'crash', 'traceback', 'stack trace', 'not working', 'fails', 'failing']],
  ['Testing', ['test', 'spec', 'vitest', 'jest', 'mocha', 'pytest', 'unittest', 'coverage', 'assert']],
  ['Git Ops', ['git ', 'commit', 'push', 'pull', 'merge', 'branch', 'rebase', 'checkout', 'stash']],
  ['Build/Deploy', ['build', 'deploy', 'docker', 'npm run', 'cargo build', 'compile', 'bundle', 'webpack', 'vite']],
  ['Refactoring', ['refactor', 'rename', 'reorganize', 'cleanup', 'clean up', 'simplify', 'extract', 'move']],
  ['Exploration', ['explore', 'search', 'find', 'list', 'show', 'cat ', 'read ', 'what is', 'how does', 'where is', 'explain']],
  ['Feature Dev', ['implement', 'add ', 'create ', 'new feature', 'new function', 'new module', 'new component']],
  ['Coding', ['write', 'update', 'change', 'modify', 'edit', 'implement', 'code']],
  ['Planning', ['plan', 'design', 'architect', 'structure', 'organize', 'roadmap', 'todo']],
  ['Brainstorming', ['idea', 'suggest', 'brainstorm', 'think', 'consider', 'option', 'alternative', 'approach']],
  ['Conversation', ['hello', 'help', 'thank', 'please', 'can you', 'could you', 'would you']],
];

export function classifyActivity(event: UsageEvent): string {
  const toolName = event.toolName?.toLowerCase() ?? '';
  const shellCmd = event.shellCommand?.toLowerCase() ?? '';

  if (shellCmd === 'git') return 'Git Ops';
  if (shellCmd === 'docker' || shellCmd === 'docker-compose') return 'Build/Deploy';
  if (shellCmd === 'npm' || shellCmd === 'yarn' || shellCmd === 'pnpm') return 'Build/Deploy';
  if (shellCmd === 'pytest' || shellCmd === 'vitest' || shellCmd === 'jest') return 'Testing';
  if (toolName === 'grep' || toolName === 'search') return 'Exploration';

  const text = `${toolName} ${shellCmd}`.toLowerCase();
  for (const [activity, keywords] of ACTIVITY_KEYWORDS) {
    for (const keyword of keywords) {
      if (text.includes(keyword)) return activity;
    }
  }

  return 'General';
}

export function classifyEvents(events: UsageEvent[]): UsageEvent[] {
  return events.map((event) => ({
    ...event,
    activity: classifyActivity(event),
  }));
}
