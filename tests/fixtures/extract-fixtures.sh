#!/usr/bin/env bash
# Extract fixture PDFs from tower-nas production documents.
# Run this to refresh fixtures when source documents change or to add new ones.
# Usage: bash tests/fixtures/extract-fixtures.sh [tower-nas-host]
#
# Output: tests/fixtures/pdfs/*.pdf  (1-2 pages each, <2MB total)
# Requires: ssh access to tower-nas, gs (ghostscript) on this machine

set -e
NAS="${1:-tower-nas}"
OUT="$(dirname "$0")/pdfs"
mkdir -p "$OUT"

extract() {
  local NAME="$1" SRC="$2" FIRST="${3:-1}" LAST="${4:-2}"
  local TMP="$OUT/${NAME}.tmp.pdf"
  echo "  fetching $NAME..."
  scp -q "$NAS:$SRC" "$TMP"
  gs -q -dBATCH -dNOPAUSE -sDEVICE=pdfwrite \
     -dCompatibilityLevel=1.4 -dPDFSETTINGS=/ebook \
     -dFirstPage="$FIRST" -dLastPage="$LAST" \
     -sOutputFile="$OUT/${NAME}.pdf" "$TMP"
  rm "$TMP"
  echo "    -> $(du -sh "$OUT/${NAME}.pdf" | cut -f1)"
}

echo "Extracting fixtures from $NAS..."

# English digital-born text PDF — high quality baseline
extract "eng-text-clean" \
  "/tank/site2rag/websites_mirror/bahai-library.com/pdf/s/smith_blumenthal_inner_freedom.pdf" 1 2

# English image-only scan — needs OCR, no text layer
extract "eng-image-scan" \
  "/tank/site2rag/websites_mirror/blog.loomofreality.org/wp-content/uploads/2023/12/Caravan_Oct_2023_On_the_Interconnectedness_of_Science_and_Religion.pdf" 1 2

# Persian PDF with garbled text layer (custom font encoding)
extract "per-image-printed" \
  "/tank/site2rag/websites_mirror/irfancolloquia.org/pdf/safini12_sahba_danesh-binesh.pdf" 1 2

# Arabic PDF with garbled text layer
extract "ara-image-scan" \
  "/tank/site2rag/websites_mirror/hurqalya.ucmerced.edu/sites/hurqalya.ucmerced.edu/files/page/documents/ridwan_al-adl.pdf" 1 2

# Handwritten Arabic/Persian manuscript — near-zero OCR confidence expected
extract "handwriting" \
  "/tank/site2rag/websites_mirror/adibmasumian.com/wp-content/uploads/2024/01/original_bahaullah_tablet_khadijih_khazei.pdf" 1 1

# Multi-column English 1931 newsletter
extract "eng-multicol" \
  "/tank/site2rag/websites_mirror/afnanlibrary.org/_assets/73/73e5154e3241fedc132a8e462a268b627ba402a28df60409a3841ec2cc968682.pdf" 1 2

echo ""
echo "Done. Fixture sizes:"
du -sh "$OUT/"*.pdf
echo ""
echo "Run: npm test -- tests/fixtures.test.js"
