import type { Env } from './index.ts';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** Fill in OWNER_NAME, INSTAGRAM_HANDLE, CONTACT_EMAIL and POLICY_DATE, and check this matches what you run. */
export function privacyHtml(env: Env): string {
  const owner = escapeHtml(env.OWNER_NAME ?? 'the account owner');
  const handle = escapeHtml(env.INSTAGRAM_HANDLE ?? 'this account');
  const email = escapeHtml(env.CONTACT_EMAIL ?? '');
  const date = escapeHtml(env.POLICY_DATE ?? '');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Privacy Policy</title>
<style>
  body { max-width: 640px; margin: 0 auto; padding: 48px 16px; font: 16px/1.6 system-ui, sans-serif; color: #1a1a1a; background: #fff; }
  h1 { font-size: 28px; font-weight: 500; }
  h2 { font-size: 18px; font-weight: 500; margin-top: 32px; }
  @media (prefers-color-scheme: dark) { body { color: #ededed; background: #111; } a { color: #8ab4ff; } }
</style>
</head>
<body>
<h1>Privacy Policy</h1>
<p>This is a small tool run by ${owner} for the Instagram account ${handle}. Effective ${date}.</p>
<h2>What it does</h2>
<p>When you comment a specific keyword on one of my Instagram posts, the tool sends you one private message with the link you asked for. It only responds to public comments on my own posts.</p>
<h2>Data it uses</h2>
<p>Instagram sends the tool your comment, your Instagram-scoped user ID and your username. The tool checks the comment for the keyword and does not store the comment text or your username. For matching comments it stores your Instagram-scoped user ID, the comment ID, the post ID, the keyword, the delivery status and the time. This record stops you getting the same message twice.</p>
<h2>How it is used and shared</h2>
<p>This data is only used to send that message and prevent duplicates. It is not sold, used for advertising, or shared with anyone except the services that run the tool: Meta, which delivers messages, and Cloudflare, which hosts the tool and its database.</p>
<h2>Deleting your data</h2>
<p>To delete your record, email <a href="mailto:${email}">${email}</a> with your Instagram username. I will delete it within 30 days.</p>
<h2>Contact</h2>
<p>Questions go to <a href="mailto:${email}">${email}</a>.</p>
</body>
</html>
`;
}
