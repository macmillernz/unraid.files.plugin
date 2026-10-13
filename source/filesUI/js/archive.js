/* filesUI - 7-Zip compress and extract.
 *
 * Unraid's file_manager daemon has no archive action, so unlike copy/move
 * these run as this plugin's own background job (include/ajax.php +
 * scripts/archive) and there is no nchan channel to follow. Progress is
 * polled instead, from the percentage 7z itself prints. One archive job
 * runs at a time box-wide; it shares the progress strip with the other
 * operations but owns its Cancel button while it runs, as the uploader
 * does.
 */

window.filesUI = window.filesUI || {};

(function (app) {
  'use strict';

  var POLL = 1000;

  var progressEl, barEl, textEl, titleEl, cancelEl;
  var running = false;
  var timer = null;

  /* Extensions 7-Zip can open. Multi-part suffixes come first so that
     "x.tar.gz" is recognised whole when proposing a folder name. */
  var ARCHIVE_EXT = /\.(tar\.gz|tar\.bz2|tar\.xz|tar\.zst|7z|zip|rar|tar|gz|tgz|bz2|tbz2|xz|txz|zst|lzma|cab|iso|arj|lzh|wim|z)$/i;

  function isArchive(item) {
    return !item.dir && ARCHIVE_EXT.test(item.name);
  }

  function stem(name) {
    return name.replace(ARCHIVE_EXT, '') || name;
  }

  /* ------------------------------------------------------- progress */

  function initProgress() {
    if (progressEl) return;
    progressEl = document.getElementById('filesUI-progress');
    barEl      = document.getElementById('filesUI-progress-bar');
    textEl     = document.getElementById('filesUI-progress-text');
    titleEl    = document.getElementById('filesUI-progress-title');
    cancelEl   = document.getElementById('filesUI-progress-cancel');
  }

  function showProgress(title) {
    initProgress();
    running = true;
    titleEl.textContent = title;
    textEl.textContent = 'Starting…';
    barEl.style.width = '0%';
    barEl.classList.add('indeterminate');
    progressEl.hidden = false;
    cancelEl.onclick = confirmCancel;
    app.setBusy(true);
  }

  function hideProgress() {
    running = false;
    clearTimeout(timer);
    timer = null;
    if (!progressEl) return;
    progressEl.hidden = true;
    barEl.classList.remove('indeterminate');
    cancelEl.onclick = null;
    app.setBusy(false);
  }

  function confirmCancel() {
    app.modal.confirm({
      title: 'Cancel archive job?',
      body: '<p>7-Zip will be stopped. A partly written new archive is removed; '
          + 'files already extracted stay where they are.</p>',
      confirmLabel: 'Stop it',
      danger: true,
      onConfirm: function () {
        app.archiveCancel().catch(function (err) {
          app.modal.alert('Could not cancel', app.escapeHtml(err.message));
        });
      }
    });
  }

  function poll() {
    app.archiveStatus().then(function (status) {
      if (status.state === 'running') {
        if (!running) showProgress(status.title);
        titleEl.textContent = status.title;
        if (status.percent != null) {
          barEl.classList.remove('indeterminate');
          barEl.style.width = status.percent + '%';
          textEl.textContent = status.percent + '%';
        }
        timer = setTimeout(poll, POLL);
        return;
      }
      if (status.state === 'done') finished(status);
      else if (running) hideProgress();
    }).catch(function () {
      // A dropped request mid-job shouldn't abandon it; keep trying.
      if (running) timer = setTimeout(poll, POLL * 3);
    });
  }

  function finished(status) {
    hideProgress();
    app.archiveDismiss().catch(function () { /* next job clears it anyway */ });
    app.refresh();

    var name = app.basename(status.target || '');
    if (status.rc === 130) {
      app.setStatus('Archive job cancelled.');
    } else if (status.error) {
      app.modal.alert(status.mode === 'extract' ? 'Extract failed' : 'Compress failed',
        '<pre class="filesUI-source-list">' + app.escapeHtml(status.error) + '</pre>');
    } else {
      app.setStatus((status.mode === 'extract' ? 'Extracted ' : 'Created ') + name
        + (status.rc === 1 ? ' (with warnings)' : '') + '.');
    }
  }

  function launch(promise, title) {
    return promise.then(function () {
      showProgress(title);
      timer = setTimeout(poll, 300);
    }).catch(function (err) {
      app.modal.alert('Archive job failed', app.escapeHtml(err.message));
    });
  }

  /* -------------------------------------------------------- dialogs */

  function compress(dir, items) {
    var names = items.map(function (i) { return i.name; });
    var base = items.length === 1
      ? (items[0].dir ? items[0].name : items[0].name.replace(/\.[^.]+$/, '') || items[0].name)
      : app.basename(dir);

    app.modal.open({
      title: 'Compress' + (items.length > 1 ? ' ' + items.length + ' items' : ''),
      body: '<div class="filesUI-source-list">'
          + names.slice(0, 200).map(app.escapeHtml).join('\n')
          + (names.length > 200 ? '\n… and ' + (names.length - 200) + ' more' : '')
          + '</div>'
          + '<label class="filesUI-field">Archive name'
          + '<input type="text" id="filesUI-archive-name" autocomplete="off" value="'
          + app.escapeHtml(base + '.7z') + '"></label>'
          + '<label class="filesUI-field">Format'
          + '<select id="filesUI-archive-format">'
          + '<option value="7z">7z (best compression)</option>'
          + '<option value="zip">zip (opens anywhere without extra software)</option>'
          + '</select></label>'
          + '<p class="filesUI-hint">Created in ' + app.escapeHtml(dir) + '</p>',
      onOpen: function (body) {
        var input  = body.querySelector('#filesUI-archive-name');
        var format = body.querySelector('#filesUI-archive-format');
        // Keep the extension in step with the format unless the user has
        // typed something else entirely.
        format.addEventListener('change', function () {
          input.value = input.value.replace(/\.(7z|zip)$/i, '') + '.' + format.value;
        });
        var dot = input.value.lastIndexOf('.');
        input.focus();
        if (dot > 0) input.setSelectionRange(0, dot);
      },
      buttons: [
        { label: 'Cancel' },
        {
          label: 'Compress',
          action: function () {
            if (running) { app.modal.error('Another archive job is already running.'); return false; }
            var name = document.getElementById('filesUI-archive-name').value.trim();
            var format = document.getElementById('filesUI-archive-format').value;
            if (!name) { app.modal.error('Enter a name.'); return false; }
            if (name.indexOf('/') !== -1) { app.modal.error('A name cannot contain "/".'); return false; }
            launch(app.compress(dir, names, name, format), 'Compressing to ' + name);
          }
        }
      ]
    });
  }

  function extract(item) {
    var dir = app.dirname(item.path);

    app.modal.open({
      title: 'Extract ' + item.name,
      body: '<label class="filesUI-field">Extract to'
          + '<input type="text" id="filesUI-extract-dest" autocomplete="off" value="'
          + app.escapeHtml(app.join(dir, stem(item.name))) + '"></label>'
          + '<p class="filesUI-hint">The folder is created if it doesn\'t exist. '
          + 'Clear the last part to extract straight into ' + app.escapeHtml(dir) + '.</p>'
          + '<div class="filesUI-picker" id="filesUI-picker"></div>'
          + '<label class="filesUI-field" style="margin-top:12px">'
          + '<input type="checkbox" id="filesUI-extract-overwrite"> Overwrite files that already exist</label>',
      onOpen: function (root) {
        var input = root.querySelector('#filesUI-extract-dest');
        var picker = new app.Tree(root.querySelector('#filesUI-picker'), {
          onSelect: function (path) { input.value = path; }
        });
        picker.load();
      },
      buttons: [
        { label: 'Cancel' },
        {
          label: 'Extract',
          action: function () {
            if (running) { app.modal.error('Another archive job is already running.'); return false; }
            var dest = document.getElementById('filesUI-extract-dest').value.trim().replace(/\/+$/, '');
            if (!/^\/(mnt|boot)\/./.test(dest)) { app.modal.error('Destination must be under /mnt or /boot.'); return false; }
            var overwrite = document.getElementById('filesUI-extract-overwrite').checked;
            launch(app.extract(item.path, dest, overwrite), 'Extracting ' + item.name);
          }
        }
      ]
    });
  }

  app.archive = {
    isArchive: isArchive,
    isRunning: function () { return running; },
    compress: compress,
    extract: extract,
    /* Pick up a job that was already running when the page loaded - from
       before a reload, or started in another browser. */
    resume: function () { poll(); }
  };

}(window.filesUI));
