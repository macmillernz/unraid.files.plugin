<?php
/* filesUI - shared helpers for the file browser backend.
 *
 * Path validation here deliberately mirrors Unraid's own File Manager
 * (dynamix Browse.page::validdir() and Control.php::validname()) rather
 * than inventing a second, subtly-different rule: only /mnt and /boot are
 * reachable, and user-share paths are canonicalised lexically instead of
 * via realpath() so an "exclusive share" symlink
 * (/mnt/user/<share> -> /mnt/<pool>/<share>) doesn't silently relocate the
 * browser out of /mnt/user. Every mutating operation is handed to
 * Control.php, which applies the same check again on its side - this file
 * only gates *reads*.
 */

const FILES_ROOTS = ['mnt', 'boot'];

/**
 * Lexically canonicalise a path: resolve '.' and '..' textually, without
 * touching the filesystem. Used so '..' can never escape the allowed roots
 * even when part of the path doesn't exist yet.
 */
function files_canonical(string $path): string {
  $parts = [];
  foreach (explode('/', $path) as $part) {
    if ($part === '' || $part === '.') continue;
    if ($part === '..') { array_pop($parts); continue; }
    $parts[] = $part;
  }
  return '/'.implode('/', $parts);
}

/**
 * Validate a directory the user asked to browse. Returns '' if it is not
 * an allowed, existing directory.
 */
function files_valid_dir(string $dir): string {
  if ($dir === '') return '';
  $canon = files_canonical($dir);

  // Keep user-share paths as asked (see file header) provided they exist.
  if (preg_match('#^/mnt/(user0?|rootshare)(/|$)#', $canon) && is_dir($canon)) return $canon;

  $real = realpath($canon);
  if ($real === false || !is_dir($real)) return '';
  if (!in_array(explode('/', $real)[1] ?? '', FILES_ROOTS, true)) return '';
  return $real;
}

/**
 * Validate a path that must be an existing *file* (for download/preview).
 */
function files_valid_file(string $path): string {
  if ($path === '') return '';
  $canon = files_canonical($path);

  // A user-share file is reachable at the /mnt/user path even when the
  // share is exclusive; is_file() follows the symlink for us.
  if (preg_match('#^/mnt/(user0?|rootshare)/#', $canon) && is_file($canon)) return $canon;

  $real = realpath($canon);
  if ($real === false || !is_file($real)) return '';
  if (!in_array(explode('/', $real)[1] ?? '', FILES_ROOTS, true)) return '';
  return $real;
}

/**
 * Render a stat() mode as an ls-style permission string, e.g. "drwxr-xr-x".
 */
function files_perms(int $mode): string {
  switch ($mode & 0xF000) {
    case 0xC000: $s = 's'; break; // socket
    case 0xA000: $s = 'l'; break; // symlink
    case 0x8000: $s = '-'; break; // regular
    case 0x6000: $s = 'b'; break; // block special
    case 0x4000: $s = 'd'; break; // directory
    case 0x2000: $s = 'c'; break; // character special
    case 0x1000: $s = 'p'; break; // FIFO
    default:     $s = 'u'; break; // unknown
  }
  $s .= ($mode & 0x0100) ? 'r' : '-';
  $s .= ($mode & 0x0080) ? 'w' : '-';
  $s .= ($mode & 0x0040) ? (($mode & 0x0800) ? 's' : 'x') : (($mode & 0x0800) ? 'S' : '-');
  $s .= ($mode & 0x0020) ? 'r' : '-';
  $s .= ($mode & 0x0010) ? 'w' : '-';
  $s .= ($mode & 0x0008) ? (($mode & 0x0400) ? 's' : 'x') : (($mode & 0x0400) ? 'S' : '-');
  $s .= ($mode & 0x0004) ? 'r' : '-';
  $s .= ($mode & 0x0002) ? 'w' : '-';
  $s .= ($mode & 0x0001) ? (($mode & 0x0200) ? 't' : 'x') : (($mode & 0x0200) ? 'T' : '-');
  return $s;
}

/**
 * Resolve a uid/gid to a name, memoised - a directory of a few thousand
 * entries would otherwise hit the passwd/group databases once per row.
 */
function files_owner(int $uid, int $gid): string {
  static $users = [], $groups = [];
  if (!isset($users[$uid])) {
    $info = function_exists('posix_getpwuid') ? posix_getpwuid($uid) : false;
    $users[$uid] = $info['name'] ?? (string)$uid;
  }
  if (!isset($groups[$gid])) {
    $info = function_exists('posix_getgrgid') ? posix_getgrgid($gid) : false;
    $groups[$gid] = $info['name'] ?? (string)$gid;
  }
  return $users[$uid].':'.$groups[$gid];
}

/**
 * List one directory as plain arrays, ready to be JSON-encoded.
 *
 * Uses lstat() so a symlink reports itself rather than its target, but
 * additionally probes is_dir() so a symlinked directory still navigates
 * like a directory (this is how /mnt/user/<exclusive share> appears).
 *
 * Entries the caller cannot stat (broken symlinks, races with a delete)
 * are skipped rather than aborting the whole listing.
 */
