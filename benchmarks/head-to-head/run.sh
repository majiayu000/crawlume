#!/bin/sh
# Usage: run.sh <crawlume dist/cli/main.js> <node bin> <out dir> <urls.txt>
set -u
CLI=$1; NODE=$2; OUT=$3; URLS=$4
mkdir -p "$OUT/crawlume" "$OUT/jina"
while read -r id url; do
  start=$(date +%s)
  "$NODE" "$CLI" read "$url" --cache-mode live > "$OUT/crawlume/$id.json" 2>/dev/null
  mid=$(date +%s)
  code=$(curl -s -m 60 -o "$OUT/jina/$id.md" -w '%{http_code}' "https://r.jina.ai/$url")
  end=$(date +%s)
  echo "$id crawlume=$((mid - start))s jina=$((end - mid))s jina_http=$code" | tee -a "$OUT/timing.txt"
  sleep 3
done < "$URLS"
