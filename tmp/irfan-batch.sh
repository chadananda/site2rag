#!/usr/bin/env bash
# Batch-submit irfancolloquia.org PDFs to SLP, worst-score first, 10 in-flight max.
DB="/tank/site2rag/websites_mirror/irfancolloquia.org/_meta/site.sqlite"
API="http://localhost:7840"
PASS="vanilla1844"
SITE="irfancolloquia.org"
MAX_INFLIGHT=10
POLL_SEC=30
LOG="/tank/site2rag/irfan-batch.log"

log() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG"; }

get_token() {
  curl -s -X POST "$API/api/auth" -H "Authorization: Bearer $PASS" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('token',''))"
}

TOKEN=$(get_token)
if [ -z "$TOKEN" ]; then log "Auth failed — exiting"; exit 1; fi
log "Authenticated. Starting batch for $SITE"

submitted=0
while true; do
  INFLIGHT=$(sqlite3 "$DB" "SELECT COUNT(*) FROM pdf_upgrade_queue WHERE status IN ('pending','submitted')")
  DONE=$(sqlite3 "$DB" "SELECT COUNT(*) FROM pdf_upgrade_queue WHERE status='done'")
  TOTAL_UNQUEUED=$(sqlite3 "$DB" "SELECT COUNT(*) FROM pages p LEFT JOIN pdf_upgrade_queue u ON p.url=u.url WHERE p.gone=0 AND p.mime_type='application/pdf' AND u.url IS NULL")

  log "In-flight: $INFLIGHT | Done: $DONE | Unqueued: $TOTAL_UNQUEUED | Submitted this run: $submitted"

  if [ "$TOTAL_UNQUEUED" -eq 0 ] && [ "$INFLIGHT" -eq 0 ]; then
    log "All done. Exiting."
    exit 0
  fi

  SLOTS=$(( MAX_INFLIGHT - INFLIGHT ))
  if [ "$SLOTS" -gt 0 ] && [ "$TOTAL_UNQUEUED" -gt 0 ]; then
    URLS=$(sqlite3 "$DB" "
      SELECT p.url FROM pages p
      LEFT JOIN pdf_quality q ON p.url=q.url
      LEFT JOIN pdf_upgrade_queue u ON p.url=u.url
      WHERE p.gone=0 AND p.mime_type='application/pdf' AND u.url IS NULL
      ORDER BY COALESCE(q.composite_score, 1.0) ASC
      LIMIT $SLOTS
    ")
    while IFS= read -r url; do
      [ -z "$url" ] && continue
      ENCODED=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "$url")
      RESULT=$(curl -s -X POST "$API/api/docs/upgrade?site=$SITE&url=$ENCODED" \
        -H "Authorization: Bearer $TOKEN")
      OK=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('ok','false'))" 2>/dev/null)
      if [ "$OK" = "True" ] || [ "$OK" = "true" ]; then
        log "  submitted: $(basename "$url")"
        submitted=$((submitted+1))
      else
        log "  FAILED: $url -> $RESULT"
      fi
    done <<< "$URLS"
  fi

  sleep "$POLL_SEC"
done
