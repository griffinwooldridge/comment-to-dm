#!/bin/sh
# Lists recent post captions. Usage: sh scripts/list-posts.sh YOUR_INSTAGRAM_ACCOUNT_ID
# Reads a system user token from the macOS clipboard.
TOKEN=$(pbpaste | tr -d '[:space:]')
curl -s -G "https://graph.facebook.com/v26.0/$1/media" \
  --data-urlencode "fields=caption,permalink,timestamp" -d "limit=30" \
  -H "Authorization: Bearer $TOKEN" | python3 -c '
import json, sys
data = json.load(sys.stdin)
if "error" in data:
    print(data["error"]["message"])
for post in data.get("data", []):
    caption = " ".join((post.get("caption") or "").split())[:220]
    print(post["timestamp"][:10], post["permalink"])
    print("  " + caption)
'
