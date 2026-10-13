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

/**
 * Whether $name is a single, safe path component: no separators, no
 * traversal, no NUL. Used for anything the client names inside a folder.
 */
function files_valid_name(string $name): bool {
  return $name !== '' && $name !== '.' && $name !== '..'
    && strpos($name, '/') === false && strpos($name, "\0") === false;
}

/* ------------------------------------------------------------------ 7-Zip
 *
 * One archive job runs at a time, tracked in FILES_ARCHIVE_STATE and run
 * by scripts/archive (see that file for the state-file layout). A finished
 * job's result stays until the UI dismisses it, so a page reload - or a
 * second browser - still learns how it ended.
 */

const FILES_ARCHIVE_STATE = '/var/tmp/filesUI.archive';

/**
 * The 7-Zip binary to use, or '' if none is found. Unraid ships none, so
 * the plugin bundles upstream 7-Zip as bin/7zz (see fetch-7zip.sh) and
 * that is what normally answers. A system 7zz/7z/7za is only a fallback,
 * for a dev box synced without the vendored binary.
 */
function files_7z_binary(): string {
  $bundled = dirname(__DIR__).'/bin/7zz';
  if (is_file($bundled) && is_executable($bundled)) return $bundled;
  foreach (['7zz', '7z', '7za'] as $name) {
    foreach (['/usr/bin', '/usr/local/bin', '/bin'] as $dir) {
      if (is_file("$dir/$name") && is_executable("$dir/$name")) return "$dir/$name";
    }
  }
  return '';
}

/**
 * Current archive job: state is 'idle', 'running' or 'done'. A running
 * job carries a percent (or null before 7z reports one); a done job
 * carries rc and, on failure, the tail of 7z's output.
 */
function files_archive_status(): array {
  $s = FILES_ARCHIVE_STATE;
  $job = @json_decode(@file_get_contents("$s/job") ?: '', true);
  if (!is_array($job)) return ['state' => 'idle', 'available' => files_7z_binary() !== ''];

  $out = ['state' => 'running', 'title' => $job['title'] ?? '', 'mode' => $job['mode'] ?? '', 'target' => $job['target'] ?? ''];
  $rc = @file_get_contents("$s/rc");
  $pid = (int)@file_get_contents("$s/pid");

  if ($rc === false) {
    // No exit code yet: running if the script is alive, or if it was only
    // just launched and hasn't written its pid. Anything else died without
    // reporting (killed by OOM, a reboot of emhttp) and counts as failed.
    $alive = $pid > 0 ? file_exists("/proc/$pid") : (time() - (int)($job['started'] ?? 0) < 10);
    if ($alive) {
      $out['percent'] = files_archive_percent("$s/log");
      return $out;
    }
    $rc = '-1';
  }

  $out['state'] = 'done';
  $out['rc'] = (int)trim($rc);
  // 7z: 0 ok, 1 warning (e.g. a file changed while being read) - both
  // produced a usable result. 130 is our own cancel.
  if ($out['rc'] > 1 && $out['rc'] !== 130) $out['error'] = files_archive_errors("$s/log");
  return $out;
}

/** Last percentage 7z printed. The log is \b-redrawn progress, so only the tail matters. */
function files_archive_percent(string $log): ?int {
  $size = @filesize($log);
  if (!$size) return null;
  $tail = @file_get_contents($log, false, null, max(0, $size - 4096));
  return preg_match_all('/(\d{1,3})%/', (string)$tail, $m) ? min(100, (int)end($m[1])) : null;
}

/** The meaningful end of 7z's output, with progress redraws removed. */
function files_archive_errors(string $log): string {
  $size = (int)@filesize($log);
  $text = (string)@file_get_contents($log, false, null, max(0, $size - 16384));
  $lines = [];
  foreach (preg_split('/[\r\n\x08]+/', $text) as $line) {
    $line = trim($line);
    if ($line === '' || preg_match('/^\d+%/', $line)) continue;
    $lines[] = $line;
  }
  $msg = implode("\n", array_slice($lines, -15));
  return $msg !== '' ? $msg : '7-Zip exited without saying why.';
}

/** Launch scripts/archive detached, in its own session so cancel can kill the whole group. */
function files_archive_start(string $bin, string $mode, string $archive, array $args, string $title): void {
  files_archive_clear();
  $s = FILES_ARCHIVE_STATE;
  @mkdir($s, 0700, true);
  file_put_contents("$s/job", json_encode([
    'mode' => $mode, 'title' => $title, 'target' => $archive, 'started' => time(),
  ]));

  $cmd = array_map('escapeshellarg', array_merge(
    [__DIR__.'/../scripts/archive', $s, $bin, $mode, $archive], $args));
  exec('setsid nohup /bin/bash '.implode(' ', $cmd).' >/dev/null 2>&1 &');
}

function files_archive_cancel(): void {
  $pid = (int)@file_get_contents(FILES_ARCHIVE_STATE.'/pid');
  // The script leads its own process group (setsid), so this reaches 7z
  // too; the script's TERM trap then cleans up and writes rc=130.
  if ($pid > 1 && !file_exists(FILES_ARCHIVE_STATE.'/rc')) @exec("kill -TERM -- -$pid 2>/dev/null");
}

/** Forget a finished job. Never removes a running one's state. */
function files_archive_clear(): void {
  $s = FILES_ARCHIVE_STATE;
  if (files_archive_status()['state'] === 'running') return;
  foreach (['job', 'pid', 'log', 'rc', 'marker'] as $f) @unlink("$s/$f");
}
