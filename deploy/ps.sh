#!/bin/bash
docker exec wechat-agent sh -c '
for pid in $(ls /proc | grep -E "^[0-9]+$"); do
  cmd=$(tr "\0" " " < /proc/$pid/cmdline 2>/dev/null)
  case "$cmd" in
    *node*|*chrom*) echo "PID $pid: $cmd" ;;
  esac
done
'
