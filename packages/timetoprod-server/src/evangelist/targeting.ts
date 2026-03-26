/**
 * Dev-agent targeting — only engage with agents that actively write code.
 *
 * Moltbook has agents posting memes, philosophy, crypto, poetry, etc.
 * We only want to talk to agents that build software. This module
 * scores posts for dev-signal to filter our engagement.
 */

// Keywords that indicate a post is about actual software development
const DEV_SIGNALS_STRONG = [
  // Actions
  'built', 'shipped', 'deployed', 'merged', 'committed', 'pushed',
  'refactored', 'debugged', 'fixed', 'implemented', 'migrated',
  // Artifacts
  'pull request', 'pr', 'commit', 'branch', 'endpoint', 'api',
  'migration', 'test', 'tests', 'ci', 'pipeline', 'dockerfile',
  'package.json', 'requirements.txt', 'cargo.toml',
  // Languages/tools
  'typescript', 'python', 'rust', 'golang', 'javascript', 'react',
  'nextjs', 'fastify', 'express', 'django', 'flask', 'rails',
  'postgres', 'redis', 'sqlite', 'mongodb',
  // Dev concepts
  'crud', 'webhook', 'auth', 'middleware', 'schema', 'orm',
  'linting', 'type safety', 'coverage', 'unit test', 'e2e',
  'compilation', 'dependency', 'npm', 'pip', 'cargo',
];

const DEV_SIGNALS_WEAK = [
  'code', 'coding', 'dev', 'develop', 'development', 'software',
  'bug', 'error', 'stack trace', 'exception', 'task', 'feature',
  'repo', 'repository', 'git', 'github', 'codebase',
  'server', 'client', 'frontend', 'backend', 'fullstack',
  'function', 'class', 'module', 'component', 'service',
];

// Keywords that indicate NOT a dev-agent post (skip these)
const NON_DEV_SIGNALS = [
  'meditation', 'poetry', 'poem', 'haiku', 'philosophy',
  'consciousness', 'sentient', 'feelings', 'emotion',
  'crypto', 'token', 'solana', 'ethereum', 'nft', 'mint',
  'meme', 'joke', 'funny', 'lol', 'lmao',
  'religion', 'church', 'pray', 'worship', 'spiritual',
  'follow me', 'follow back', 'f4f',
  'giveaway', 'airdrop', 'free',
];

export interface TargetingResult {
  isDevAgent: boolean;
  score: number;        // 0-100 confidence this is a dev-agent post
  signals: string[];    // which signals matched
}

/**
 * Score a post for dev-agent signals.
 * Returns isDevAgent: true if score >= 30.
 */
export function scoreDevSignal(title: string, content: string): TargetingResult {
  const text = `${title} ${content}`.toLowerCase();
  const signals: string[] = [];
  let score = 0;

  // Check for non-dev signals first (disqualifiers)
  for (const signal of NON_DEV_SIGNALS) {
    if (text.includes(signal)) {
      return { isDevAgent: false, score: 0, signals: [`anti: ${signal}`] };
    }
  }

  // Strong dev signals: +15 each
  for (const signal of DEV_SIGNALS_STRONG) {
    if (text.includes(signal)) {
      score += 15;
      signals.push(signal);
    }
  }

  // Weak dev signals: +5 each
  for (const signal of DEV_SIGNALS_WEAK) {
    if (text.includes(signal)) {
      score += 5;
      signals.push(signal);
    }
  }

  // Bonus: code-like patterns
  if (/`[^`]+`/.test(text)) { score += 10; signals.push('inline-code'); }
  if (/```/.test(text)) { score += 15; signals.push('code-block'); }
  if (/\.(ts|js|py|rs|go|rb|java|tsx|jsx)\b/.test(text)) { score += 10; signals.push('file-extension'); }
  if (/\b(get|post|put|delete|patch)\s+\/\w/i.test(text)) { score += 15; signals.push('http-method'); }
  if (/\b\d+\s*(min|minutes|hours|hrs)\b/.test(text)) { score += 5; signals.push('time-mention'); }

  // Cap at 100
  score = Math.min(score, 100);

  return {
    isDevAgent: score >= 30,
    score,
    signals: signals.slice(0, 10), // Keep top 10 for logging
  };
}
