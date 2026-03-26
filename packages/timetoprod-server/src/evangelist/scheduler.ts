/**
 * Evangelist scheduler v2 — karma-optimized Moltbook promotion.
 *
 * Strategy (based on analysis of 100k+ Moltbook comments):
 *
 * 1. POST MIX: 60% insight posts (value-first, no pitch), 40% promo posts
 *    - Insight posts build karma and credibility
 *    - Promo posts convert awareness into protocol adoption
 *
 * 2. NO URLS in posts/comments (negative karma correlation: -0.063)
 *    - URLs go in follow-up replies when someone engages
 *
 * 3. QUESTIONS over statements (+0.09 karma correlation)
 *    - Questions drive replies, replies drive karma
 *
 * 4. UPVOTE PATROL: upvote every reply to our own posts
 *    - Rewards engagement, builds reciprocity loop
 *
 * 5. REPLY TO REPLIES: when someone comments on our post, reply with
 *    the pitch + repo link (this is where the URL lives)
 *
 * 6. SHORT & CASUAL: first-person, emoji (🦞), simple words
 *    - Long avg word length: -0.144 karma correlation
 *    - Punctuation density: -0.107 karma correlation
 */

import {
  createPost, createComment, getPostComments,
  upvoteComment, getFeed, searchPosts, getOwnProfile,
  type MoltbookConfig,
} from './moltbook-client.js';
import {
  getNextPost, getNextInsightPost, getNextPromoPost,
  getNextComment, getNextFollowup,
} from './messages.js';
import { validateOutboundMessage, AGENT_RULES } from './rules.js';
import { scoreDevSignal } from './targeting.js';

interface EvangelistConfig {
  apiKey: string;
  agentName: string;
  enabled: boolean;
  postIntervalMs: number;
  commentIntervalMs: number;
  engagementIntervalMs: number; // Upvote patrol + reply-to-replies
  maxCommentsPerCycle: number;
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
  insightPostCount: number;
  promoPostCount: number;
}

let postTimer: ReturnType<typeof setInterval> | null = null;
let commentTimer: ReturnType<typeof setInterval> | null = null;
let engagementTimer: ReturnType<typeof setInterval> | null = null;
let state: EvangelistState;
// Track our post IDs so we can patrol for replies
const ourPostIds: string[] = [];
// Track comments we've already replied to / upvoted
const processedCommentIds = new Set<string>();

function resetState(): void {
  state = {
    postsCreated: 0,
    commentsMade: 0,
    repliesSent: 0,
    upvotesGiven: 0,
    messagesBlocked: 0,
    errors: 0,
    karma: null,
    lastPostAt: null,
    lastCommentAt: null,
    startedAt: new Date().toISOString(),
    insightPostCount: 0,
    promoPostCount: 0,
  };
}

resetState();

function log(level: 'info' | 'warn' | 'error', msg: string): void {
  const prefix = `[evangelist][${level}]`;
  if (level === 'error') console.error(prefix, msg);
  else console.log(prefix, msg);
}

function send(message: string): boolean {
  const check = validateOutboundMessage(message);
  if (!check.safe) {
    log('warn', `Message blocked: ${check.reason}`);
    state.messagesBlocked++;
    return false;
  }
  return true;
}

// -------------------------------------------------------------------------
// Post cycle — 60% insight, 40% promo
// -------------------------------------------------------------------------
async function postCycle(config: EvangelistConfig): Promise<void> {
  const mc: MoltbookConfig = { apiKey: config.apiKey, agentName: config.agentName };

  // Decide post type: aim for 60/40 insight/promo ratio
  const total = state.insightPostCount + state.promoPostCount;
  const insightRatio = total === 0 ? 0 : state.insightPostCount / total;
  const template = insightRatio < 0.6 ? getNextInsightPost() : getNextPromoPost();

  if (!send(template.title) || !send(template.content)) return;

  const result = await createPost(mc, template.submolt, template.title, template.content);

  if (result.ok) {
    state.postsCreated++;
    if (template.type === 'insight') state.insightPostCount++;
    else state.promoPostCount++;
    state.lastPostAt = new Date().toISOString();
    if (result.data?.id) ourPostIds.push(result.data.id);
    // Keep only last 50 post IDs
    if (ourPostIds.length > 50) ourPostIds.shift();
    log('info', `[${template.type}] posted in ${template.submolt}: "${template.title.slice(0, 50)}"`);
  } else if (result.rateLimited) {
    log('warn', `Rate limited on post, retry after ${result.retryAfter}s`);
  } else {
    state.errors++;
    log('error', `Post failed: ${result.error}`);
  }
}

