#!/bin/sh
# Fails if any .env* file other than .env.example is staged (secrets stay in .env.local, never committed; the tests'
# fake values live in playwright.config.ts, so there is no .env.test).
bad=$(git diff --cached --name-only --diff-filter=ACMR | grep -E '(^|/)\.env' | grep -vE '(^|/)\.env\.example$')
if [ -n "$bad" ]; then
  echo "Refusing to commit env files (secrets stay in .env.local):" >&2
  echo "$bad" >&2
  exit 1
fi
