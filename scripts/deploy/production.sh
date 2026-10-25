#!/usr/bin/env bash
# PRODUCTION deploy (needs John's yes; default is a dry run that stops before upload): build in a clean checkout that has no .env* and no private/,
# scan the build output for secrets and course data, and deploy the prebuilt output only if clean.
# Usage: scripts/deploy/production.sh [git-ref] [--deploy]   (default: HEAD, dry run). Run from the repo root.
set -euo pipefail
REF="${1:-HEAD}"; MODE="${2:---dry-run}"   # pass --deploy to upload
ROOT="$(pwd)"
D="$(mktemp -d)/rewind-deploy"
git worktree add -q --detach "$D" "$REF"
trap 'git -C "$ROOT" worktree remove --force "$D" >/dev/null 2>&1 || true' EXIT
cp -c -R node_modules "$D/node_modules" 2>/dev/null || cp -R node_modules "$D/node_modules"
mkdir -p "$D/.vercel" && cp .vercel/project.json "$D/.vercel/"
printf '.env*\nprivate\n.cache\n.claude\nnode_modules\n.next\n' > "$D/.vercelignore"
cd "$D"
rm -f .env.test .env.example   # committed fake/sample values; the deploy build uses neither
if ls -a | grep -qE '^\.env|^private$'; then echo "refusing: env file or private/ in the clean checkout"; exit 1; fi
npx vercel pull --yes --environment=production >/dev/null
rm -f .vercel/.env.*.local   # holds the OIDC token; not needed for the build
npx vercel build --prod >/dev/null
ls public/demo/media/*.mp4 2>/dev/null | sed 's/^/hosted clip: /' || true
echo "hosted clips: $(ls public/demo/media/*.mp4 2>/dev/null | wc -l | tr -d ' ') of $(node -e 'const b=JSON.parse(require("fs").readFileSync("public/demo/course/course.json","utf8"));console.log(b.sets.reduce((n,s)=>n+s.hosted.length,0))')"
# Scan (scripts/deploy/scan.py): secret values from the real .env.local, recording and Canvas links,
# real course ids, students' names, and real course text that isn't in the approved demo bundle; counts only.
python3 scripts/deploy/scan.py --root "$ROOT" --env "$ROOT/.env.local" --out .vercel/output
if [ "$MODE" != "--deploy" ]; then echo "dry run OK: built + scanned; nothing uploaded"; exit 0; fi
npx vercel deploy --prebuilt --prod 2>&1 | grep -oE "https://[a-z0-9-]+\.vercel\.app" | head -1
