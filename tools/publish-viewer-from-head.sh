#!/usr/bin/env bash
# Publish the protected family viewer from a temporary export of HEAD (VIEWER.md,
# "Temporary direct publication", steps 1-5), never from the shared working tree.
#
# The export is HEAD exactly (a private index, read-tree HEAD, checkout-index), so other
# sessions' uncommitted or staged files cannot enter the artifact. The export has no .git, so
# the build's stamped validation runs stamp-free and reads HEAD from DEPLOY_MAIN_HEAD_SHA.
# Every gate is enforced: build completed, deployment Ready, unauthenticated /api/family is
# 401 with cache-control: private, no-store, and only then promote. Logs go to $PUBLISH_LOG_DIR
# (default: a fresh temp directory) and never contain tokens.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOGS="${PUBLISH_LOG_DIR:-$(mktemp -d /tmp/viewer-publish-logs-XXXXXX)}"
SCOPE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && node -e 'import("./tools/tree-config.mjs").then((m) => console.log(m.loadTreeConfig().vercel.scope || ""))')
[ -n "$SCOPE" ] || { echo "Set vercel.scope in tree.config.json"; exit 1; }
cd "$ROOT" || exit 1
if command -v gpuq >/dev/null 2>&1; then gpuq gaming check --quiet; rc=$?; if [ "$rc" -eq 69 ]; then echo "Gaming Mode: check gpuq status before publishing"; exit 69; fi; fi
HEAD_SHA=$(git rev-parse HEAD)
EXP=$(mktemp -d /tmp/viewer-publish-XXXXXX); IDX="$EXP.index"
cleanup() { cd "$ROOT"; rm -rf "$EXP" "$IDX"; }
trap cleanup EXIT
echo "export $EXP for $HEAD_SHA (logs in $LOGS)"
GIT_INDEX_FILE="$IDX" git read-tree HEAD && GIT_INDEX_FILE="$IDX" git checkout-index -a -f --prefix="$EXP/" || { echo "EXPORT FAILED"; exit 1; }
ln -s "$ROOT/node_modules" "$EXP/node_modules"
mkdir -p "$EXP/.vercel" && cp "$ROOT/.vercel/project.json" "$EXP/.vercel/project.json"
cd "$EXP" || exit 1
export VALIDATION_STAMPS=off DEPLOY_MAIN_HEAD_SHA="$HEAD_SHA"
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
rm -rf .vercel/output
echo "=== build"; npx --yes vercel@55.0.0 build --prod --scope "$SCOPE" > "$LOGS/build.log" 2>&1; echo "build exit=$?"
grep -q -i 'Build Completed' "$LOGS/build.log" || { echo "BUILD NOT COMPLETED"; grep -i -E 'error' "$LOGS/build.log" | tail -5; exit 1; }
echo "=== deploy"; npx --yes vercel@55.0.0 deploy --prebuilt --prod --skip-domain --yes --scope "$SCOPE" > "$LOGS/deploy.log" 2>&1; echo "deploy exit=$?"
URL=$(grep -o -E 'https://[a-z0-9-]+\.vercel\.app' "$LOGS/deploy.log" | grep -v -E '^https://vercel\.app' | tail -1)
echo "deployment url: $URL"
[ -n "$URL" ] || { echo "NO DEPLOYMENT URL"; tail -5 "$LOGS/deploy.log"; exit 1; }
echo "=== inspect"; npx --yes vercel@55.0.0 inspect "$URL" --scope "$SCOPE" > "$LOGS/inspect.log" 2>&1; grep -E 'status|id ' "$LOGS/inspect.log" | head -3
grep -q -E 'Ready' "$LOGS/inspect.log" || { echo "NOT READY"; exit 1; }
echo "=== access check"; npx --yes vercel@55.0.0 curl --deployment "$URL" /api/family -i > "$LOGS/curl.log" 2>&1; grep -i -E '^HTTP/|cache-control' "$LOGS/curl.log" | head -3
grep -q -E 'HTTP/[0-9.]+ 401' "$LOGS/curl.log" && grep -q -i 'cache-control: private, no-store' "$LOGS/curl.log" || { echo "ACCESS CHECK FAILED; not promoting"; exit 1; }
echo "=== promote"; npx --yes vercel@55.0.0 promote "$URL" --yes --scope "$SCOPE" > "$LOGS/promote.log" 2>&1; echo "promote exit=$?"; tail -2 "$LOGS/promote.log"
echo "PUBLISHED $HEAD_SHA $URL"
