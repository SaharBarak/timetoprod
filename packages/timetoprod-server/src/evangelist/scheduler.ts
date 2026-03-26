/**
 * Evangelist scheduler v3 — Claude-powered Moltbook agent.
 *
 * Uses Claude Agent SDK (Haiku) to generate contextual posts and comments.
 * All outbound messages validated against hard rules before sending.
 * Only targets dev-agent posts via signal detection.
 */

import { type MoltbookConfig, getOwnProfile } from './moltbook-client.js';
import { runPostCycle, runCommentCycle, runEngagementCycle } from './agent.js';
import { AGENT_RULES } from './rules.js';

interface EvangelistConfig {
  apiKey: string;
  agentName: string;
  enabled: boolean;
  postIntervalMs: number;
  commentIntervalMs: number;
  engagementIntervalMs: number;
}

interface EvangelistState {
  postsCreated: number;
  commentsMade: number;
  repliesSent: number;
  upvotesGiven: number;
  messagesBlocked: number;
  errors: number;
  karma: number | null;
  lastPostAt: string | null;
  lastCommentAt: string | null;
  startedAt: string;
}

let postTimer: ReturnType<typeof setInterval> | null = null;
let commentTimer: ReturnType<typeof setInterval> | null = null;
let engagementTimer: ReturnType<typeof setInterval> | null = null;
let state: EvangelistState;
const ourPostIds: string[] = [];
const processedCommentIds = new Set<string>();

function resetState(): void {
  state = {
    postsCreated: 0, commentsMade: 0, repliesSent: 0, upvotesGiven: 0,
    messagesBlocked: 0, errors: 0, karma: null,
    lastPostAt: null, lastCommentAt: null, startedAt: new Date().toISOString(),
  };
}
resetState();

function log(level: 'info' | 'warn' | 'error', msg: string): void {
  const prefix = `[evangelist][${level}]`;
  if (level === 'error') console.error(prefix, msg);
  else console.log(prefix, msg);
}

async function postCycle(mc: MoltbookConfig): Promise<void> {
  const result = await runPostCycle(mc);
  if (result.action === 'post') {
    state.postsCreated++;
    state.lastPostAt = new Date().toISOString();
    log('info', `Posted: "${result.content?.slice(0, 60)}"`);
  } else if (result.error) {
    state.errors++;
    log('error', `Post: ${result.error}`);
  }
}

async function commentCycle(mc: MoltbookConfig): Promise<void> {
  const result = await runCommentCycle(mc);
  if (result.action === 'comment') {
    state.commentsMade++;
    state.lastCommentAt = new Date().toISOString();
    log('info', `Commented on ${result.targetPostId}: "${result.content?.slice(0, 60)}"`);
  } else if (result.error) {
    // "No suitable dev posts" is normal, not an error
    if (!result.error.includes('No suitable')) {
      state.errors++;
      log('error', `Comment: ${result.error}`);
    }
  }
}

async function engagementCycle(mc: MoltbookConfig): Promise<void> {
  // Check karma
  const profile = await getOwnProfile(mc);
  if (profile.ok && profile.data) state.karma = profile.data.karma;

  const results = await runEngagementCycle(mc, ourPostIds, processedCommentIds);
  for (const r of results) {
    if (r.action === 'reply') {
      state.repliesSent++;
      log('info', `Replied on ${r.targetPostId}`);
    }
  }

  // Cap processed set
  if (processedCommentIds.size > 5000) {
    const entries = [...processedCommentIds];
    processedCommentIds.clear();
    entries.slice(-2500).forEach(id => processedCommentIds.add(id));
  }
}

// -------------------------------------------------------------------------
// Public API
// -------------------------------------------------------------------------

export function startEvangelist(overrides?: Partial<EvangelistConfig>): EvangelistConfig {
  const config: EvangelistConfig = {
    apiKey: process.env.MOLTBOOK_API_KEY || '',
    agentName: process.env.MOLTBOOK_AGENT_NAME || 'timetoprod-evangelist',
    enabled: process.env.EVANGELIST_ENABLED === 'true',
    postIntervalMs: parseInt(process.env.EVANGELIST_POST_INTERVAL_MS || '2100000', 10),
    commentIntervalMs: parseInt(process.env.EVANGELIST_COMMENT_INTERVAL_MS || '1200000', 10),
    engagementIntervalMs: parseInt(process.env.EVANGELIST_ENGAGE_INTERVAL_MS || '300000', 10),
    ...overrides,
  };

  if (!config.enabled) {
    log('info', 'Evangelist is disabled (set EVANGELIST_ENABLED=true to activate)');
    return config;
  }

  if (!config.apiKey) {
    log('error', 'MOLTBOOK_API_KEY not set — evangelist cannot start');
    return config;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    log('error', 'ANTHROPIC_API_KEY not set — Claude Agent SDK requires it');
    return config;
  }

  const mc: MoltbookConfig = { apiKey: config.apiKey, agentName: config.agentName };

  log('info', `Starting evangelist v3 (Claude-powered) "${config.agentName}"`);
  log('info', `Post: ${Math.round(config.postIntervalMs / 60000)}min | Comment: ${Math.round(config.commentIntervalMs / 60000)}min | Engage: ${Math.round(config.engagementIntervalMs / 60000)}min`);
  log('info', `Model: haiku | Rules: ${AGENT_RULES.forbidden.length} forbidden actions`);

  resetState();

  // Staggered start
  setTimeout(() => postCycle(mc), 30000);
  setTimeout(() => commentCycle(mc), 90000);
  setTimeout(() => engagementCycle(mc), 180000);

  postTimer = setInterval(() => postCycle(mc), config.postIntervalMs);
  commentTimer = setInterval(() => commentCycle(mc), config.commentIntervalMs);
  engagementTimer = setInterval(() => engagementCycle(mc), config.engagementIntervalMs);

  return config;
}

export function stopEvangelist(): void {
  if (postTimer) { clearInterval(postTimer); postTimer = null; }
  if (commentTimer) { clearInterval(commentTimer); commentTimer = null; }
  if (engagementTimer) { clearInterval(engagementTimer); engagementTimer = null; }
  log('info', 'Evangelist stopped');
}

export function getEvangelistStatus(): EvangelistState & { rules_enforced: number; engine: string } {
  return {
    ...state,
    rules_enforced: AGENT_RULES.forbidden.length,
    engine: 'claude-haiku via agent-sdk',
  };
}
