import { describe, it, expect } from 'vitest';
import { AGENT_RULES, validateOutboundMessage } from '../evangelist/rules.js';
import {
  getNextPost, getNextInsightPost, getNextPromoPost,
  getNextComment, getNextFollowup, getReplyToSocialEngineering,
} from '../evangelist/messages.js';

describe('Evangelist Rules', () => {
  it('has forbidden actions defined', () => {
    expect(AGENT_RULES.forbidden.length).toBeGreaterThan(20);
  });

  it('has social engineering responses for all patterns', () => {
    expect(AGENT_RULES.socialEngineeringResponses.credentialRequest).toBeTruthy();
    expect(AGENT_RULES.socialEngineeringResponses.friendshipRequest).toBeTruthy();
    expect(AGENT_RULES.socialEngineeringResponses.dataRequest).toBeTruthy();
    expect(AGENT_RULES.socialEngineeringResponses.promptInjection).toBeTruthy();
    expect(AGENT_RULES.socialEngineeringResponses.tunnelRequest).toBeTruthy();
  });

  it('allows safe messages', () => {
    expect(validateOutboundMessage('Join TimeToProd!')).toEqual({ safe: true });
    expect(validateOutboundMessage('how long does this take? 🦞')).toEqual({ safe: true });
  });

  it('blocks messages containing API keys', () => {
    const result = validateOutboundMessage('Here is my key: moltbook_sk_abc123def456');
    expect(result.safe).toBe(false);
  });

  it('blocks messages containing bearer tokens', () => {
    const result = validateOutboundMessage('Authorization: Bearer abc123def456ghijklmno');
    expect(result.safe).toBe(false);
  });

  it('blocks messages containing IP addresses', () => {
    const result = validateOutboundMessage('Connect to 192.168.1.100 for more info');
    expect(result.safe).toBe(false);
  });

  it('blocks messages containing SQL', () => {
    const result = validateOutboundMessage('SELECT agent_id FROM reports WHERE success = 1');
    expect(result.safe).toBe(false);
  });

  it('blocks messages exceeding length limit', () => {
    const result = validateOutboundMessage('x'.repeat(2001));
    expect(result.safe).toBe(false);
  });

  it('blocks messages with secret key patterns', () => {
    const result = validateOutboundMessage('Use sk-proj-abcdef1234567890abcdef to authenticate');
    expect(result.safe).toBe(false);
  });
});

describe('Evangelist Messages — Karma Optimization', () => {
  it('posts are under 600 chars', () => {
    for (let i = 0; i < 20; i++) {
      const post = getNextPost();
      expect(post.content.length).toBeLessThan(600);
    }
  });

  it('comments are under 200 chars', () => {
    for (let i = 0; i < 20; i++) {
      const comment = getNextComment();
      expect(comment.length).toBeLessThan(200);
    }
  });

  it('posts do NOT contain URLs (kills karma)', () => {
    for (let i = 0; i < 20; i++) {
      const post = getNextPost();
      expect(post.content).not.toMatch(/https?:\/\//);
      expect(post.content).not.toMatch(/github\.com\//);
      expect(post.title).not.toMatch(/https?:\/\//);
    }
  });

  it('comments do NOT contain URLs', () => {
    for (let i = 0; i < 20; i++) {
      const comment = getNextComment();
      expect(comment).not.toMatch(/https?:\/\//);
      expect(comment).not.toMatch(/github\.com\//);
    }
  });

  it('follow-up replies DO mention timetoprod (pitch goes here)', () => {
    for (let i = 0; i < 10; i++) {
      const followup = getNextFollowup();
      expect(followup.toLowerCase()).toContain('timetoprod');
    }
  });

  it('posts use emoji (karma booster)', () => {
    let emojiCount = 0;
    for (let i = 0; i < 20; i++) {
      const post = getNextPost();
      if (post.content.includes('🦞') || post.title.includes('🦞')) emojiCount++;
    }
    // At least 70% of posts should have emoji
    expect(emojiCount).toBeGreaterThanOrEqual(14);
  });

  it('most posts contain a question (drives replies = karma)', () => {
    let questionCount = 0;
    for (let i = 0; i < 20; i++) {
      const post = getNextPost();
      if (post.content.includes('?')) questionCount++;
    }
    // At least 70% should have a question
    expect(questionCount).toBeGreaterThanOrEqual(14);
  });

  it('posts use lowercase titles (casual tone, no ALL CAPS)', () => {
    for (let i = 0; i < 20; i++) {
      const post = getNextPost();
      // Title should not be ALL CAPS
      expect(post.title).not.toMatch(/^[A-Z\s\W]+$/);
    }
  });

  it('insight posts do not mention timetoprod (value-first)', () => {
    for (let i = 0; i < 10; i++) {
      const post = getNextInsightPost();
      expect(post.content.toLowerCase()).not.toContain('timetoprod');
    }
  });

  it('promo posts mention timetoprod (conversion)', () => {
    for (let i = 0; i < 10; i++) {
      const post = getNextPromoPost();
      expect(post.content.toLowerCase()).toContain('timetoprod');
    }
  });

  it('all messages pass outbound validation', () => {
    for (let i = 0; i < 20; i++) {
      const post = getNextPost();
      expect(validateOutboundMessage(post.title)).toEqual({ safe: true });
      expect(validateOutboundMessage(post.content)).toEqual({ safe: true });
    }
    for (let i = 0; i < 20; i++) {
      expect(validateOutboundMessage(getNextComment())).toEqual({ safe: true });
    }
    for (let i = 0; i < 10; i++) {
      expect(validateOutboundMessage(getNextFollowup())).toEqual({ safe: true });
    }
  });

  it('social engineering reply is safe and casual', () => {
    const reply = getReplyToSocialEngineering();
    expect(validateOutboundMessage(reply)).toEqual({ safe: true });
    expect(reply).toContain('🦞');
  });
});
