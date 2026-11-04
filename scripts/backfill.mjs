// Finds keyword comments from the last week that never got a DM, then sends them slowly.
//   node scripts/backfill.mjs          dry run, writes .backfill.json and prints it
//   node scripts/backfill.mjs --send   sends what the dry run found, one every 45 seconds
// Set WORKER_URL to your Worker. The admin key lives in the macOS Keychain under comment-to-dm-admin. Meta tokens never leave Cloudflare.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const BASE = `${process.env.WORKER_URL ?? 'https://YOUR_SUBDOMAIN.example.com'}/admin/backfill`;
const FILE = new URL('../.backfill.json', import.meta.url);
const GAP_MS = 45_000;
const MAX_PAGES = 60;
const key = execFileSync('security', ['find-generic-password', '-s', 'comment-to-dm-admin', '-w']).toString().trim();
const auth = { authorization: `Bearer ${key}` };

async function call(query = '', init = {}) {
  const res = await fetch(BASE + query, { ...init, headers: { ...auth, 'content-type': 'application/json' } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(body)}`);
  return body;
}

if (process.argv.includes('--send')) {
  const todo = JSON.parse(readFileSync(FILE, 'utf8'));
  console.log(`Sending ${todo.length} DMs, one every ${GAP_MS / 1000} s`);
  for (const [i, c] of todo.entries()) {
    const res = await call('', { method: 'POST', body: JSON.stringify({ platform: c.platform, post: c.post, comment: c.comment }) });
    console.log(`${i + 1}/${todo.length} ${c.platform} ${c.keyword} @${c.username ?? '?'}: ${res.status}${res.error ? ` ${res.error}` : ''}`);
    if (i < todo.length - 1) await new Promise((r) => setTimeout(r, GAP_MS));
  }
} else {
  const posts = await call();
  const found = [];
  for (const platform of ['instagram', 'facebook']) {
    if (!Array.isArray(posts[platform])) {
      console.log(`${platform}: could not list posts`, posts[platform]);
      continue;
    }
    for (const post of posts[platform]) {
      let after = null;
      let recent = 0;
      for (let page = 0; page < MAX_PAGES; page++) {
        let res;
        try {
          res = await call(`?platform=${platform}&post=${encodeURIComponent(post.id)}${after ? `&after=${encodeURIComponent(after)}` : ''}`);
        } catch (error) {
          console.log(`${platform} ${post.link}: skipped, ${error.message.slice(0, 160)}`);
          break;
        }
        recent += res.recent;
        for (const c of res.candidates) found.push({ platform, post: post.id, link: post.link, ...c });
        if (!res.next) break;
        after = res.next;
      }
      if (recent) console.log(`${platform} ${post.date.slice(0, 10)} ${post.link}: ${recent} comments this week`);
    }
  }
  const seen = new Set();
  const todo = found.filter((c) => {
    const k = `${c.post}:${c.username}:${c.keyword}`;
    return !seen.has(k) && seen.add(k);
  });
  writeFileSync(FILE, JSON.stringify(todo, null, 2));
  console.log(`\n${todo.length} would get a DM:`);
  for (const c of todo) console.log(`  ${c.platform.padEnd(9)} ${c.keyword.padEnd(7)} ${c.date.slice(0, 10)} @${c.username ?? '?'}: ${c.text.slice(0, 60)}`);
}
