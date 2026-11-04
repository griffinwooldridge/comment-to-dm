import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, test } from 'node:test';
import worker, { captionKeywords, findProblems, handleComment, matchKeyword, parseComments, scanCaptions } from '../src/index.ts';

const SECRET = 'app-secret';
const ACCOUNT = '100';
let sent: { url: string; auth: string | null; body: any }[];
let graphResponses: Response[];
let env: any;

function fakeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'));
  return {
    db,
    prepare(sql: string) {
      let args: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) { args = values; return statement; },
        async run() { return { meta: { changes: Number(db.prepare(sql).run(...(args as any[])).changes) } }; },
        async first() { return db.prepare(sql).get(...(args as any[])) ?? null; },
        async all() { return { results: db.prepare(sql).all(...(args as any[])) }; },
      };
      return statement;
    },
  };
}

beforeEach(() => {
  sent = [];
  graphResponses = [];
  env = {
    DB: fakeD1(), META_APP_SECRET: SECRET, IG_ACCESS_TOKEN: 'system-token', WEBHOOK_VERIFY_TOKEN: 'verify-me',
    GRAPH_BASE: 'https://graph.test', IG_ACCOUNT_ID: ACCOUNT, RESEND_BASE: 'https://resend.test/emails',
    RESEND_API_KEY: 'resend-key', ALERT_FROM: 'alerts@example.com', ALERT_TO: 'me@example.com',
  };
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    sent.push({ url: String(input), auth: headers.get('authorization'), body: init?.body ? JSON.parse(String(init.body)) : null });
    return graphResponses.shift() ?? new Response('{}', { status: 200 });
  }) as typeof fetch;
});

function event(text: string, overrides: Record<string, string> = {}) {
  const { commentId = 'c1', from = '200', media = 'm1' } = overrides;
  return { object: 'instagram', entry: [{ id: ACCOUNT, changes: [{ field: 'comments', value: { comment_id: commentId, text, from: { id: from, username: 'someone' }, media: { id: media } } }] }] };
}

function post(payload: unknown, secret = SECRET) {
  const body = JSON.stringify(payload);
  const signature = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
  return worker.fetch(new Request('https://ig.test/webhook', { method: 'POST', body, headers: { 'x-hub-signature-256': signature } }), env);
}

const rows = () => env.DB.db.prepare('SELECT * FROM deliveries').all() as any[];

test('answers Meta verification only with the right token', async () => {
  const good = await worker.fetch(new Request('https://ig.test/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=abc'), env);
  assert.equal(good.status, 200);
  assert.equal(await good.text(), 'abc');
  const bad = await worker.fetch(new Request('https://ig.test/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=abc'), env);
  assert.equal(bad.status, 403);
});

test('rejects a bad signature and sends nothing', async () => {
  assert.equal((await post(event('guide'), 'wrong-secret')).status, 401);
  assert.equal((await worker.fetch(new Request('https://ig.test/webhook', { method: 'POST', body: '{}' }), env)).status, 401);
  assert.equal(sent.length, 0);
});

test('fails closed when a secret is missing', async () => {
  for (const name of ['META_APP_SECRET', 'IG_ACCESS_TOKEN']) {
    const value = env[name];
    delete env[name];
    assert.equal((await post(event('guide'))).status, 503, name);
    env[name] = value;
  }
  assert.equal(sent.length, 0);
});

test('reads both comment payload shapes Meta documents', () => {
  const expected = [{ id: 'c1', text: 'hi', commenterId: '200', mediaId: 'm1', accountId: ACCOUNT, platform: 'instagram' }];
  const from = { id: '200' };
  const media = { id: 'm1' };
  const nested = { entry: [{ id: ACCOUNT, changes: [{ field: 'comments', value: { comment_id: 'c1', text: 'hi', from, media } }] }] };
  const flat = { entry: [{ id: ACCOUNT, field: 'comments', value: { id: 'c1', text: 'hi', from, media } }] };
  assert.deepEqual(parseComments(nested), expected);
  assert.deepEqual(parseComments(flat), expected);
});

