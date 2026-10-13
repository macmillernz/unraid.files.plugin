# Files UI

An Unraid plugin that adds a **Files** tab: a two-pane file browser with a
lazily-loaded folder tree on the left and a sortable file list on the right.

Scope is the same as Unraid's built-in File Manager — `/mnt` (user shares,
array disks, pools, unassigned devices, remote shares) and `/boot` (the flash
drive). Nothing outside those roots is reachable.

## What it does

- **Browse** — folder tree on the left, file list on the right, with a
  clickable breadcrumb, sortable columns (name, size, modified, owner,
  permissions), a live filter box, and a resizable split.
- **Act** — create, rename, delete, copy, move, change owner, change
  permissions, and calculate occupied space. All work on a single item or a
  multi-selection, from the toolbar or a right-click menu. **New** creates a
  folder, or an empty file if the name you type has an extension
  (`notes.txt`, `.env`) — the dialog says which as you type.
- **Preview** — selecting a file slides a preview panel out from the left,
  between the tree and the list, so nothing is hidden. Images, video, audio,
  PDFs and text/code render inline; anything else shows a metadata card with
  a Download button. `Space` toggles it, arrow keys move it through the
  folder, `Esc` closes it.
- **Archive** — compress a selection to `.7z` or `.zip`, or extract an
  archive (7z, zip, rar, tar, gz, xz, iso…) into a folder, using 7-Zip on
  the server. Runs in the background with progress and cancel; results are
  owned by `nobody:users`. Unraid has no 7-Zip, so the plugin bundles
  upstream 7-Zip's static Linux build (pinned and checksum-verified by
  `fetch-7zip.sh`).
- **Transfer** — upload by button or drag-and-drop (chunked, with progress,
  speed and cancel); download a single file (streamed, resumable) or a
  multi-selection/folder (streamed as a zip, built on the fly).
- **Keyboard** — arrows to move, `Enter` to open, `Space` to preview,
  `Backspace` to go up, `Delete`, `F2` to rename, `Ctrl/Cmd+A` to select all,
  `/` to jump to the filter, `Esc` to close the preview then clear the
  selection.

The current folder is kept in the URL hash, so a reload or a bookmark comes
back to the same place.

## How it reuses the Unraid GUI

This plugin deliberately does **not** ship its own file-operation engine.
Every destructive or long-running action is posted to Unraid's own
`/webGui/include/Control.php`, which queues a job for the dynamix
`file_manager` daemon — the same path the built-in File Manager uses. That
means:

- copy and move report real `rsync` progress, speed and ETA, published on
  the `/sub/filemanager` nchan channel and rendered here;
- uploads land with Unraid's expected ownership (`nobody:users`, `0666`) and
  its `file (1).txt` de-duplication, all handled server-side;
- the `/mnt`-and-`/boot` restriction and the "don't mix user shares with disk
  paths" rule are enforced by Unraid's code, not just by this UI;
- operations queue behind each other, because Unraid runs one file operation
  box-wide at a time.

The one exception is creating an empty **file**, which Unraid's file manager
cannot do at all — there is no action code to delegate to. That is handled by
this plugin's own `mkfile` endpoint, which applies the same `/mnt`-and-`/boot`
gate and gives the new file the same `nobody:users` / `0666` that Unraid gives
an uploaded one. It is POST-only so Unraid's global CSRF guard covers it.

Styling comes from Unraid's own CSS custom properties, so the plugin follows
whichever theme is selected rather than looking static regardless of it.

The `Nchan="file_manager"` line in `Files.page` is what starts that daemon
while the tab is open — without it, jobs queue and never run.

**That declaration needs `source/filesUI/nchan/file_manager` to exist.**
emhttp resolves `Nchan=` against the *plugin's own* directory
(`nchan_merge()` in `dynamix/template.php` sets `$nchan_run = "$root/nchan"`),
not against dynamix's copy — so without that file the exec fails silently
and every operation hangs forever with no error. The shipped script is a
supervisor rather than a copy of the engine: it starts Unraid's own
`webGui/nchan/file_manager` only when no instance is running, which also
prevents a second engine when the built-in File Manager is open alongside
this tab. It must be executable — `package.sh` and `deploy.sh` both chmod
it, since everything else in the plugin is deliberately 644.

The Files tab checks the engine on load and says so in the status bar if it
is not running, so this failure mode can never be silent again.

Unraid's built-in File Manager is left exactly where it is. This plugin
patches no menus and hides no tabs.

## Layout

```
filesUI.plg                  plugin descriptor; <!ENTITY version> is the
                             single source of truth for the version
package.sh                   builds source/filesUI into a .txz for release
deploy.sh                    rsyncs source/filesUI to a dev box, no packaging
fetch-7zip.sh                downloads the pinned 7-Zip into vendor/ (gitignored)
source/filesUI/
  Files.page                 the tab: frontmatter + markup
  css/filesUI.css
  js/api.js                  fetch wrappers, Control.php calls, formatting
  js/modal.js                the one reusable dialog shell
  js/contextMenu.js          right-click menu
  js/tree.js                 folder tree (also used as the copy/move picker)
  js/preview.js              preview flyout
  js/operations.js           operation dialogs + nchan progress
  js/transfer.js             chunked upload, download
  js/archive.js              7-Zip compress/extract dialogs + progress polling
  js/filesUI.js              main controller: list, selection, keyboard
  include/FilesHelper.php    path validation, listing, stat formatting
  include/ajax.php           JSON API: reads, plus mkfile and 7-Zip jobs
  include/download.php       streamed download / on-the-fly zip
  scripts/archive            runs one 7-Zip job in the background (run via
                             bash, so it needs no execute bit)
  nchan/file_manager         supervisor that keeps Unraid's file-operation
                             engine running (required - see above)
  images/files.png           plugin icon
```

## Development

Fast iteration against a real box — rsyncs the source straight into the
plugin directory, no packaging step:

```bash
FILES_UI_HOST=root@10.0.60.3 ./deploy.sh
```

This is dev-only and does **not** survive a reboot: `/usr/local/emhttp` is
rebuilt from OS packages at every boot. Use the real install for anything
persistent.

The tab list is cached per session, so after the first deploy you may need to
force-refresh or log out and back in before **Files** appears.

## Releasing

1. Bump `<!ENTITY version>` in `filesUI.plg` (`year.month.day.n`).
2. Build:

```bash
./package.sh
```

3. Upload the printed `.txz` to a GitHub release tagged with that version.
4. Paste the printed MD5 into `filesUI.plg`'s `<!ENTITY MD5>` and commit.

Users then install by pasting the raw URL of `filesUI.plg` into
**Plugins → Install Plugin**.
