#!/bin/bash
# Autonomous prompt optimization loop
# Kicks off Claude Code with program.md to review transcripts and improve prompts.
# Usage: ./optimize/run.sh
#
# Run before bed. Review the PR in the morning.

set -e
cd "$(dirname "$0")/.."

# Load DATABASE_URL to check for transcripts
source .env.local 2>/dev/null || true

if [ -z "$DATABASE_URL" ]; then
  echo "ERROR: DATABASE_URL not set in .env.local"
  exit 1
fi

# Quick check: are there recent transcripts worth reviewing?
COUNT=$(psql "$DATABASE_URL" -t -c "
  SELECT count(*)
  FROM \"CallEvent\"
  WHERE \"totalTurns\" > 2
    AND \"durationSec\" > 10
    AND \"startedAt\" > now() - interval '7 days'
" 2>/dev/null | tr -d ' ')

if [ "$COUNT" -eq 0 ] 2>/dev/null; then
  echo "No recent transcripts (last 7 days) with substance. Nothing to optimize."
  exit 0
fi

echo "Found $COUNT recent transcripts. Starting optimization loop..."
echo "---"

# Invoke Claude Code with the program
claude -p "Read optimize/program.md and execute the full optimization loop described in it. Start with Step 1." \
  --allowedTools "Read,Write,Edit,Bash,Glob,Grep"
