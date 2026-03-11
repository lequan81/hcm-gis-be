#!/bin/bash
# ── HCM-GIS Output Cleanup Script ──
# Deletes .mbtiles and .geojson files older than 7 days
# (The backend has a setInterval watcher that detects these deletions
# and automatically closes any open SQLite connections to release handles.)
#
# Usage: ./cleanup-old-files.sh [max_age_days]
# Default: 7 days

set -euo pipefail

MAX_DAYS="${1:-7}"
OUTPUT_DIR="/opt/hcm-gis/hcm-gis-be/output"
LOG_DIR="/opt/hcm-gis/hcm-gis-be/logs"
LOG_FILE="${LOG_DIR}/cleanup_$(date +%Y%m%d_%H%M%S).log"

mkdir -p "$LOG_DIR"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

log "=== Local Cleanup started (max age: ${MAX_DAYS} days) ==="

BEFORE=$(find "$OUTPUT_DIR" -type f \( -name "*.mbtiles" -o -name "*.geojson" \) -mtime +"$MAX_DAYS" 2>/dev/null | wc -l)
log "Files older than ${MAX_DAYS} days: ${BEFORE}"

if [ "$BEFORE" -eq 0 ]; then
  log "Nothing to clean up"
  exit 0
fi

DELETED=0
find "$OUTPUT_DIR" -type f \( -name "*.mbtiles" -o -name "*.geojson" \) -mtime +"$MAX_DAYS" -print0 | while IFS= read -r -d '' file; do
  rm -f "$file"
  log "Deleted: $(basename "$file")"
  DELETED=$((DELETED + 1))
done
log "Manually deleted $DELETED file(s)"

AFTER=$(find "$OUTPUT_DIR" -type f \( -name "*.mbtiles" -o -name "*.geojson" \) 2>/dev/null | wc -l)
log "Remaining files: ${AFTER}"
log "=== Local Cleanup finished ==="
