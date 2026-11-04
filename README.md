# comment-to-dm

A self-hosted alternative to comment-to-DM tools. When someone comments a keyword on your Instagram post or Facebook Page post, this Cloudflare Worker sends them a private reply with your link, with a tappable button.

It uses Meta's official Instagram and Messenger APIs. There is no monthly host: one Worker and one D1 database, which should fit Cloudflare's free tier at small volumes.

## What it does

- Sends one DM per person, per keyword, per post, on every post you have, including future ones.
- Stops repeat sends when Meta redelivers an event, and lets Meta retry after a rate limit.
- Falls back to a plain link if Meta rejects the button.
- Serves the privacy policy page Meta requires, at `/privacy`.
- Emails you if the token or subscription stops working, or sends fail. This needs Resend.
- Emails you when a new caption asks for a keyword you haven't set up.
- Optionally answers comments on a Facebook Page too, with the same keywords.
- Can backfill keyword comments from the last 7 days that never got a DM.

It does not answer incoming DMs or post public replies. Facebook personal profiles have no API, so Facebook needs a Page.

## Before you start

Read this first:

- **Use it on your own account.** This setup was only tested on one Instagram professional account, on an app its owner runs.
- **Meta's rules can change, and its docs conflict.** One page says `comments` webhooks need Advanced Access, while another says it depends. In testing, real commenters with no app role still received DMs on Standard Access. You may see something different.
- **No tool can promise your account is safe.** Keep it to people who asked by commenting, and follow Meta's Platform Terms and messaging policies.
- **Never run two tools on one keyword.** If ManyChat or similar is also active, people get two DMs and one tool's reply can fail. Turn the other automation off first.

## Setup

You need an Instagram professional account, a Meta business portfolio that owns it, a Cloudflare account, and a domain on Cloudflare.

### 1. Deploy the Worker

```bash
npm install
npx wrangler d1 create comment-to-dm
```

Edit `wrangler.json`: add the database ID, your domain, your Instagram account ID, and your details for the privacy page and alerts. Read the policy in `src/privacy.ts` and make sure it's true for you. It is a starting point, not legal advice.

```bash
npm run deploy
npx wrangler d1 migrations apply comment-to-dm --remote
```

### 2. Create the Meta app

