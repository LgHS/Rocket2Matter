#!/usr/bin/env bash
# Deactivate, in Mattermost, the accounts that were inactive in RocketChat.
# The Mattermost bulk import has no "deactivated" flag, so this replays the
# `deactivated-users.txt` list produced by the export (one email per line —
# emails, not usernames, since an SSO login may rename accounts).
# Normally done for you by `rocket2matter post-import`.
#
# Usage (on the Mattermost host, local mode enabled):
#   ./deactivate-users.sh deactivated-users.txt
#
# Override the mmctl invocation if needed:
#   MMCTL="mmctl --local" ./deactivate-users.sh deactivated-users.txt
set -euo pipefail

FILE="${1:-deactivated-users.txt}"
MMCTL="${MMCTL:-mmctl --local}"

if [ ! -f "$FILE" ]; then
  echo "❌ Fichier introuvable : $FILE" >&2
  exit 1
fi

total=0 ok=0 fail=0
while IFS= read -r user || [ -n "$user" ]; do
  [ -z "$user" ] && continue
  total=$((total + 1))
  if $MMCTL user deactivate "$user" >/dev/null 2>&1; then
    ok=$((ok + 1))
  else
    fail=$((fail + 1))
    echo "  ⚠️  échec désactivation: $user" >&2
  fi
done < "$FILE"

echo "✅ Désactivés: $ok/$total (échecs: $fail)"