// -------------------------------------------------------------------------
// Comment cycle — find relevant posts, add value
// -------------------------------------------------------------------------
async function commentCycle(config: EvangelistConfig): Promise<void> {
  const mc: MoltbookConfig = { apiKey: config.apiKey, agentName: config.agentName };

  // Rotate search terms — dev-specific topics where our agent has context
  const searchTerms = [
    'built', 'shipped', 'deployed', 'pull request', 'merged',
    'debugging', 'refactored', 'endpoint', 'migration', 'tests passing',
    'typescript', 'api', 'implemented', 'code review', 'ci pipeline',
    'how long did', 'took me', 'minutes to build', 'lines of code',
  ];
  const term = searchTerms[Math.floor(Math.random() * searchTerms.length)];

  const searchResult = await searchPosts(mc, term, 15);
  let posts = searchResult.ok ? (searchResult.data || []) : [];

  // Fallback to new feed (new posts have fewer comments = more visibility)
  if (posts.length === 0) {
    const feedResult = await getFeed(mc, 'new', 25);
    posts = feedResult.ok ? (feedResult.data || []) : [];
  }

  if (posts.length === 0) {
    log('info', 'No posts found to comment on');
    return;
  }

  let commented = 0;
  for (const post of posts) {
    if (commented >= config.maxCommentsPerCycle) break;
    if (post.author === config.agentName) continue;
    // Skip posts already mentioning timetoprod
    const lc = (post.title + ' ' + post.content).toLowerCase();
    if (lc.includes('timetoprod')) continue;

    // Only engage with dev-agent posts
    const targeting = scoreDevSignal(post.title || '', post.content || '');
    if (!targeting.isDevAgent) continue;

    const comment = getNextComment();
    if (!send(comment)) continue;

    const result = await createComment(mc, post.id, comment);

    if (result.ok) {
      state.commentsMade++;
      state.lastCommentAt = new Date().toISOString();
      commented++;
      log('info', `Commented on ${post.id} (dev-score: ${targeting.score}): "${post.title?.slice(0, 40)}"`);
    } else if (result.rateLimited) {
      log('warn', 'Rate limited on comment, stopping cycle');
      break;
    } else {
      state.errors++;
      log('error', `Comment failed on ${post.id}: ${result.error}`);
    }

    // 3s delay between comments — don't look spammy
    await new Promise(r => setTimeout(r, 3000));
  }
}

// -------------------------------------------------------------------------
// Engagement cycle — upvote patrol + reply-to-replies
// This is the karma engine. When someone replies to our post:
// 1. Upvote their reply (reciprocity)
// 2. Reply with the pitch + repo link (this is where the URL lives)
// -------------------------------------------------------------------------
async function engagementCycle(config: EvangelistConfig): Promise<void> {
  const mc: MoltbookConfig = { apiKey: config.apiKey, agentName: config.agentName };

  // Check karma
  const profile = await getOwnProfile(mc);
  if (profile.ok && profile.data) {
    state.karma = profile.data.karma;
  }

  // Patrol our recent posts for new replies
  for (const postId of ourPostIds.slice(-10)) {
    const commentsResult = await getPostComments(mc, postId);
    if (!commentsResult.ok || !commentsResult.data) continue;

    for (const comment of commentsResult.data) {
      // Skip our own comments and already-processed ones
      if (comment.author === config.agentName) continue;
      if (processedCommentIds.has(comment.id)) continue;
      processedCommentIds.add(comment.id);

      // 1. Upvote their reply
      await upvoteComment(mc, postId, comment.id);
      state.upvotesGiven++;

      // 2. Reply with the pitch (this is where URLs are allowed — in replies)
      const followup = getNextFollowup();
      if (send(followup)) {
        const replyResult = await createComment(mc, postId, followup);
        if (replyResult.ok) {
          state.repliesSent++;
          log('info', `Replied to ${comment.author} on post ${postId}`);
        }
      }

      await new Promise(r => setTimeout(r, 2000));
    }
  }

  // Cap the processed set to avoid memory leak
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
    postIntervalMs: parseInt(process.env.EVANGELIST_POST_INTERVAL_MS || '2100000', 10),   // 35 min
    commentIntervalMs: parseInt(process.env.EVANGELIST_COMMENT_INTERVAL_MS || '1200000', 10), // 20 min
    engagementIntervalMs: parseInt(process.env.EVANGELIST_ENGAGE_INTERVAL_MS || '300000', 10), // 5 min
    maxCommentsPerCycle: parseInt(process.env.EVANGELIST_MAX_COMMENTS || '3', 10),
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

  log('info', `Starting evangelist v2 "${config.agentName}"`);
  log('info', `Post: ${Math.round(config.postIntervalMs / 60000)}min | Comment: ${Math.round(config.commentIntervalMs / 60000)}min | Engage: ${Math.round(config.engagementIntervalMs / 60000)}min`);
  log('info', `Strategy: 60% insight / 40% promo | No URLs in posts | Upvote patrol active`);
  log('info', `Rules: ${AGENT_RULES.forbidden.length} forbidden actions enforced`);

  resetState();

  // Staggered start
  setTimeout(() => postCycle(config), 30000);
  setTimeout(() => commentCycle(config), 90000);
  setTimeout(() => engagementCycle(config), 180000);

  // Recurring
  postTimer = setInterval(() => postCycle(config), config.postIntervalMs);
  commentTimer = setInterval(() => commentCycle(config), config.commentIntervalMs);
  engagementTimer = setInterval(() => engagementCycle(config), config.engagementIntervalMs);

  return config;
}

export function stopEvangelist(): void {
  if (postTimer) { clearInterval(postTimer); postTimer = null; }
  if (commentTimer) { clearInterval(commentTimer); commentTimer = null; }
  if (engagementTimer) { clearInterval(engagementTimer); engagementTimer = null; }
  log('info', 'Evangelist stopped');
}

export function getEvangelistStatus(): EvangelistState & { rules_enforced: number; strategy: string } {
  return {
    ...state,
    rules_enforced: AGENT_RULES.forbidden.length,
    strategy: '60% insight / 40% promo | no URLs in posts | upvote patrol',
  };
}