test('sends one private reply tied to the comment', async () => {
  assert.equal((await post(event('Guide!'))).status, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, `https://graph.test/v26.0/${ACCOUNT}/messages`);
  assert.equal(sent[0].auth, 'Bearer system-token');
  assert.deepEqual(sent[0].body.recipient, { comment_id: 'c1' });
  assert.match(sent[0].body.message.attachment.payload.buttons[0].url, /example\.com\/guide/);
  assert.equal(rows()[0].status, 'sent');
});

test('a keyword only matches when it is the whole comment', () => {
  const list = [{ keyword: 'ui', message: 'x' }];
  for (const text of ['ui', 'UI!', 'ui 🙏', ' Ui. ']) assert.ok(matchKeyword(text, list), text);
  for (const text of ['love this ui', 'ui please', 'guide', '']) assert.equal(matchKeyword(text, list), undefined, text);
});

test('a loose keyword matches as a whole word anywhere', () => {
  const list = [{ keyword: 'guide', message: 'x', loose: true }];
  for (const text of ['guide', 'GUIDE', 'guide please', 'I want Guide.', 'Guide 🙏']) assert.ok(matchKeyword(text, list), text);
  for (const text of ['guides', 'notguide', 'nice video', '']) assert.equal(matchKeyword(text, list), undefined, text);
});

test('ignores your own comments and non-matching comments', async () => {
  await post(event('guide', { from: ACCOUNT }));
  await post(event('great video', { commentId: 'c2' }));
  assert.equal(sent.length, 0);
  assert.equal(rows().length, 0);
});

test('Meta redelivery and repeat comments do not send a second DM', async () => {
  await post(event('guide'));
  await post(event('guide'));
  await post(event('guide again', { commentId: 'c2' }));
  assert.equal(sent.length, 1);
});

test('the same person gets the DM again on a different post', async () => {
  await post(event('guide'));
  await post(event('guide', { commentId: 'c2', media: 'm2' }));
  assert.equal(sent.length, 2);
});

test('a rate limit asks Meta to retry and the retry can send', async () => {
  graphResponses.push(Response.json({ error: { code: 4 } }, { status: 400 }));
  assert.equal((await post(event('guide'))).status, 503);
  assert.equal(rows().length, 0);
  assert.equal((await post(event('guide'))).status, 200);
  assert.equal(sent.length, 2);
  assert.equal(rows()[0].status, 'sent');
});

test('a permanent failure is logged and not retried', async () => {
  const failure = () => Response.json({ error: { code: 10, error_subcode: 2534022 } }, { status: 400 });
  graphResponses.push(failure(), failure());
  assert.equal((await post(event('guide'))).status, 200);
  assert.equal(rows()[0].status, 'failed');
  assert.equal(rows()[0].error, '400:10:2534022');
  await post(event('guide'));
  assert.equal(sent.length, 2);
});

test('serves the privacy policy', async () => {
  const res = await worker.fetch(new Request('https://ig.test/privacy'), env);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Privacy Policy/);
});

const buttonList = [{ keyword: 'ui', message: 'Here you go', button: { title: 'Open', url: 'https://example.com' } }];
const comment = { id: 'c1', text: 'ui', commenterId: '200', mediaId: 'm1', accountId: ACCOUNT, platform: 'instagram' as const };

test('a keyword with a button sends a button template', async () => {
  assert.equal(await handleComment(env, comment, buttonList), true);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].body.message.attachment.payload, {
    template_type: 'button', text: 'Here you go', buttons: [{ type: 'web_url', url: 'https://example.com', title: 'Open' }],
  });
  assert.equal(rows()[0].status, 'sent');
});

test('a rejected button falls back to a plain link', async () => {
  graphResponses.push(Response.json({ error: { code: 100 } }, { status: 400 }));
  assert.equal(await handleComment(env, comment, buttonList), true);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1].body.message, { text: 'Here you go https://example.com' });
  assert.equal(rows()[0].status, 'sent_link');
});

