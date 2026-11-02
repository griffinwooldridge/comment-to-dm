import keywords from './keywords.json' with { type: 'json' };
import { privacyHtml } from './privacy.ts';

export interface Env {
  DB: D1Database;
  META_APP_SECRET?: string;
  IG_ACCESS_TOKEN?: string;
  WEBHOOK_VERIFY_TOKEN?: string;
  RESEND_API_KEY?: string;
  IG_ACCOUNT_ID?: string;
  ALERT_FROM?: string;
  ALERT_TO?: string;
  OWNER_NAME?: string;
  INSTAGRAM_HANDLE?: string;
  CONTACT_EMAIL?: string;
  POLICY_DATE?: string;
  GRAPH_VERSION?: string;
  GRAPH_BASE?: string;
  RESEND_BASE?: string;
}

export interface Keyword {
  keyword: string;
  message: string;
  /** Sends the message with one tappable button instead of plain text. */
  button?: { title: string; url: string };
  /** Match anywhere in the comment. Only for words people rarely use by accident. */
  loose?: boolean;
}

interface Comment {
  id: string;
  text: string;
  commenterId: string;
  mediaId: string;
  accountId: string;
}

/** Meta's rate-limit codes. These are worth retrying; a bad token or expired comment is not. */
const RETRYABLE_CODES = new Set([1, 2, 4, 17, 32, 613]);
const MAX_BODY_BYTES = 1_000_000;
const HEALTH_CRON = '0 15 * * *';
const encoder = new TextEncoder();

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Compares digests rather than strings, so the check takes the same time wherever they differ. */
async function safeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([a, b].map((v) => crypto.subtle.digest('SHA-256', encoder.encode(v))));
  return hex(x) === hex(y);
}

