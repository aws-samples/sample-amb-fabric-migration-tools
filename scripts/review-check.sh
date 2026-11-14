#!/usr/bin/env bash
# Every check that needs no Fabric network or AWS account, in one run. See docs/testing.md (Level 0).
#
#   scripts/review-check.sh            # from the repository root
#
# Needs Node 22 and npm. Optional, each skipped with a note if absent: configtxlator on PATH (Fabric 2.5) for the
# rebroadcast tests that use it, Go for the Go migration contract stub, Docker for the Java stub (Maven + JDK 21
# image), gitleaks for the secret scan. Exits non-zero if any check that ran failed.
set -uo pipefail
cd "$(dirname "$0")/.."
LOG=$(mktemp -d); FAIL=0
run() { local name=$1; shift; printf '%-34s' "$name"; if "$@" > "$LOG/$name.log" 2>&1; then echo ok; else echo "FAILED (log: $LOG/$name.log)"; FAIL=1; fi; }
skip() { printf '%-34s%s\n' "$1" "skipped: $2"; }

run install npm ci
run build npm run build
run lint npm run lint
run unit-tests-and-coverage npm run test:coverage
run audit-high-and-critical npm audit --omit=dev --audit-level=high
run rebroadcast-install bash -c 'cd rebroadcast && npm ci'
run rebroadcast-build bash -c 'cd rebroadcast && npm run build'
if command -v configtxlator >/dev/null; then run rebroadcast-tests bash -c 'cd rebroadcast && npm test'
else run rebroadcast-tests-partial bash -c 'cd rebroadcast && npm test'; skip rebroadcast-configtxlator-tests 'configtxlator not on PATH (15 tests skip)'; fi
run rebroadcast-audit bash -c 'cd rebroadcast && npm audit --omit=dev --audit-level=high'
if command -v go >/dev/null; then run stub-go scripts/compile-migration-stubs.sh go; else skip stub-go 'go not installed'; fi
if docker info >/dev/null 2>&1; then run stub-java docker run --rm -v "$PWD:/w" -w /w maven:3-eclipse-temurin-21 scripts/compile-migration-stubs.sh java
else skip stub-java 'docker not running'; fi
if command -v gitleaks >/dev/null; then run secret-scan gitleaks git . --redact --no-banner
else skip secret-scan 'gitleaks not installed'; fi

echo
[ "$FAIL" = 0 ] && echo "All checks that ran passed. Logs: $LOG" || echo "Some checks failed. Logs: $LOG"
exit $FAIL