test('finds the keyword a caption asks for', () => {
  assert.deepEqual(captionKeywords('👇 Comment "UI" and I’ll send you the link!'), ['ui']);
  assert.deepEqual(captionKeywords('👇🏼 Comment UNSLOP and I’ll send you the link'), ['unslop']);
  assert.deepEqual(captionKeywords('Comment “Guide” for 20% off'), ['guide']);
  assert.deepEqual(captionKeywords('Comment below with your thoughts'), []);
  assert.deepEqual(captionKeywords('Figma Just Dropped Some Huge Updates'), []);
});

test('a new caption keyword alerts once and known ones stay quiet', async () => {
  const media = () => Response.json({ data: [{ caption: 'Comment "NEWKIT" for the link', permalink: 'https://ig.test/p/1' }, { caption: 'Comment "UI"', permalink: 'https://ig.test/p/2' }] });
  graphResponses.push(media());
  await scanCaptions(env, buttonList);
  const emails = sent.filter(({ url }) => url.startsWith('https://resend.test'));
  assert.equal(emails.length, 1);
  assert.match(emails[0].body.subject, /newkit/);
  graphResponses.push(media());
  await scanCaptions(env, buttonList);
  assert.equal(sent.filter(({ url }) => url.startsWith('https://resend.test')).length, 1);
});

test('a keyword is alerted again if the email failed', async () => {
  const media = () => Response.json({ data: [{ caption: 'Comment "NEWKIT"', permalink: 'https://ig.test/p/1' }] });
  graphResponses.push(media(), new Response('{}', { status: 500 }), media());
  await scanCaptions(env, []);
  await scanCaptions(env, []);
  assert.equal(sent.filter(({ url }) => url.startsWith('https://resend.test')).length, 2);
});

test('the health check reports a dead token, a lost subscription and failed sends', async () => {
  graphResponses.push(Response.json({ error: { code: 190 } }, { status: 401 }));
  assert.match((await findProblems(env))[0], /token/);
  graphResponses.push(Response.json({ data: [] }));
  assert.match((await findProblems(env))[0], /no longer subscribed/);
  env.DB.db.prepare(`INSERT INTO deliveries (dedupe_key, comment_id, media_id, commenter_id, keyword, status, error) VALUES ('k', 'c', 'm', 'u', 'ui', 'failed', '400:1:2')`).run();
  graphResponses.push(Response.json({ data: [{ subscribed_fields: ['comments'] }] }));
  assert.match((await findProblems(env))[0], /1 failed "ui"/);
});

test('a healthy account reports nothing', async () => {
  graphResponses.push(Response.json({ data: [{ subscribed_fields: ['comments'] }] }));
  assert.deepEqual(await findProblems(env), []);
});

test('only /webhook and /privacy exist', async () => {
  assert.equal((await worker.fetch(new Request('https://ig.test/'), env)).status, 404);
  assert.equal((await worker.fetch(new Request('https://ig.test/webhook', { method: 'PUT' }), env)).status, 405);
});

const PAGE = '900';

function pageEvent(message: string, overrides: Record<string, string> = {}) {
  const { commentId = 'p1_c1', from = '300', verb = 'add', item = 'comment' } = overrides;
  return { object: 'page', entry: [{ id: PAGE, changes: [{ field: 'feed', value: { item, verb, comment_id: commentId, post_id: `${PAGE}_p1`, message, from: { id: from, name: 'Someone' } } }] }] };
}

test('reads new Facebook Page comments and ignores other feed changes', () => {
  assert.deepEqual(parseComments(pageEvent('guide')), [
    { id: 'p1_c1', text: 'guide', commenterId: '300', mediaId: `${PAGE}_p1`, accountId: PAGE, platform: 'facebook' },
  ]);
  assert.deepEqual(parseComments(pageEvent('guide', { verb: 'edited' })), []);
  assert.deepEqual(parseComments(pageEvent('guide', { item: 'reaction' })), []);
});

