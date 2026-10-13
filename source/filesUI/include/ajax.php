<?PHP
/* filesUI - JSON API for the browser panes.
 *
 * Reads (list, tree, roots, stat, usage) are served here. Every
 * *destructive or long-running* operation - delete, rename, copy, move,
 * chown, chmod, search, upload, and folder creation - is posted by the
 * frontend straight to Unraid's own /webGui/include/Control.php, which
 * queues it for the dynamix file_manager daemon. This plugin deliberately
 * does not carry a second copy of that engine, and inherits its job queue,
 * rsync progress and nchan status publishing unchanged.
 *
 * The one exception is `mkfile`, which creates a single empty file.
 * Unraid's own file manager cannot create files at all, so there is no
 * action code to delegate to. It is handled here because it is atomic and
 * instantaneous - routing a touch(2) through the job queue would make it
 * wait behind an in-flight 200GB copy for no reason. It still applies the
 * same /mnt-and-/boot gate as every read, and sets the same ownership and
 * mode Unraid gives an uploaded file (nobody:users, 0666) so a new file in
 * a share is usable over SMB rather than root-owned.
 *
 * The other exception is 7-Zip compress/extract - see the archive section
 * below.
 *
 * CSRF for POSTs is already enforced globally by
 * webGui/include/local_prepend.php (php.ini auto_prepend_file) before this
 * script runs; re-checking here would see the already-stripped token and
 * reject everything. Same finding as stacksUI's ajax.php. mkfile is
 * POST-only precisely so it sits behind that guard.
 */

require_once __DIR__ . '/FilesHelper.php';

header('Content-Type: application/json');
// Listings are per-request state; a cached one would show stale contents
// after an operation completes.
header('Cache-Control: no-store');

function files_fail(string $message, int $code = 400) {
  http_response_code($code);
  exit(json_encode(['error' => $message]));
}

$action = $_REQUEST['action'] ?? '';
// Paths arrive rawurlencoded so that '#', '?', '+' and friends in real
// filenames survive the query string intact.
$path   = rawurldecode($_REQUEST['path'] ?? '');

