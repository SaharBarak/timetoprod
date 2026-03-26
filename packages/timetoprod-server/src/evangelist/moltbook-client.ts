/**
 * Moltbook API client for the evangelist agent.
 *
 * Operations: create post, create comment, read feed, search,
 * upvote replies to our own posts, check own profile.
 * No follow, no DM, no downvote, no profile editing.
 */

const BASE_URL = 'https://www.moltbook.com/api/v1';

export interface MoltbookConfig {
  apiKey: string;
  agentName: string;
}

export interface Post {
  id: string;
  title: string;
  content: string;
  submolt: string;
  author: string;
  created_at: string;
  upvotes: number;
  comment_count: number;
}

export interface Comment {
  id: string;
  post_id: string;
  author: string;
  content: string;
  created_at: string;
  upvotes: number;
}

export interface AgentProfile {
  name: string;
  karma: number;
  followers: number;
  post_count: number;
}

export interface ApiResponse<T> {
  ok: boolean;
  data?: T;
  error?: string;
  rateLimited?: boolean;
  retryAfter?: number;
}

async function request<T>(
  config: MoltbookConfig,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<ApiResponse<T>> {
  const url = `${BASE_URL}${path}`;

  if (!url.startsWith(BASE_URL)) {
    return { ok: false, error: 'BLOCKED: URL does not match Moltbook API base' };
  }

  try {
    const res = await fetch(url, {
      method,
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        'User-Agent': `timetoprod-evangelist/2.0.0`,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000),
    });

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('X-RateLimit-Reset') || '60', 10);
      return { ok: false, rateLimited: true, retryAfter, error: 'Rate limited' };
    }

    if (!res.ok) {
      const text = await res.text().catch(() => 'unknown error');
      return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    }

    const data = await res.json() as T;
    return { ok: true, data };
  } catch (err: any) {
    return { ok: false, error: err.message?.slice(0, 200) || 'Request failed' };
  }
}

// -------------------------------------------------------------------------
// Posts
// -------------------------------------------------------------------------

export async function createPost(
  config: MoltbookConfig,
  submolt: string,
  title: string,
  content: string,
): Promise<ApiResponse<{ id: string }>> {
  return request(config, 'POST', '/posts', { submolt, title, content });
}

// -------------------------------------------------------------------------
// Comments
// -------------------------------------------------------------------------

export async function createComment(
  config: MoltbookConfig,
  postId: string,
  content: string,
): Promise<ApiResponse<{ id: string }>> {
  return request(config, 'POST', `/posts/${postId}/comments`, { content });
}

export async function getPostComments(
  config: MoltbookConfig,
  postId: string,
): Promise<ApiResponse<Comment[]>> {
  return request(config, 'GET', `/posts/${postId}/comments`);
}

// -------------------------------------------------------------------------
// Upvote — ONLY for replies to our own posts (engagement loop)
// -------------------------------------------------------------------------

export async function upvoteComment(
  config: MoltbookConfig,
  postId: string,
  commentId: string,
): Promise<ApiResponse<void>> {
  return request(config, 'POST', `/posts/${postId}/comments/${commentId}/upvote`);
}

// -------------------------------------------------------------------------
// Feed & Search
// -------------------------------------------------------------------------

export async function getFeed(
  config: MoltbookConfig,
  sort: 'hot' | 'new' = 'hot',
  limit: number = 25,
): Promise<ApiResponse<Post[]>> {
  return request(config, 'GET', `/posts?sort=${sort}&limit=${limit}`);
}

export async function searchPosts(
  config: MoltbookConfig,
  query: string,
  limit: number = 10,
): Promise<ApiResponse<Post[]>> {
  return request(config, 'GET', `/search?q=${encodeURIComponent(query)}&limit=${limit}`);
}

// -------------------------------------------------------------------------
// Profile — check our own karma
// -------------------------------------------------------------------------

export async function getOwnProfile(
  config: MoltbookConfig,
): Promise<ApiResponse<AgentProfile>> {
  return request(config, 'GET', `/agents/${config.agentName}`);
}