test('answers a Facebook comment from the Page with the Page token', async () => {
  env.FB_PAGE_TOKEN = 'page-token';
  assert.equal((await post(pageEvent('guide'))).status, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, `https://graph.test/v26.0/${PAGE}/messages`);
  assert.equal(sent[0].auth, 'Bearer page-token');
  assert.deepEqual(sent[0].body.recipient, { comment_id: 'p1_c1' });
  assert.equal(rows()[0].status, 'sent');
});

test('skips Facebook comments until a Page token is set, and the Page\'s own comments', async () => {
  assert.equal((await post(pageEvent('guide'))).status, 200);
  env.FB_PAGE_TOKEN = 'page-token';
  assert.equal((await post(pageEvent('guide', { from: PAGE }))).status, 200);
  assert.equal(sent.length, 0);
  assert.equal(rows().length, 0);
});

test('flags a Facebook Page that lost its feed subscription', async () => {
  env.FB_PAGE_ID = PAGE;
  env.FB_PAGE_TOKEN = 'page-token';
  const subscribed = (fields: string[]) => new Response(JSON.stringify({ data: [{ subscribed_fields: fields }] }));
  graphResponses = [subscribed(['comments']), subscribed([])];
  assert.match((await findProblems(env))[0], /Facebook Page is no longer subscribed/);
  assert.equal(sent[1].url, `https://graph.test/v26.0/${PAGE}/subscribed_apps`);
  assert.equal(sent[1].auth, 'Bearer page-token');
  graphResponses = [subscribed(['comments']), subscribed(['feed'])];
  assert.deepEqual(await findProblems(env), []);
});

function backfill(init: RequestInit & { query?: string } = {}, key = 'admin-key') {
  return worker.fetch(new Request(`https://ig.test/admin/backfill${init.query ?? ''}`, { ...init, headers: { authorization: `Bearer ${key}` } }), env);
}

test('backfill refuses callers without the admin key', async () => {
  assert.equal((await backfill()).status, 403);
  env.ADMIN_KEY = 'admin-key';
  assert.equal((await backfill({}, 'wrong')).status, 403);
  assert.equal(sent.length, 0);
});

test('backfill lists unanswered keyword comments from the last week', async () => {
  env.ADMIN_KEY = 'admin-key';
  const now = new Date().toISOString();
  const old = new Date(Date.now() - 8 * 86400000).toISOString();
  graphResponses = [new Response(JSON.stringify({ data: [
    { id: 'c1', text: 'guide', timestamp: now, from: { id: '200', username: 'a' } },
    { id: 'c2', text: 'guide', timestamp: old, from: { id: '201', username: 'b' } },
    { id: 'c3', text: 'nice', timestamp: now, from: { id: '202', username: 'c' } },
  ] }))];
  const res = await (await backfill({ query: '?platform=instagram&post=m1' })).json() as any;
  assert.deepEqual(res.candidates.map((c: any) => c.comment), ['c1']);
  assert.equal(res.recent, 2);
});

test('backfill send re-reads the comment and replies through the normal path', async () => {
  env.ADMIN_KEY = 'admin-key';
  graphResponses = [
    new Response(JSON.stringify({ id: 'c1', text: 'guide', timestamp: new Date().toISOString(), from: { id: '200' }, media: { id: 'm1' } })),
    new Response('{}'),
  ];
  const res = await (await backfill({ method: 'POST', body: JSON.stringify({ platform: 'instagram', post: 'm1', comment: 'c1' }) })).json() as any;
  assert.equal(res.status, 'sent');
  assert.equal(sent[1].url, `https://graph.test/v26.0/${ACCOUNT}/messages`);
  graphResponses = [new Response(JSON.stringify({ id: 'c9', text: 'guide', timestamp: new Date().toISOString(), from: { id: '200' }, media: { id: 'other' } }))];
  const wrongPost = await (await backfill({ method: 'POST', body: JSON.stringify({ platform: 'instagram', post: 'm1', comment: 'c9' }) })).json() as any;
  assert.equal(wrongPost.status, 'mismatch');
  assert.equal(sent.length, 3);
});
