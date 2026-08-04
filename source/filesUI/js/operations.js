/* filesUI - file/folder operation dialogs and progress monitoring.
 *
 * Every operation here is handed to Unraid's Control.php, which writes a
 * job for the dynamix file_manager daemon; the daemon publishes progress
 * on the nchan channel /sub/filemanager, which this module subscribes to.
 * That means copy/move get real rsync percentages, speed and ETA without
 * this plugin implementing any of it.
 *
 * Unraid runs one file operation box-wide at a time, so each dialog offers
 * Queue alongside Start exactly as the built-in File Manager does.
 */

window.filesUI = window.filesUI || {};

(function (app) {
  'use strict';

  var A = app.ACTION;

  var progressEl, barEl, textEl, titleEl, cancelEl;
  var running = false;
  var subscriber = null;
  var watchdog = null;

  /* How long to wait for any word from the file_manager daemon before
     assuming the operation is already over. Short operations (mkdir,
     rename, deleting a handful of files) routinely finish before the nchan
     subscription is even established, so without this the progress panel
     would sit at "Starting…" indefinitely with no way out but Cancel -
     which would post a kill for a job that no longer exists. Each status
     message resets the timer, so a genuinely long copy is never cut off. */
  var SILENCE_TIMEOUT = 12000;

  /* ------------------------------------------------------- validation */

  /* Unraid refuses to mix user-share and disk paths in one operation,
     because writing to /mnt/diskN behind FUSE's back while /mnt/user is
     also in play can corrupt the share. Browse.page enforces this in the
     UI; the same rule is reproduced here.

     Returns null when fine, or an explanatory string. */
  function mixedRootProblem(paths) {
    var user = false, disk = false;
    paths.forEach(function (path) {
      var parts = path.split('/');           // ['', 'mnt', 'user', ...]
      if (parts[1] !== 'mnt') return;
      if (/^(user0?|rootshare)$/.test(parts[2] || '')) user = true;
      else if (!/^(disks|remotes)$/.test(parts[2] || '')) disk = true;
    });
    if (user && disk) {
      return 'Not allowed to mix user shares and disk paths in one operation.';
    }
    return null;
  }

  /* Whether `target` is a legal destination for `sources`, using the same
     shape of rule Browse.page applies. */
  function targetProblem(sources, target) {
    if (!target) return 'Enter a destination.';
    if (!/^\/(mnt|boot)\//.test(target)) return 'Destination must be under /mnt or /boot.';

    var first = (sources[0] || '').split('/');
    var isUser = first[1] === 'mnt' && /^(user0?|rootshare)$/.test(first[2] || '');
    var isUD   = first[1] === 'mnt' && /^(disks|remotes)$/.test(first[2] || '');

    if (!isUD) {
      var targetIsUser = /^\/mnt\/(user0?|rootshare)\//.test(target);
      if (isUser && !targetIsUser && !/^\/mnt\/(disks|remotes)\//.test(target)) {
        return 'A user-share source can only be copied or moved to another user share, or to an unassigned device.';
      }
      if (!isUser && targetIsUser) {
        return 'A disk path cannot be copied or moved into /mnt/user - go via the disk path instead.';
      }
    }

    // Moving a folder inside itself would recurse forever; the daemon
    // catches this too but only after the job has already started.
    for (var i = 0; i < sources.length; i++) {
      if ((target + '/').indexOf(sources[i].replace(/\/+$/, '') + '/') === 0) {
        return 'Cannot copy or move a folder into itself.';
      }
    }
    return null;
  }

  /* ---------------------------------------------------- dialog pieces */

  function sourceListHtml(items) {
    var shown = items.slice(0, 200).map(function (item) {
      return app.escapeHtml(item.path || item);
    }).join('\n');
    if (items.length > 200) shown += '\n… and ' + (items.length - 200) + ' more';
    return '<div class="filesUI-source-list">' + shown + '</div>';
  }

  function warningHtml(text) {
    return '<div class="filesUI-warning"><i class="fa fa-warning"></i><span>'
      + app.escapeHtml(text) + '</span></div>';
  }

  /* Start/Queue/Cancel button triple shared by the long-running dialogs. */
  function operationButtons(title, validate, run) {
    return [
      { label: 'Cancel' },
      {
        label: 'Queue',
        action: function () {
          var params = validate();
          if (!params) return false;
          run(params, true);
        }
      },
      {
        label: 'Start',
        action: function () {
          if (running) {
            app.modal.error('Another operation is already running. Use Queue instead.');
            return false;
          }
          var params = validate();
          if (!params) return false;
          run(params, false);
        }
      }
    ];
  }

  function submit(action, title, sources, target, options, queue) {
    var call = queue ? app.queueOperation : app.startOperation;
    return call.call(app, action, title, sources, target, options)
      .then(function () {
        if (queue) {
          app.setStatus(title + ' queued.');
        } else {
          beginProgress(title);
        }
        // Give a fast operation (mkdir, rename) a moment to land before
        // re-reading, so the list doesn't refresh to its pre-change state.
        setTimeout(function () { app.refresh(); }, 400);
      })
      .catch(function (err) {
        app.modal.alert('Operation failed', app.escapeHtml(err.message));
      });
  }

  /* --------------------------------------------------------- progress */

  function initProgress() {
    if (progressEl) return;
    progressEl = document.getElementById('filesUI-progress');
    barEl      = document.getElementById('filesUI-progress-bar');
    textEl     = document.getElementById('filesUI-progress-text');
    titleEl    = document.getElementById('filesUI-progress-title');
    cancelEl   = document.getElementById('filesUI-progress-cancel');

    cancelEl.addEventListener('click', function () {
      app.modal.confirm({
        title: 'Cancel operation?',
        body: '<p>The running operation will be stopped. Anything already copied or moved stays where it is.</p>',
        confirmLabel: 'Stop it',
        danger: true,
        onConfirm: function () {
          app.cancelOperation().then(function () {
            endProgress();
            setTimeout(function () { app.refresh(); }, 500);
          });
        }
      });
    });
  }

  function beginProgress(title) {
    initProgress();
    running = true;
    titleEl.textContent = title;
    textEl.textContent  = 'Starting…';
    barEl.style.width   = '0%';
    barEl.classList.add('indeterminate');
    progressEl.hidden = false;
    app.setBusy(true);
    resetWatchdog();
  }

  function resetWatchdog() {
    clearTimeout(watchdog);
    watchdog = setTimeout(function () {
      // Nothing heard for a while - treat the operation as finished and
      // re-read the folder, which is the source of truth either way.
      endProgress();
      app.setStatus('');
      app.refresh();
    }, SILENCE_TIMEOUT);
  }

  function endProgress() {
    clearTimeout(watchdog);
    watchdog = null;
    if (!progressEl) return;
    running = false;
    progressEl.hidden = true;
    barEl.classList.remove('indeterminate');
    app.setBusy(false);
  }

  /* Subscribe to the daemon's status channel. The payload is the JSON the
     file_manager daemon builds: { action, text: [...] } plus a 'done' flag
     and optional 'error' on the final message. */
  function startMonitor() {
    if (typeof NchanSubscriber === 'undefined') {
      // Without nchan we simply lose live progress; operations still run.
      return;
    }
    subscriber = new NchanSubscriber('/sub/filemanager', { subscriber: 'websocket' });
    subscriber.on('message', function (payload) {
      var data;
      try { data = payload ? JSON.parse(payload) : null; } catch (e) { return; }
      if (!data) return;

      if (data.status) {
        var status;
        try { status = JSON.parse(data.status); } catch (e) { return; }
        // A job started from another browser tab (or another user) still
        // shows here, since the channel is box-wide - surface it rather
        // than silently ignoring an operation that blocks this one.
        if (!running) beginProgress('Working…');
        else resetWatchdog();
        renderStatus(status);
      }

      if (data.error) {
        app.modal.alert('Operation reported an error', '<pre class="filesUI-source-list">'
          + app.escapeHtml(data.error) + '</pre>');
      }

      if (data.done) {
        endProgress();
        app.setStatus('Operation finished.');
        app.refresh();
        // A queued job starts as soon as the previous one clears, so ask
        // Unraid to promote the next one rather than leaving it waiting.
        app.control({ mode: 'start' });
      }
    });

    // Delay slightly, as Browse.page does - the socket races page setup
    // otherwise and the first connect fails.
    setTimeout(function () { subscriber.start(); }, 1200);
  }

  /* The daemon's text[1] line looks like
     "Completed: 43%,  Speed: 58.59MB/s,  ETA: 3:47:20,  Total: ~37.9GB" */
  function renderStatus(status) {
    var text = (status.text || []).filter(Boolean);
    if (!text.length) return;

    var percent = null;
    var joined = text.join('   ');
    var match = /(\d+)%/.exec(joined);
    if (match) percent = parseInt(match[1], 10);

    if (percent !== null) {
      barEl.classList.remove('indeterminate');
      barEl.style.width = percent + '%';
    } else {
      barEl.classList.add('indeterminate');
    }

    titleEl.textContent = text[0];
    textEl.textContent  = text[1] || '';
    textEl.title        = text.join('  ');
  }

  /* ------------------------------------------------------- operations */

  var ops = {};

  /* Whether a typed name should produce a file rather than a folder.
   *
   * "notes.txt" -> file, "Holiday Photos" -> folder. A leading-dot name
   * with nothing after it (".env", ".gitignore") counts as a file too:
   * those are overwhelmingly files, and treating them as folders because
   * the dot happens to be first would be surprising. The dialog shows
   * which one it is going to create as you type, so the rule never has to
   * be guessed at. */
  function looksLikeFile(name) {
    return /[^/.]\.[^.]+$/.test(name) || /^\.[^.]+$/.test(name);
  }
  ops.looksLikeFile = looksLikeFile;

  ops.create = function (dir) {
    app.modal.open({
      title: 'New',
      body: '<label class="filesUI-field">Name'
          + '<input type="text" id="filesUI-newname" autocomplete="off" placeholder="Reports  or  notes.txt"></label>'
          + '<p class="filesUI-hint" id="filesUI-newkind">'
          + 'Add an extension to create a file, or leave it off to create a folder.</p>'
          + '<p class="filesUI-hint">In ' + app.escapeHtml(dir) + '</p>',
      onOpen: function (body) {
        var input = body.querySelector('#filesUI-newname');
        var kind  = body.querySelector('#filesUI-newkind');
        input.addEventListener('input', function () {
          var name = input.value.trim();
          if (!name) {
            kind.textContent = 'Add an extension to create a file, or leave it off to create a folder.';
          } else if (looksLikeFile(name)) {
            kind.innerHTML = 'Creates an empty <strong>file</strong> named '
              + app.escapeHtml(name) + '.';
          } else {
            kind.innerHTML = 'Creates a <strong>folder</strong> named '
              + app.escapeHtml(name) + '.';
          }
        });
      },
      buttons: [
        { label: 'Cancel' },
        {
          label: 'Create',
          action: function () {
            var name = document.getElementById('filesUI-newname').value.trim();
            if (!name) { app.modal.error('Enter a name.'); return false; }
            if (name.indexOf('/') !== -1) { app.modal.error('A name cannot contain "/".'); return false; }
            if (name === '.' || name === '..') { app.modal.error('That name is not allowed.'); return false; }

            if (looksLikeFile(name)) {
              // Creating a file is instantaneous, so it bypasses Unraid's
              // job queue entirely - see include/ajax.php's header.
              app.makeFile(dir, name).then(function () {
                app.setStatus('Created ' + name);
                app.refresh();
              }).catch(function (err) {
                app.modal.alert('Could not create file', app.escapeHtml(err.message));
              });
              return true;
            }
            submit(A.CREATE_FOLDER, 'Create', [dir], name, {}, false);
          }
        }
      ]
    });
  };

  ops.rename = function (item) {
    var action = item.dir ? A.RENAME_FOLDER : A.RENAME_FILE;
    app.modal.open({
      title: 'Rename',
      body: '<label class="filesUI-field">New name'
          + '<input type="text" id="filesUI-newname" autocomplete="off" value="'
          + app.escapeHtml(item.name) + '"></label>',
      onOpen: function (body) {
        // Preselect the stem only, so an extension isn't clobbered by
        // typing over the whole selection.
        var input = body.querySelector('#filesUI-newname');
        var dot = item.dir ? -1 : item.name.lastIndexOf('.');
        input.focus();
        if (dot > 0) input.setSelectionRange(0, dot); else input.select();
      },
      buttons: [
        { label: 'Cancel' },
        {
          label: 'Rename',
          action: function () {
            var name = document.getElementById('filesUI-newname').value.trim();
            if (!name) { app.modal.error('Enter a name.'); return false; }
            if (name.indexOf('/') !== -1) { app.modal.error('A name cannot contain "/".'); return false; }
            if (name === item.name) return true;   // nothing to do
            submit(action, 'Rename', [item.path], name, {}, false);
          }
        }
      ]
    });
  };

  ops.remove = function (items) {
    var folders = items.some(function (i) { return i.dir; });
    var paths   = items.map(function (i) { return i.path; });
    var label   = items.length === 1
      ? app.escapeHtml(items[0].name)
      : items.length + ' items';

    app.modal.open({
      title: 'Delete ' + (items.length === 1 ? (items[0].dir ? 'folder' : 'file') : 'items'),
      body: warningHtml(folders
              ? 'This permanently deletes the selected items, including everything inside any folders.'
              : 'This permanently deletes the selected files.')
          + '<p>Delete ' + label + '?</p>'
          + sourceListHtml(items),
      buttons: [
        { label: 'Cancel' },
        {
          label: 'Queue',
          action: function () {
            submit(folders ? A.DELETE_FOLDER : A.DELETE_FILE, 'Delete', paths, '', {}, true);
          }
        },
        {
          label: 'Delete',
          danger: true,
          action: function () {
            if (running) { app.modal.error('Another operation is already running. Use Queue instead.'); return false; }
            submit(folders ? A.DELETE_FOLDER : A.DELETE_FILE, 'Delete', paths, '', {}, false);
          }
        }
      ]
    });
  };

  /* Copy and move share a dialog: a destination picker (a second Tree
     instance), an editable path, and the overwrite/sparse toggles Unraid's
     own dialog offers. */
  function transferDialog(kind, items) {
    var isMove  = kind === 'move';
    var folders = items.some(function (i) { return i.dir; });
    var paths   = items.map(function (i) { return i.path; });

    var mixed = mixedRootProblem(paths);
    if (mixed) { app.modal.alert('Invalid selection', app.escapeHtml(mixed)); return; }

    var action = isMove
      ? (folders ? A.MOVE_FOLDER : A.MOVE_FILE)
      : (folders ? A.COPY_FOLDER : A.COPY_FILE);
    var title = isMove ? 'Move' : 'Copy';

    var body = document.createElement('div');
    body.innerHTML =
        warningHtml(isMove
          ? 'Moving removes the items from their current location once the transfer succeeds.'
          : 'Copying leaves the originals in place.')
      + sourceListHtml(items)
      + '<label class="filesUI-field">Destination'
      + '<input type="text" id="filesUI-target" autocomplete="off" placeholder="/mnt/user/…"></label>'
      + '<div class="filesUI-picker" id="filesUI-picker"></div>'
      + '<label class="filesUI-field" style="margin-top:12px">'
      + '<input type="checkbox" id="filesUI-overwrite"> Overwrite files that already exist at the destination</label>'
      + '<label class="filesUI-field">'
      + '<input type="checkbox" id="filesUI-sparse"> Handle sparse files efficiently (slower, for VM disk images)</label>';

    app.modal.open({
      title: title + (items.length > 1 ? ' ' + items.length + ' items' : ''),
      body: body,
      onOpen: function (root) {
        var input  = root.querySelector('#filesUI-target');
        var picker = new app.Tree(root.querySelector('#filesUI-picker'), {
          onSelect: function (path) { input.value = path; }
        });
        picker.load();
      },
      buttons: operationButtons(title,
        function () {
          var target = document.getElementById('filesUI-target').value.trim();
          var problem = targetProblem(paths, target);
          if (problem) { app.modal.error(problem); return false; }
          return {
            target: target,
            options: {
              overwrite: document.getElementById('filesUI-overwrite').checked,
              sparse:    document.getElementById('filesUI-sparse').checked
            }
          };
        },
        function (params, queue) {
          submit(action, title, paths, params.target, params.options, queue);
        })
    });
  }

  ops.copy = function (items) { transferDialog('copy', items); };
  ops.move = function (items) { transferDialog('move', items); };

  ops.owner = function (items) {
    var paths = items.map(function (i) { return i.path; });
    app.modal.open({
      title: 'Change Owner',
      body: warningHtml('This applies recursively to everything inside any selected folder.')
          + sourceListHtml(items)
          + '<label class="filesUI-field">Owner'
          + '<select id="filesUI-owner">'
          + '<option value="nobody">nobody (normal share content)</option>'
          + '<option value="root">root</option>'
          + '</select></label>',
      buttons: operationButtons('Change Owner',
        function () {
          var owner = document.getElementById('filesUI-owner').value;
          // Control.php expects owner:group; Unraid pairs root with root
          // and everything else with the 'users' group.
          return { target: owner + (owner === 'root' ? ':root' : ':users') };
        },
        function (params, queue) {
          submit(A.CHOWN, 'Change Owner', paths, params.target, {}, queue);
        })
    });
  };

  ops.permissions = function (items) {
    var paths = items.map(function (i) { return i.path; });

    /* These clause strings are taken verbatim from Unraid's own permission
       dialog (dynamix include/Templates.php). They matter: the daemon runs
       `chmod -Rfv <target>`, and in symbolic chmod a bare "u-rw" *removes*
       read and write rather than setting them. Unraid's form is
       remove-then-add - "u-x+rw" clears execute and grants read+write - so
       the result is an absolute permission rather than a relative edit.
       Getting this wrong strips a file to ---------- , which is exactly
       what an earlier version of this dialog did.

       Only these three levels are offered, matching Unraid: an explicit
       execute bit is deliberately not exposed, because the ",ugo+X"
       appended below restores traversal on directories without marking
       every file executable. */
    var LEVELS = [
      { value: '-rwx',   label: 'No Access'  },
      { value: '-wx+r',  label: 'Read-only'  },
      { value: '-x+rw',  label: 'Read/Write' }
    ];

    /* Map the current mode's three characters for one class onto the level
       that best describes them, so the dialog opens showing what the file
       actually is. */
    function levelFor(bits) {
      var r = bits.indexOf('r') !== -1;
      var w = bits.indexOf('w') !== -1;
      if (r && w) return '-x+rw';
      if (r)      return '-wx+r';
      return '-rwx';
    }

    // Seed from the first selection's current mode, e.g. "-rw-r--r--".
    var mode = (items[0] && items[0].mode) || '';
    // A mixed selection has no single current value to show, so fall back
    // to Read/Write rather than implying they all match the first one.
    var uniform = items.every(function (i) { return i.mode === mode; });

    function classField(id, label, letter, offset) {
      var current = uniform ? levelFor(mode.substr(offset, 3)) : '-x+rw';
      var html = '<label class="filesUI-field">' + label + '<select id="' + id + '">';
      LEVELS.forEach(function (level) {
        html += '<option value="' + letter + level.value + '"'
             + (level.value === current ? ' selected' : '') + '>' + level.label + '</option>';
      });
      return html + '</select></label>';
    }

    app.modal.open({
      title: 'Change Permissions',
      body: warningHtml('This applies recursively to everything inside any selected folder.')
          + sourceListHtml(items)
          + '<div class="filesUI-perm-grid">'
          + classField('filesUI-perm-u', 'Owner',  'u', 1)
          + classField('filesUI-perm-g', 'Group',  'g', 4)
          + classField('filesUI-perm-o', 'Others', 'o', 7)
          + '</div>',
      buttons: operationButtons('Change Permissions',
        function () {
          var target = [
            document.getElementById('filesUI-perm-u').value,
            document.getElementById('filesUI-perm-g').value,
            document.getElementById('filesUI-perm-o').value
          ].join(',') + ',ugo+X';
          return { target: target };
        },
        function (params, queue) {
          submit(A.CHMOD, 'Change Permissions', paths, params.target, {}, queue);
        })
    });
  };

  /* Occupied-space calculation is synchronous on Unraid's side and returns
     ready-made translated HTML, so it bypasses the job queue entirely. */
  ops.calculateSize = function (items) {
    var paths = items.map(function (i) { return i.path; });
    app.setStatus('Calculating…');
    app.setBusy(true);
    app.calculateSize(paths).then(function (html) {
      app.setBusy(false);
      app.setStatus('');
      app.modal.alert('Occupied Space', html);
    }).catch(function (err) {
      app.setBusy(false);
      app.setStatus('');
      app.modal.alert('Calculation failed', app.escapeHtml(err.message));
    });
  };

  ops.isRunning = function () { return running; };
  ops.startMonitor = startMonitor;

  app.ops = ops;

}(window.filesUI));
