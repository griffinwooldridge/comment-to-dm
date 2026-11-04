#!/bin/sh
# Connects the Facebook Page. Reads a comment-replies system-user token from the clipboard,
# stores the Page's own token as FB_PAGE_TOKEN without printing it, subscribes the Page to feed,
# then clears the clipboard.
set -e
cd "$(dirname "$0")/.."
USER_TOKEN=$(pbpaste | tr -d '[:space:]')
case "$USER_TOKEN" in EAA*) ;; *) echo "The clipboard doesn't hold a Meta token (they start with EAA). Copy the system-user token and run this again."; exit 1 ;; esac
ACCOUNTS=$(curl -s -G "https://graph.facebook.com/v26.0/me/accounts" -d "fields=id,name,access_token" -H "Authorization: Bearer $USER_TOKEN")
printf '%s' "$ACCOUNTS" | python3 -c '
import json, sys
data = json.load(sys.stdin)
if "error" in data:
    sys.exit("Meta error: " + data["error"].get("message", "unknown"))
pages = data.get("data", [])
if not pages:
    sys.exit("No Pages on this token. Check the system user has the Page assigned.")
for page in pages:
    print("Page:", page["id"], page["name"])
' >&2
PAGE_ID=$(node -e 'console.log(require("./wrangler.json").vars.FB_PAGE_ID ?? "")')
[ -n "$PAGE_ID" ] || { echo "Set vars.FB_PAGE_ID in wrangler.json first."; exit 1; }
PAGE_TOKEN=$(printf '%s' "$ACCOUNTS" | python3 -c 'import json,sys; print(next((p["access_token"] for p in json.load(sys.stdin)["data"] if p["id"] == sys.argv[1]), ""))' "$PAGE_ID")
[ -n "$PAGE_TOKEN" ] || { echo "Page $PAGE_ID is not on this token. Assign it to comment-replies first."; exit 1; }
printf '%s' "$PAGE_TOKEN" | npx wrangler secret put FB_PAGE_TOKEN >/dev/null
echo "Stored FB_PAGE_TOKEN for Page $PAGE_ID"
curl -s -X POST "https://graph.facebook.com/v26.0/$PAGE_ID/subscribed_apps" -d "subscribed_fields=feed" -H "Authorization: Bearer $PAGE_TOKEN"
echo
unset USER_TOKEN PAGE_TOKEN ACCOUNTS
printf '' | pbcopy
echo "Clipboard cleared."
