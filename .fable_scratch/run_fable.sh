#!/bin/bash
# Usage: run_fable.sh <prompt_file> <output_file>
PROMPT_FILE="$1"
OUT_FILE="$2"
MAX_TRIES=25
for i in $(seq 1 $MAX_TRIES); do
  cat "$PROMPT_FILE" | claude --model claude-fable-5 -p > "$OUT_FILE" 2>&1
  rc=$?
  if [ $rc -eq 0 ] && [ -s "$OUT_FILE" ]; then
    echo "SUCCESS on try $i"
    exit 0
  fi
  echo "try $i failed rc=$rc, retrying..." >&2
  sleep 8
done
echo "ALL TRIES FAILED" >&2
exit 1