function files_list(string $dir, bool $show_hidden = false): array {
  $out = [];
  $handle = @opendir($dir);
  if ($handle === false) return $out;
  $prefix = rtrim($dir, '/').'/';

  while (($name = readdir($handle)) !== false) {
    if ($name === '.' || $name === '..') continue;
    if (!$show_hidden && $name[0] === '.') continue;
    // Unraid hides its recycle bin from the File Manager; match that.
    if ($name === '.Recycle.Bin') continue;

    $path = $prefix.$name;
    $st = @lstat($path);
    if ($st === false) continue;

    $is_link = ($st['mode'] & 0xF000) === 0xA000;
    $is_dir  = ($st['mode'] & 0xF000) === 0x4000 || ($is_link && @is_dir($path));

    $entry = [
      'name'  => $name,
      'dir'   => $is_dir,
      'size'  => $is_dir ? 0 : (int)$st['size'],
      'mtime' => (int)$st['mtime'],
      'mode'  => files_perms($st['mode']),
      'owner' => files_owner((int)$st['uid'], (int)$st['gid']),
    ];
    if ($is_link) $entry['link'] = @readlink($path) ?: '';
    if (!$is_dir) {
      $dot = strrpos($name, '.');
      $entry['ext'] = ($dot === false || $dot === 0) ? '' : strtolower(substr($name, $dot + 1));
    }
    $out[] = $entry;
  }
  closedir($handle);
  return $out;
}

/**
 * Child directories of $dir, for lazily expanding a node in the left tree.
 * 'kids' reports whether the child itself has any subdirectory, so the UI
 * can decide whether to draw an expand arrow without a second round trip.
 */
function files_subdirs(string $dir): array {
  $out = [];
  $handle = @opendir($dir);
  if ($handle === false) return $out;
  $prefix = rtrim($dir, '/').'/';

  while (($name = readdir($handle)) !== false) {
    if ($name === '.' || $name === '..' || $name === '.Recycle.Bin') continue;
    if ($name[0] === '.') continue;
    $path = $prefix.$name;
    if (!@is_dir($path)) continue;
    $out[] = ['name' => $name, 'path' => $path, 'kids' => files_has_subdir($path)];
  }
  closedir($handle);
  usort($out, fn($a, $b) => strnatcasecmp($a['name'], $b['name']));
  return $out;
}

/**
 * Whether $dir contains at least one visible subdirectory. Stops at the
 * first hit instead of listing the whole directory - this runs once per
 * tree node, and some shares hold tens of thousands of entries.
 */
function files_has_subdir(string $dir): bool {
  $handle = @opendir($dir);
  if ($handle === false) return false;
  $prefix = rtrim($dir, '/').'/';
  $found = false;
  while (($name = readdir($handle)) !== false) {
    if ($name === '.' || $name === '..' || $name[0] === '.') continue;
    if (@is_dir($prefix.$name)) { $found = true; break; }
  }
  closedir($handle);
  return $found;
}

/**
 * The roots shown at the top of the tree: user shares, each array disk and
 * pool, the Unassigned Devices mounts, and the flash drive. Derived from
 * what is actually mounted under /mnt rather than from disks.ini, so pools
 * and UD mounts appear without needing to parse Unraid's config.
 */
function files_roots(): array {
  $roots = [];
  $add = function(string $path, string $label, string $icon) use (&$roots) {
    if (is_dir($path)) $roots[] = ['path' => $path, 'name' => $label, 'icon' => $icon, 'kids' => true];
  };

  $add('/mnt/user', 'User Shares', 'users');
  // /mnt/user0 is deliberately not listed. It is the legacy array-only view
  // of the same shares (everything except what currently sits on a pool),
  // so it appears as a second, near-empty "User Shares" alongside the real
  // one - confusing for the sake of a view that only matters when
  // troubleshooting the mover. Unraid's own File Manager doesn't offer it
  // as a root either. It stays reachable: files_valid_dir() still accepts
  // /mnt/user0 paths, so a copy/move destination can be typed by hand.

  $disks = [];
  foreach (glob('/mnt/*', GLOB_ONLYDIR) ?: [] as $path) {
    $name = basename($path);
    if (in_array($name, ['user', 'user0', 'rootshare', 'disks', 'remotes', 'addons'], true)) continue;
    $disks[] = $name;
  }
  natsort($disks);
  foreach ($disks as $name) {
    $icon = preg_match('/^disk\d+$/', $name) ? 'hdd-o' : 'database';
    $roots[] = ['path' => "/mnt/$name", 'name' => $name, 'icon' => $icon, 'kids' => true];
  }

  $add('/mnt/disks', 'Unassigned Devices', 'usb');
  $add('/mnt/remotes', 'Remote Shares', 'cloud');
  $add('/boot', 'Flash', 'bolt');

  return $roots;
}

/**
 * Map a file extension to the Font Awesome 4 icon name used in the list.
 * Font Awesome 4 is what the Unraid GUI already loads, so this sticks to
 * icons that exist in that version.
 */
function files_icon(string $ext): string {
  static $map = null;
  if ($map === null) {
    $map = [];
    $groups = [
      'file-image-o'   => ['jpg','jpeg','png','gif','bmp','svg','webp','ico','tif','tiff','heic','avif'],
      'file-video-o'   => ['mp4','mkv','avi','mov','wmv','flv','webm','m4v','mpg','mpeg','ts','m2ts'],
      'file-audio-o'   => ['mp3','flac','wav','aac','ogg','m4a','wma','opus','aiff'],
      'file-archive-o' => ['zip','tar','gz','bz2','xz','7z','rar','tgz','txz','zst','iso'],
      'file-pdf-o'     => ['pdf'],
      'file-word-o'    => ['doc','docx','odt','rtf'],
      'file-excel-o'   => ['xls','xlsx','ods','csv'],
      'file-powerpoint-o' => ['ppt','pptx','odp'],
      'file-code-o'    => ['php','js','ts','html','htm','css','py','sh','bash','c','h','cpp','go','rs','rb','java','pl','sql','yml','yaml','json','xml','ini','cfg','conf','toml','page','plg'],
      'file-text-o'    => ['txt','log','md','nfo','bak','old'],
    ];
    foreach ($groups as $icon => $exts) foreach ($exts as $e) $map[$e] = $icon;
  }
  return $map[$ext] ?? 'file-o';
}
