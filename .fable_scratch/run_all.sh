#!/bin/bash
cd /tmp/fable_review
for n in 1 2 3 4 5 6; do
  echo "=== starting chunk $n ===" >> all_run.log
  /workspace/projects/foray/.fable_scratch/run_fable.sh "prompt${n}.txt" "out${n}.txt" >> all_run.log 2>&1
  echo "=== finished chunk $n rc=$? ===" >> all_run.log
done
echo "ALL_CHUNKS_DONE" >> all_run.log