1. In [Meta for Developers](https://developers.facebook.com/apps/), create an app with the **Manage messaging & content on Instagram** use case.
2. Connect the business portfolio that owns your Instagram account. If you have several, check which one owns it under Business settings > Instagram profiles. Choosing the wrong one was the main cause of errors in testing.
3. New apps only get **API setup with Unified login**. Don't look for the older Instagram login.

### 3. Create a system user

Tokens generated on the app's setup page failed in testing with error 100, subcode 33. A system user worked:

1. In Business settings for the right portfolio, open **System users** and add one with the **Employee** role.
2. Assign it your Instagram profile and your app, both with full control.
3. Generate a token for your app with expiration **Never** and only `instagram_basic`, `instagram_manage_comments` and `instagram_manage_messages`.
4. Copy the token. Don't paste it into chats or tickets.

### 4. Set the secrets

Each command reads from your clipboard, so nothing appears on screen. Copy the value first.

```bash
pbpaste | tr -d '[:space:]' | npx wrangler secret put IG_ACCESS_TOKEN
```

Use the app secret from **App settings > Basic**:

```bash
pbpaste | tr -d '[:space:]' | npx wrangler secret put META_APP_SECRET
```

Make a verify token. This also copies it for the next step:

```bash
openssl rand -hex 32 | tr -d '\n' | tee >(pbcopy) | npx wrangler secret put WEBHOOK_VERIFY_TOKEN
```

These commands are for macOS. On other systems, use `npx wrangler secret put NAME` and paste at the prompt.

### 5. Connect the webhook

On the Unified login setup page, under **Configure webhooks**:

1. Set the callback URL to `https://YOUR_SUBDOMAIN.example.com/webhook`.
2. Paste the verify token, then click **Verify and save**.
3. Subscribe to the `comments` field.
4. Use **Test** then **Send to server** on `comments`. The Worker should return 200.

### 6. Subscribe your account

The dashboard toggle was not enough in testing. Copy your token, then run this with your account ID:

```bash
TOKEN=$(pbpaste | tr -d '[:space:]'); curl -s -X POST "https://graph.facebook.com/v26.0/YOUR_INSTAGRAM_ACCOUNT_ID/subscribed_apps" -d "subscribed_fields=comments" -H "Authorization: Bearer $TOKEN"; echo; curl -s "https://graph.facebook.com/v26.0/YOUR_INSTAGRAM_ACCOUNT_ID/subscribed_apps" -H "Authorization: Bearer $TOKEN"; echo; unset TOKEN
```

You should see `"success":true`, then `comments` in `subscribed_fields`. Removing the account from the app's setup page drops this subscription, so run it again if that happens.

### 7. Publish and test

1. Add `https://YOUR_SUBDOMAIN.example.com/privacy` as the Privacy Policy URL in **App settings > Basic**.
2. Click **Publish** in the app. Webhooks need the app to be Live.
3. From a different account, comment a keyword on one of your posts. Comments from your own account are skipped.
4. Check the DMs, including Message requests, and the delivery log below.

## Facebook Page (optional)

This uses the same app, system user and keywords. Personal profiles don't work; it has to be a Page.

1. Make sure your business portfolio owns the Page, and give the system user full control of it under **Assign assets**.
2. In the app, add the **Engage with customers on Messenger from Meta** use case. Check that `pages_messaging`, `pages_manage_metadata` and `pages_read_engagement` are listed.
3. In that use case's **Messenger API Settings**, set the same callback URL and verify token and click **Verify and save**. You can skip **Generate access tokens** on that page, because the script below uses the system user.
4. Put your Page ID in `vars.FB_PAGE_ID` in `wrangler.json`, and the Page name or URL in `FACEBOOK_PAGE` for the privacy page. Deploy.
5. Generate a system user token with `pages_show_list`, `pages_messaging`, `pages_manage_metadata` and `pages_read_engagement`, copy it, and run:

```bash
./scripts/connect-page.sh
```

It stores the Page's own token as `FB_PAGE_TOKEN` without printing it, subscribes the Page to `feed`, and clears your clipboard. Until `FB_PAGE_TOKEN` is set, Facebook comments are ignored.

In testing, a Page private reply with a button went through without App Review, the same as Instagram. To backfill Facebook comments, the token also needs `pages_read_user_content`.

## Keywords

Edit `src/keywords.json`, then run:

```bash
npm test && npm run deploy
```

```json
{
  "keyword": "guide",
  "message": "Here's the guide from the reel",
  "button": { "title": "Open the guide", "url": "https://example.com/guide" }
}
```

By default the comment must be only the keyword, so `ui` fires on "UI!" but not on "love this ui". Add `"loose": true` to match the word anywhere in a comment of up to four words, so "mobbin please" fires but a longer sentence that mentions it does not. Only use it for words people rarely type by accident.

Keep each message a little different, since many identical link messages look like spam. Meta allows one private reply per comment, within 7 days of the comment. Comments made before you add a keyword get no DM.

## Backfill missed comments

Meta allows a private reply up to 7 days after a comment, so comments made before a keyword existed, or while the Worker was down, can still get their DM. This runs through a key-protected endpoint, so your Meta tokens never leave Cloudflare:

```bash
KEY=$(openssl rand -hex 32); security add-generic-password -s comment-to-dm-admin -a admin -U -w "$KEY"; printf '%s' "$KEY" | npx wrangler secret put ADMIN_KEY; unset KEY
WORKER_URL=https://YOUR_SUBDOMAIN.example.com node scripts/backfill.mjs
```

The first run is a dry run. It writes `.backfill.json` and lists who would get which DM. Edit that file to drop anyone, then send one DM every 45 seconds:

```bash
WORKER_URL=https://YOUR_SUBDOMAIN.example.com node scripts/backfill.mjs --send
```

For each send, the Worker re-reads the comment from Meta and checks the post, the age and the keyword before replying. Callers can't choose the text or the recipient. If another tool was answering a keyword before you switched, leave those comments out, or people get a second DM.

## Alerts

Alerts need a [Resend](https://resend.com) sending key and a verified domain:

```bash
pbpaste | tr -d '[:space:]' | npx wrangler secret put RESEND_API_KEY
```

- Every day at 15:00 UTC it checks the token, the `comments` subscription, the Page's `feed` subscription if you set one up, and the last day's failed sends. A healthy day sends nothing.
- Every hour it reads your 10 latest captions for `Comment "WORD"` or `Comment WORD`. If WORD isn't in `src/keywords.json`, it emails you once with the post link. It never sends a DM by itself, because captions don't contain the link to send.

## Check deliveries

```bash
npx wrangler d1 execute comment-to-dm --remote --command "select created_at, keyword, status, error from deliveries order by created_at desc limit 20"
```

`sent` means the button was accepted. `sent_link` means Meta rejected it and the plain link went out. `failed` rows keep Meta's error as `http status:code:subcode`.

`400:-1:2534023` isn't in Meta's docs. In testing it appeared when another automation was also answering the keyword, and went away when that was turned off.

## Secrets

| Secret | Source |
|---|---|
| `META_APP_SECRET` | App settings > Basic. It also signs webhooks |
| `IG_ACCESS_TOKEN` | System user token from Business settings |
| `WEBHOOK_VERIFY_TOKEN` | Any random string, also pasted into Meta's webhook form |
| `FB_PAGE_TOKEN` | Optional, set by `scripts/connect-page.sh` |
| `ADMIN_KEY` | Optional, for backfill |
| `RESEND_API_KEY` | Optional, for alerts |

The token doesn't expire on this configuration. It stops working if the app is removed or the Instagram account moves to another portfolio.

## License

MIT. Not affiliated with Meta, Instagram or Facebook.
