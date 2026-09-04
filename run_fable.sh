#!/bin/bash
NODE_OPTIONS="--max-old-space-size=128" exec claude --model claude-fable-5 -p "$(cat "$1")"