switch ($action) {

case 'roots':
  exit(json_encode(['roots' => files_roots()]));

case 'list':
  $dir = files_valid_dir($path);
  if ($dir === '') files_fail('Not a readable directory under /mnt or /boot');
  if (!is_readable($dir)) files_fail('Permission denied', 403);

  $hidden  = ($_REQUEST['hidden'] ?? '') === '1';
  $entries = files_list($dir, $hidden);

  // Attach the display icon server-side so the client doesn't need its own
  // copy of the extension map.
  foreach ($entries as &$entry) {
    $entry['icon'] = $entry['dir'] ? 'folder' : files_icon($entry['ext'] ?? '');
  }
  unset($entry);

  exit(json_encode([
    'path'    => $dir,
    'parent'  => $dir === '/' ? '' : dirname($dir),
    'entries' => $entries,
  ]));

case 'tree':
  $dir = files_valid_dir($path);
  if ($dir === '') files_fail('Not a readable directory under /mnt or /boot');
  exit(json_encode(['path' => $dir, 'dirs' => files_subdirs($dir)]));

case 'stat':
  // Used by the details pane; accepts either a file or a directory.
  $target = files_valid_file($path);
  if ($target === '') $target = files_valid_dir($path);
  if ($target === '') files_fail('No such file or directory', 404);
  $st = @lstat($target);
  if ($st === false) files_fail('Cannot stat', 404);
  exit(json_encode([
    'path'  => $target,
    'name'  => basename($target),
    'dir'   => is_dir($target),
    'size'  => (int)$st['size'],
    'mtime' => (int)$st['mtime'],
    'ctime' => (int)$st['ctime'],
    'mode'  => files_perms($st['mode']),
    'owner' => files_owner((int)$st['uid'], (int)$st['gid']),
  ]));

case 'usage':
  // Free/used space for the filesystem holding $path, for the status bar.
  $dir = files_valid_dir($path);
  if ($dir === '') files_fail('Not a readable directory under /mnt or /boot');
  $total = @disk_total_space($dir);
  $free  = @disk_free_space($dir);
  if ($total === false || $free === false) exit(json_encode(['total' => 0, 'free' => 0]));
  exit(json_encode(['total' => (int)$total, 'free' => (int)$free]));

case 'engine':
  /* Is Unraid's file-operation engine actually running?
   *
   * Every queued action (create/delete/rename/copy/move/chown/chmod) is
   * executed by the dynamix file_manager daemon, not by the web request.
   * If it isn't running, jobs pile up in /var/tmp/file.manager.active and
   * nothing happens - with no error anywhere, which is exactly how this
   * shipped broken once already (the plugin's nchan hook was missing, so
   * emhttp had nothing to exec). The UI calls this on load so the failure
   * is stated plainly instead of looking like every button is dead.
   *
   * Matches the engine's real command line, not this plugin's supervisor
   * wrapper, which shares the file_manager basename. */
  $out = [];
  $rc = 0;
  @exec("pgrep -f 'php .*webGui/nchan/file_manager$' 2>/dev/null", $out, $rc);
  exit(json_encode([
    'running' => $rc === 0 && !empty($out),
    'queued'  => file_exists('/var/tmp/file.manager.active'),
  ]));

case 'mkfile':
  // POST-only, so Unraid's global CSRF guard applies (see file header).
  if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') files_fail('POST required', 405);

  $dir = files_valid_dir($path);
  if ($dir === '') files_fail('Not a writable directory under /mnt or /boot');

  $name = rawurldecode($_POST['name'] ?? '');
  // A single path component only - no separators, no traversal, no NUL.
  if ($name === '' || $name === '.' || $name === '..'
      || strpos($name, '/') !== false || strpos($name, "\0") !== false) {
    files_fail('Invalid file name');
  }
  if (strlen($name) > 255) files_fail('File name is too long');

  $target = $dir.'/'.$name;
  if (file_exists($target)) files_fail('Something with that name already exists', 409);
  if (!is_writable($dir)) files_fail('Directory is not writable', 403);

  // Create empty and exclusive: 'x' fails rather than truncating if the
  // name appeared between the check above and here.
  $handle = @fopen($target, 'x');
  if ($handle === false) files_fail('Could not create the file', 500);
  fclose($handle);

  // Match what Control.php's uploader gives an uploaded file, so a file
  // created here behaves the same over SMB/NFS as one dropped in.
  @chmod($target, 0666);
  @chown($target, 'nobody');
  @chgrp($target, 'users');

  exit(json_encode(['path' => $target, 'name' => $name]));

/* ---------------------------------------------------------------- 7-Zip
 *
 * Compress and extract are the second exception to "every mutation goes
 * through Control.php": Unraid's file_manager daemon has no archive action
 * code to delegate to. They run as this plugin's own background job via
 * scripts/archive, one at a time box-wide, with progress read back from
 * 7z's own -bsp1 output. See FilesHelper.php's archive helpers.
 */

case 'archive_status':
  exit(json_encode(files_archive_status()));

case 'compress':
case 'extract':
case 'archive_cancel':
case 'archive_dismiss':
  // POST-only, so Unraid's global CSRF guard applies (see file header).
  if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') files_fail('POST required', 405);

  if ($action === 'archive_cancel') {
    files_archive_cancel();
    exit(json_encode(['ok' => true]));
  }
  if ($action === 'archive_dismiss') {
    files_archive_clear();
    exit(json_encode(['ok' => true]));
  }

  $bin = files_7z_binary();
  if ($bin === '') files_fail('The bundled 7-Zip binary is missing - reinstall the filesUI plugin.', 501);
  if (files_archive_status()['state'] === 'running') files_fail('Another archive job is already running.', 409);

  if ($action === 'compress') {
    $dir = files_valid_dir($path);
    if ($dir === '') files_fail('Not a directory under /mnt or /boot');
    if (!is_writable($dir)) files_fail('Directory is not writable', 403);

    // Sources are names inside $dir, one per line - never paths, so the
    // archive can't be pointed at anything outside the folder on screen.
    $names = array_values(array_filter(explode("\n", rawurldecode($_POST['names'] ?? '')), 'strlen'));
    if (!$names) files_fail('Nothing selected');
    foreach ($names as $n) {
      if (!files_valid_name($n)) files_fail('Invalid item name: '.$n);
      if (!file_exists($dir.'/'.$n) && !is_link($dir.'/'.$n)) files_fail('No such item: '.$n, 404);
    }

    $format = rawurldecode($_POST['format'] ?? '7z');
    if (!in_array($format, ['7z', 'zip'], true)) files_fail('Unsupported format');

    $archive = rawurldecode($_POST['name'] ?? '');
    if (!files_valid_name($archive)) files_fail('Invalid archive name');
    if (strlen($archive) > 255) files_fail('Archive name is too long');
    $target = $dir.'/'.$archive;
    if (file_exists($target)) files_fail('Something with that name already exists', 409);

    files_archive_start($bin, 'compress', $target,
      array_merge([$format, $dir], $names),
      'Compressing to '.$archive);
    exit(json_encode(['ok' => true]));
  }

  // extract
  $archive = files_valid_file($path);
  if ($archive === '') files_fail('Not a file under /mnt or /boot', 404);

  // The destination may not exist yet (the default is a new folder named
  // after the archive), so validate its parent and the final component.
  $dest = files_canonical(rawurldecode($_POST['dest'] ?? ''));
  $parent = files_valid_dir(dirname($dest));
  if ($parent === '' || !files_valid_name(basename($dest))) {
    files_fail('Destination must be a folder under /mnt or /boot');
  }
  $dest = $parent.'/'.basename($dest);
  if (file_exists($dest) && !is_dir($dest)) files_fail('Destination exists and is not a folder', 409);
  if (!is_writable($parent)) files_fail('Destination is not writable', 403);

  $overwrite = rawurldecode($_POST['overwrite'] ?? '') === '1' ? '1' : '0';
  files_archive_start($bin, 'extract', $archive, [$dest, $overwrite],
    'Extracting '.basename($archive));
  exit(json_encode(['ok' => true]));

default:
  files_fail('Unknown action');
}
