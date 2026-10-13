#!/bin/bash
# Fetches the 7-Zip binary filesUI bundles, into vendor/7zip/ (gitignored).
# Used by package.sh and deploy.sh; safe to re-run - it does nothing if the
# pinned version is already there.
#
# Unraid ships no 7z/7za/7zz at all, so the plugin carries its own. This is
# upstream 7-Zip's official Linux x64 build from github.com/ip7z/7zip. The
# fully static 7zzs is used rather than 7zz, so it has no dependency on
# whichever glibc a given Unraid release ships; it is installed as bin/7zz.
#
# To upgrade: bump VERSION, set SHA256 to the digest GitHub shows for the
# new linux-x64 asset, and re-run. The checksum is pinned so a swapped or
# corrupted download fails the build instead of shipping.
set -euo pipefail
cd "$(dirname "$0")"

VERSION="26.03"
SHA256="dc99eff5008f1ab79bd7084c68513701547a808a89502bf4133683535ab3c695"
TARBALL="7z${VERSION//./}-linux-x64.tar.xz"
URL="https://github.com/ip7z/7zip/releases/download/${VERSION}/${TARBALL}"

OUT="vendor/7zip"
if [ -x "$OUT/7zz" ] && [ "$(cat "$OUT/VERSION" 2>/dev/null)" = "$VERSION" ]; then
  exit 0
fi

TMP=$(mktemp -d "${TMPDIR:-/tmp}/filesUI-7zip.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

echo "Fetching 7-Zip $VERSION..."
curl -fsSL -o "$TMP/$TARBALL" "$URL"
ACTUAL=$( (sha256sum "$TMP/$TARBALL" 2>/dev/null || shasum -a 256 "$TMP/$TARBALL") | cut -d' ' -f1)
if [ "$ACTUAL" != "$SHA256" ]; then
  echo "7-Zip checksum mismatch: expected $SHA256, got $ACTUAL" >&2
  exit 1
fi

# Only the binary and its licence are needed.
tar -C "$TMP" -xJf "$TMP/$TARBALL" 7zzs License.txt
rm -rf "$OUT"
mkdir -p "$OUT"
mv "$TMP/7zzs" "$OUT/7zz"
mv "$TMP/License.txt" "$OUT/7zip-License.txt"
chmod 755 "$OUT/7zz"
echo "$VERSION" > "$OUT/VERSION"
echo "7-Zip $VERSION ready in $OUT"
