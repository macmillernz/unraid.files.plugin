<?PHP
/* filesUI - file download.
 *
 * A GET endpoint rather than POST, because the download has to be driven
 * by real browser navigation (a hidden <a download> / iframe) for the
 * native save dialog and progress UI to appear at all.
 *
 * Unraid's global CSRF guard in local_prepend.php only covers POST, so the
 * token is checked explicitly here. The whole webGUI already sits behind
 * nginx session auth, so this is defence in depth rather than the only
 * gate - but without it any page the user visits could trigger arbitrary
 * reads of their array by pointing an <img>/<iframe> at this URL.
 *
 * Two modes:
 *   path=<file>                 - stream that one file, with Range support
 *                                 so media players can seek and interrupted
 *                                 downloads can resume.
 *   dir=<dir>&names[]=a&names[]=b - stream a zip of the named entries,
 *                                 built by piping `zip` to stdout so a
 *                                 100GB selection never lands on disk or
 *                                 in memory first.
 *
 * Adding inline=1 to the single-file mode serves the file for *display*
 * rather than download: a real Content-Type so <img>/<video>/<audio> and
 * the PDF viewer can render it, and Content-Disposition: inline. That is
 * what the preview panel loads. See download_inline_headers() for why it
 * is locked down with CSP and nosniff.
 */

require_once __DIR__ . '/FilesHelper.php';

function download_fail(string $message, int $code) {
  http_response_code($code);
  header('Content-Type: text/plain');
  exit($message);
}

$var = @parse_ini_file('/usr/local/emhttp/state/var.ini');
$token = $_GET['csrf_token'] ?? '';
if (empty($var['csrf_token']) || !hash_equals($var['csrf_token'], $token)) {
  download_fail('Invalid csrf_token', 403);
}

// A large zip of a slow array can legitimately outlive the default limit.
set_time_limit(0);
// The client's own connection is the backpressure; if they cancel we want
// the zip subprocess torn down rather than left running to completion.
ignore_user_abort(false);

/**
 * Emit Content-Disposition with both a plain and a UTF-8 filename, so
 * non-ASCII names survive in browsers that support RFC 5987 and degrade to
 * a sane ASCII fallback in those that don't.
 */
function download_disposition(string $name, string $mode = 'attachment'): void {
  $ascii = preg_replace('/[^\x20-\x7E]/', '_', $name);
  $ascii = str_replace(['"', '\\'], '_', $ascii);
  header('Content-Disposition: '.$mode.'; filename="'.$ascii.'"; '
       . "filename*=UTF-8''".rawurlencode($name));
}

/**
 * Content-Type for inline display. Only types a browser can actually
 * render are listed; anything else stays application/octet-stream, which
 * the preview panel treats as "no preview available".
 */
function download_mime(string $ext): string {
  static $map = [
    'jpg'=>'image/jpeg', 'jpeg'=>'image/jpeg', 'png'=>'image/png',
    'gif'=>'image/gif',  'webp'=>'image/webp', 'bmp'=>'image/bmp',
    'svg'=>'image/svg+xml', 'ico'=>'image/x-icon', 'avif'=>'image/avif',
    'mp4'=>'video/mp4', 'webm'=>'video/webm', 'ogv'=>'video/ogg',
    'mov'=>'video/quicktime', 'mkv'=>'video/x-matroska', 'm4v'=>'video/mp4',
    'mp3'=>'audio/mpeg', 'm4a'=>'audio/mp4', 'aac'=>'audio/aac',
    'wav'=>'audio/wav', 'flac'=>'audio/flac', 'ogg'=>'audio/ogg',
    'opus'=>'audio/ogg',
    'pdf'=>'application/pdf',
  ];
  return $map[$ext] ?? 'application/octet-stream';
}

/**
 * Headers shared by every inline response.
 *
 * The CSP matters: an SVG (or any file the browser decides to treat as
 * markup) served from this same origin could otherwise run script with the
 * user's authenticated Unraid session. `sandbox` drops the response into an
 * opaque origin with scripting disabled, so a hostile file sitting on the
 * array cannot do anything when previewed. nosniff stops the browser
 * second-guessing the Content-Type we set.
 */
function download_inline_headers(): void {
  header('Content-Security-Policy: sandbox');
  header('X-Content-Type-Options: nosniff');
}

$dir = rawurldecode($_GET['dir'] ?? '');

