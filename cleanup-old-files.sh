#!/bin/bash
# ── HCM-GIS Output & Log Cleanup Script ──
# Deletes .mbtiles, .geojson, .zip, and .log files older than N hours.
# (The backend also has an internal retention cleanup that runs hourly.)
#
# Usage: ./cleanup-old-files.sh [max_age_hours]
# Default: 24 hours

set -euo pipefail

MAX_HOURS="${1:-24}"
OUTPUT_DIR="/opt/hcm-gis/hcm-gis-be/output"
LOG_DIR="/opt/hcm-gis/hcm-gis-be/logs"
LOG_FILE="${LOG_DIR}/cleanup_$(date +%Y%m%d_%H%M%S).log"

mkdir -p "$LOG_DIR"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

log "=== Cleanup started (max age: ${MAX_HOURS} hours) ==="

# Convert hours to minutes for find -mmin
MAX_MINS=$((MAX_HOURS * 60))

# ── Clean output files ──
BEFORE=$(find "$OUTPUT_DIR" -type f \( -name "*.mbtiles" -o -name "*.geojson" -o -name "*.zip" \) -mmin +"$MAX_MINS" 2>/dev/null | wc -l)
log "Output files older than ${MAX_HOURS}h: ${BEFORE}"

if [ "$BEFORE" -gt 0 ]; then
  find "$OUTPUT_DIR" -type f \( -name "*.mbtiles" -o -name "*.geojson" -o -name "*.zip" \) -mmin +"$MAX_MINS" -print0 | while IFS= read -r -d '' file; do
    rm -f "$file"
    log "Deleted output: $(basename "$file")"
  done
fi

# ── Clean old log files ──
LOG_BEFORE=$(find "$LOG_DIR" -type f -name "*.log" -mmin +"$MAX_MINS" ! -name "$(basename "$LOG_FILE")" 2>/dev/null | wc -l)
log "Log files older than ${MAX_HOURS}h: ${LOG_BEFORE}"

if [ "$LOG_BEFORE" -gt 0 ]; then
  find "$LOG_DIR" -type f -name "*.log" -mmin +"$MAX_MINS" ! -name "$(basename "$LOG_FILE")" -print0 | while IFS= read -r -d '' file; do
    rm -f "$file"
    log "Deleted log: $(basename "$file")"
  done
fi

AFTER_OUTPUT=$(find "$OUTPUT_DIR" -type f \( -name "*.mbtiles" -o -name "*.geojson" -o -name "*.zip" \) 2>/dev/null | wc -l)
AFTER_LOGS=$(find "$LOG_DIR" -type f -name "*.log" 2>/dev/null | wc -l)
log "Remaining: ${AFTER_OUTPUT} output file(s), ${AFTER_LOGS} log file(s)"
log "=== Cleanup finished ==="