/** Finds what a caption asks people to comment: a quoted word, or one in capitals. */
export function captionKeywords(caption: string): string[] {
  const asks = caption.matchAll(/\b(?:[Cc]omment|COMMENT)\s+(?:["“'‘]([\p{L}\p{N}]+)["”'’]|(\p{Lu}[\p{Lu}\p{N}]+)\b)/gu);
  return [...new Set([...asks].map((ask) => (ask[1] ?? ask[2]).toLowerCase()))];
}

export async function validSignature(secret: string, body: string, header: string | null): Promise<boolean> {
  if (!header?.startsWith('sha256=')) return false;
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = 'sha256=' + hex(await crypto.subtle.sign('HMAC', key, encoder.encode(body)));
  return safeEqual(expected, header);
}

/** Case-insensitive. The comment must be only the keyword, unless the keyword is loose. */
export function matchKeyword(text: string, list: Keyword[]): Keyword | undefined {
  const words = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return list.find(({ keyword, loose }) => {
    const word = keyword.toLowerCase();
    return loose ? words.includes(word) : words.length === 1 && words[0] === word;
  });
}

/** Meta documents two shapes: changes[] with comment_id, and field/value on the entry with id. */
export function parseComments(payload: unknown): Comment[] {
  const entries = (payload as { entry?: unknown[] })?.entry;
  if (!Array.isArray(entries)) return [];
  const comments: Comment[] = [];
  for (const entry of entries as { id?: string; field?: string; value?: any; changes?: { field?: string; value?: any }[] }[]) {
    for (const change of entry.changes ?? [entry]) {
      const value = change.value;
      const id = value?.comment_id ?? value?.id;
      if (change.field !== 'comments' || !id || !value.from?.id || !value.media?.id || !entry.id) continue;
      comments.push({
        id: String(id),
        text: String(value.text ?? ''),
        commenterId: String(value.from.id),
        mediaId: String(value.media.id),
        accountId: String(entry.id),
      });
    }
  }
  return comments;
}

function graphBase(env: Env): string {
  return env.GRAPH_BASE ?? 'https://graph.facebook.com';
}

function buttonMessage(match: Keyword, button: NonNullable<Keyword['button']>) {
  return { attachment: { type: 'template', payload: { template_type: 'button', text: match.message, buttons: [{ type: 'web_url', url: button.url, title: button.title }] } } };
}

async function sendPrivateReply(env: Env, comment: Comment, message: unknown): Promise<{ ok: boolean; retry: boolean; error?: string }> {
  let res: Response;
  try {
    res = await fetch(`${graphBase(env)}/${env.GRAPH_VERSION ?? 'v26.0'}/${comment.accountId}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.IG_ACCESS_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ recipient: { comment_id: comment.id }, message }),
    });
  } catch {
    return { ok: false, retry: true, error: 'network' };
  }
  if (res.ok) return { ok: true, retry: false };
  const body = (await res.json().catch(() => ({}))) as { error?: { code?: number; error_subcode?: number } };
  const code = body.error?.code;
  return {
    ok: false,
    retry: res.status >= 500 || res.status === 429 || (code !== undefined && RETRYABLE_CODES.has(code)),
    error: `${res.status}:${code ?? '?'}:${body.error?.error_subcode ?? '?'}`,
  };
}

/** Returns false when Meta should redeliver the event. */
export async function handleComment(env: Env, comment: Comment, list: Keyword[]): Promise<boolean> {
  if (comment.commenterId === comment.accountId) return true;
  const match = matchKeyword(comment.text, list);
  if (!match) return true;

  const key = match.keyword.toLowerCase();
  const dedupeKey = `${comment.mediaId}:${comment.commenterId}:${key}`;
  const claim = await env.DB.prepare(
    `INSERT OR IGNORE INTO deliveries (dedupe_key, comment_id, media_id, commenter_id, keyword, status)
     VALUES (?1, ?2, ?3, ?4, ?5, 'sending')`,
  ).bind(dedupeKey, comment.id, comment.mediaId, comment.commenterId, key).run();
  if (!claim.meta.changes) return true;

  let result = await sendPrivateReply(env, comment, match.button ? buttonMessage(match, match.button) : { text: match.message });
  // Meta only documents text for private replies, so a rejected button falls back to a plain link.
  let sentStatus = 'sent';
  if (match.button && !result.ok && !result.retry) {
    console.error('dm_button_rejected', result.error);
    sentStatus = 'sent_link';
    result = await sendPrivateReply(env, comment, { text: `${match.message} ${match.button.url}` });
  }
  if (result.retry) {
    await env.DB.prepare('DELETE FROM deliveries WHERE dedupe_key = ?1').bind(dedupeKey).run();
    console.error('dm_retry', result.error);
    return false;
  }
  await env.DB.prepare('UPDATE deliveries SET status = ?2, error = ?3 WHERE dedupe_key = ?1')
    .bind(dedupeKey, result.ok ? sentStatus : 'failed', result.error ?? null).run();
  if (!result.ok) console.error('dm_failed', result.error);
  return true;
}

async function handleVerify(url: URL, env: Env): Promise<Response> {
  const token = url.searchParams.get('hub.verify_token') ?? '';
  const valid = Boolean(env.WEBHOOK_VERIFY_TOKEN)
    && url.searchParams.get('hub.mode') === 'subscribe'
    && await safeEqual(token, env.WEBHOOK_VERIFY_TOKEN as string);
  if (!valid) return new Response('Forbidden', { status: 403 });
  return new Response(url.searchParams.get('hub.challenge') ?? '', { headers: { 'content-type': 'text/plain' } });
}

async function handleEvent(request: Request, env: Env): Promise<Response> {
  if (!env.META_APP_SECRET || !env.IG_ACCESS_TOKEN) return new Response('Not configured', { status: 503 });
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return new Response('Too large', { status: 413 });
  const body = await request.text();
  if (!await validSignature(env.META_APP_SECRET, body, request.headers.get('x-hub-signature-256'))) {
    return new Response('Invalid signature', { status: 401 });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }
  const results = await Promise.all(parseComments(payload).map((comment) => handleComment(env, comment, keywords)));
  return new Response(results.every(Boolean) ? 'OK' : 'Retry', { status: results.every(Boolean) ? 200 : 503 });
}

async function graphGet(env: Env, path: string): Promise<{ ok: boolean; status: number; body: any }> {
  const res = await fetch(`${graphBase(env)}/${env.GRAPH_VERSION ?? 'v26.0'}/${env.IG_ACCOUNT_ID}/${path}`, {
    headers: { authorization: `Bearer ${env.IG_ACCESS_TOKEN}` },
  });
  return { ok: res.ok, status: res.status, body: await res.json().catch(() => ({})) };
}

async function sendAlert(env: Env, subject: string, lines: string[]): Promise<boolean> {
  if (!env.RESEND_API_KEY || !env.ALERT_FROM || !env.ALERT_TO) {
    console.error('alert_not_configured', subject);
    return false;
  }
  const res = await fetch(env.RESEND_BASE ?? 'https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: env.ALERT_FROM, to: env.ALERT_TO, subject, text: lines.join('\n') }),
  });
  if (!res.ok) console.error('alert_failed', res.status);
  return res.ok;
}

/** Emails once about each keyword a caption asks for that has no DM set up yet. */
export async function scanCaptions(env: Env, list: Keyword[]): Promise<void> {
  const media = await graphGet(env, 'media?fields=caption,permalink&limit=10');
  if (!media.ok) throw new Error(`Caption scan failed with status ${media.status}`);
  const known = new Set(list.map(({ keyword }) => keyword.toLowerCase()));
  for (const post of media.body.data ?? []) {
    for (const keyword of captionKeywords(post.caption ?? '')) {
      if (known.has(keyword)) continue;
      const seen = await env.DB.prepare('SELECT 1 FROM flagged_keywords WHERE keyword = ?1').bind(keyword).first();
      if (seen) continue;
      const sent = await sendAlert(env, `New reel needs a DM link: ${keyword}`, [
        `This post asks people to comment "${keyword}", but no DM is set up for it, so commenters get nothing yet.`,
        post.permalink,
        '',
        `Send Claude the link for "${keyword}" to turn it on.`,
      ]);
      if (sent) await env.DB.prepare('INSERT OR IGNORE INTO flagged_keywords (keyword) VALUES (?1)').bind(keyword).run();
    }
  }
}

export async function findProblems(env: Env): Promise<string[]> {
  const problems: string[] = [];
  const subscribed = await graphGet(env, 'subscribed_apps').catch(() => null);
  if (!subscribed?.ok) {
    problems.push(`Meta rejected the health check (status ${subscribed?.status ?? 'network error'}). The token may have stopped working.`);
  } else if (!subscribed.body.data?.some((app: any) => app.subscribed_fields?.includes('comments'))) {
    problems.push('The Instagram account is no longer subscribed to comments, so no DMs will send. See "Subscribe the account" in the README.');
  }
  const { results } = await env.DB.prepare(
    `SELECT keyword, error, COUNT(*) AS total FROM deliveries
     WHERE status = 'failed' AND created_at >= datetime('now', '-1 day') GROUP BY keyword, error`,
  ).all<{ keyword: string; error: string; total: number }>();
  for (const row of results) problems.push(`${row.total} failed "${row.keyword}" DM(s) in the last day, error ${row.error}.`);
  return problems;
}

export async function checkHealth(env: Env): Promise<void> {
  const problems = await findProblems(env);
  if (problems.length) await sendAlert(env, 'Comment DMs need attention', problems);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/privacy') return new Response(privacyHtml(env), { headers: { 'content-type': 'text/html; charset=utf-8' } });
    if (url.pathname !== '/webhook') return new Response('Not found', { status: 404 });
    if (request.method === 'GET') return handleVerify(url, env);
    if (request.method === 'POST') return handleEvent(request, env);
    return new Response('Method not allowed', { status: 405 });
  },

  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    if (event.cron === HEALTH_CRON) await checkHealth(env);
    else await scanCaptions(env, keywords);
  },
} satisfies ExportedHandler<Env>;
