#!/bin/bash
# Builds source/filesUI into a Slackware-style .txz for filesUI.plg to
# download. The archive's internal paths are rooted at / so
# `upgradepkg --install-new` extracts straight to
# /usr/local/emhttp/plugins/filesUI/.
#
# Unlike stacksUI's package.sh there is nothing to vendor - this plugin is
# only PHP, JS and CSS, and depends on nothing outside what the Unraid
# webGUI already ships.
#
# Version follows year.month.day.n (bump n each same-day release, reset to
# 1 on a new day) and lives in exactly one place: filesUI.plg's
# <!ENTITY version ...>. Defaults to that value so the built package and
# the descriptor can never drift out of sync; pass an arg to override.
set -euo pipefail
cd "$(dirname "$0")"

PLG_VERSION=$(grep -o '<!ENTITY version *"[^"]*"' filesUI.plg | sed -E 's/.*"([^"]*)"/\1/')
VERSION="${1:-$PLG_VERSION}"
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE/usr/local/emhttp/plugins"
cp -r source/filesUI "$STAGE/usr/local/emhttp/plugins/filesUI"
find "$STAGE/usr/local/emhttp/plugins/filesUI" -name '.DS_Store' -delete

# Page, assets and includes are read by the webserver, never executed.
find "$STAGE/usr/local/emhttp/plugins/filesUI" -type f -exec chmod 644 {} +
find "$STAGE/usr/local/emhttp/plugins/filesUI" -type d -exec chmod 755 {} +
# nchan/ is the exception: emhttp exec()s these directly, so a 644 here
# means the daemon silently never starts and every file operation hangs.
chmod +x "$STAGE/usr/local/emhttp/plugins/filesUI/nchan/"*

OUT="filesUI-${VERSION}.txz"
tar -C "$STAGE" -cJf "$OUT" usr

echo "Built $OUT"
echo "MD5: $(md5sum "$OUT" 2>/dev/null | cut -d' ' -f1 || md5 -q "$OUT")"
echo
echo "Next: upload $OUT to the '$VERSION' GitHub release, then paste the MD5"
echo "into filesUI.plg's <!ENTITY MD5 ...> before committing."