// ---------------------------------------------------------------- zip mode
if ($dir !== '') {
  $base = files_valid_dir($dir);
  if ($base === '') download_fail('Not a readable directory under /mnt or /boot', 400);

  $names = $_GET['names'] ?? [];
  if (!is_array($names) || !$names) download_fail('Nothing selected', 400);

  // Names are single path components chosen from a listing of $base. Reject
  // anything containing a separator so a crafted request cannot reach
  // outside the directory the user is actually looking at.
  $valid = [];
  foreach ($names as $raw) {
    $name = rawurldecode((string)$raw);
    if ($name === '' || $name === '.' || $name === '..') continue;
    if (strpos($name, '/') !== false || strpos($name, "\0") !== false) {
      download_fail('Invalid selection', 400);
    }
    if (!file_exists($base.'/'.$name)) continue;
    $valid[] = $name;
  }
  if (!$valid) download_fail('Nothing selected', 400);
  $args = array_map('escapeshellarg', $valid);

  // Name the archive after the folder, or after the single entry when
  // that's all that survived validation.
  $label = count($valid) === 1
    ? pathinfo($valid[0], PATHINFO_FILENAME)
    : basename($base);
  if ($label === '' || $label === '/') $label = 'download';

  header('Content-Type: application/zip');
  download_disposition($label.'.zip');
  // Length is unknown up front when streaming, so the browser shows an
  // indeterminate progress bar - the tradeoff for not staging the archive.
  header('X-Accel-Buffering: no');

  // -0 (store, no compression): the bulk of what people pull off an array
  // is already-compressed media, so deflating it burns CPU for ~0 gain and
  // caps throughput well below disk speed. -r recurses into folders.
  $cmd = 'cd '.escapeshellarg($base).' && exec zip -0 -r -q - '.implode(' ', $args).' 2>/dev/null';
  $pipe = popen($cmd, 'r');
  if ($pipe === false) download_fail('Could not start zip', 500);

  while (!feof($pipe)) {
    $chunk = fread($pipe, 1 << 20);
    if ($chunk === false || $chunk === '') break;
    echo $chunk;
    flush();
    if (connection_aborted()) break;
  }
  pclose($pipe);
  exit;
}

// -------------------------------------------------------- single-file mode
$file = files_valid_file(rawurldecode($_GET['path'] ?? ''));
if ($file === '') download_fail('Not a readable file under /mnt or /boot', 404);

$size = filesize($file);
$fh = @fopen($file, 'rb');
if ($fh === false) download_fail('Permission denied', 403);

$start = 0;
$end   = $size - 1;
$range = $_SERVER['HTTP_RANGE'] ?? '';

if ($range !== '' && preg_match('/^bytes=(\d*)-(\d*)$/', trim($range), $m)) {
  if ($m[1] === '' && $m[2] === '') {
    // "bytes=-" is malformed; fall through and serve the whole file.
  } elseif ($m[1] === '') {
    // Suffix range: the last N bytes.
    $start = max(0, $size - (int)$m[2]);
  } else {
    $start = (int)$m[1];
    if ($m[2] !== '') $end = min((int)$m[2], $size - 1);
  }

  if ($start > $end || $start >= $size) {
    fclose($fh);
    http_response_code(416);
    header("Content-Range: bytes */$size");
    exit;
  }
  http_response_code(206);
  header("Content-Range: bytes $start-$end/$size");
}

$inline = ($_GET['inline'] ?? '') === '1';
if ($inline) {
  $dot = strrpos(basename($file), '.');
  $ext = $dot === false ? '' : strtolower(substr(basename($file), $dot + 1));
  header('Content-Type: '.download_mime($ext));
  download_disposition(basename($file), 'inline');
  download_inline_headers();
} else {
  header('Content-Type: application/octet-stream');
  download_disposition(basename($file));
}
header('Accept-Ranges: bytes');
header('Content-Length: '.($end - $start + 1));
header('X-Accel-Buffering: no');

if ($start > 0) fseek($fh, $start);
$remaining = $end - $start + 1;
while ($remaining > 0 && !feof($fh)) {
  $chunk = fread($fh, (int)min(1 << 20, $remaining));
  if ($chunk === false || $chunk === '') break;
  echo $chunk;
  $remaining -= strlen($chunk);
  flush();
  if (connection_aborted()) break;
}
fclose($fh);
