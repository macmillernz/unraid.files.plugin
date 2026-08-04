#!/bin/bash
# Dev-cycle deploy: rsync source/filesUI straight to a real Unraid test
# box's plugin dir, skipping the .plg/.txz packaging step entirely.
# Requires SSH access to the box.
#
# Note: this is dev-only convenience - it does NOT survive a reboot on its
# own (/usr/local/emhttp is rebuilt from OS packages every boot). For a
# real persistent install use package.sh + upgradepkg (see README).
#
# Usage:
#   FILES_UI_HOST=root@10.0.60.3 ./deploy.sh
set -euo pipefail
cd "$(dirname "$0")"

: "${FILES_UI_HOST:?Set FILES_UI_HOST to user@host of the test box}"

rsync -av --delete --exclude '.DS_Store' \
  source/filesUI/ "${FILES_UI_HOST}:/usr/local/emhttp/plugins/filesUI/"

ssh "${FILES_UI_HOST}" '
  find /usr/local/emhttp/plugins/filesUI -type f -exec chmod 644 {} +
  find /usr/local/emhttp/plugins/filesUI -type d -exec chmod 755 {} +
  # emhttp exec()s the nchan hooks directly - without +x the file-operation
  # engine never starts and every action hangs. See source/filesUI/nchan/.
  chmod +x /usr/local/emhttp/plugins/filesUI/nchan/*
  mkdir -p /boot/config/plugins/filesUI
'

echo "Deployed to ${FILES_UI_HOST}."
echo "Open the Files tab. The tab list is cached per-session, so if it does"
echo "not appear yet, force-refresh the page or log out and back in."
