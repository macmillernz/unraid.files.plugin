/* filesUI - upload and download.
 *
 * Upload posts raw binary chunks to Unraid's own Control.php?mode=upload,
 * the same endpoint and the same 20MB chunk size the built-in File Manager
 * uses, so uploads land with Unraid's expected ownership (nobody:users,
 * 0666) and its "file (1).txt" de-duplication - all handled server-side.
 *
 * Download goes to this plugin's own download.php rather than linking
 * straight at the path: that gives a correct Content-Disposition (so
 * browsers save rather than render), Range support for resuming, and
 * streamed zips for multi-selections, none of which a bare path link does.
 */

window.filesUI = window.filesUI || {};

(function (app) {
  'use strict';

  var CHUNK = 20 * 1024 * 1024;   // 20MB, matching dynamix Browse.page

  var progressEl, barEl, textEl, titleEl, cancelEl;
  var state = null;   // { files, index, offset, xhr, cancelled, started, sentBefore }

  function initProgress() {
    if (progressEl) return;
    progressEl = document.getElementById('filesUI-progress');
    barEl      = document.getElementById('filesUI-progress-bar');
    textEl     = document.getElementById('filesUI-progress-text');
    titleEl    = document.getElementById('filesUI-progress-title');
    cancelEl   = document.getElementById('filesUI-progress-cancel');
  }

  function totalBytes(files) {
    var total = 0;
    for (var i = 0; i < files.length; i++) total += files[i].size;
    return total;
  }

  function showProgress() {
    initProgress();
    progressEl.hidden = false;
    barEl.classList.remove('indeterminate');
    // The uploader owns the cancel button while an upload is in flight.
    cancelEl.onclick = cancelUpload;
    app.setBusy(true);
    // Guard against navigating away mid-upload, which would leave a
    // truncated file on the array.
    window.onbeforeunload = function () { return ''; };
  }

  function hideProgress() {
    if (progressEl) progressEl.hidden = true;
    cancelEl.onclick = null;
    app.setBusy(false);
    window.onbeforeunload = null;
  }

  function render() {
    var sent = state.sentBefore + state.offset;
    var total = state.total;
    var percent = total ? Math.floor(sent / total * 100) : 0;
    var elapsed = (Date.now() - state.started) / 1000;
    var speed = elapsed > 0 ? app.formatSize(sent / elapsed) + '/s' : '';

    barEl.style.width = percent + '%';
    titleEl.textContent = 'Uploading ' + (state.index + 1) + ' of ' + state.files.length;
    textEl.textContent = percent + '%   ' + speed + '   '
      + state.files[state.index].name;
    textEl.title = state.files[state.index].name;
  }

  function cancelUpload() {
    if (!state) return;
    state.cancelled = true;
    if (state.xhr) state.xhr.abort();
  }

  /* Ask Unraid to drop the partial file and its bookkeeping temp file.
     `cancel=1` is what makes Control.php delete what was written so far. */
  function abortServerSide(file) {
    return app.control({
      mode: 'upload',
      file: app.enc(app.join(state.dir, file.name)),
      start: 0,
      cancel: 1
    }).catch(function () { /* best effort - the UI is finishing regardless */ });
  }

  /* Clear the per-file temp marker after a file completes successfully. */
  function clearTemp(name) {
    return app.control({ mode: 'stop', file: app.enc(name) })
      .catch(function () { /* best effort */ });
  }

  function finish(message, isError) {
    var wasCancelled = state && state.cancelled;
    state = null;
    hideProgress();
    app.setStatus(message);
    app.refresh();
    if (isError && !wasCancelled) app.modal.alert('Upload failed', app.escapeHtml(message));
  }

  function sendChunk(prefetched) {
    var file = state.files[state.index];
    var start = state.offset;
    var end = Math.min(start + CHUNK, file.size);
    var blob = file.slice(start, end);

    // Read the *next* chunk off disk while this one is on the wire -
    // otherwise each chunk costs a serial disk read plus a network round
    // trip, which roughly halves throughput on large files.
    var nextBlob = end < file.size ? file.slice(end, Math.min(end + CHUNK, file.size)) : null;
    var nextPromise = nextBlob ? nextBlob.arrayBuffer() : null;

    var xhr = new XMLHttpRequest();
    state.xhr = xhr;

    var url = '/webGui/include/Control.php?mode=upload'
      + '&file='  + app.enc(app.join(state.dir, file.name))
      + '&start=' + start
      + '&cancel=0';

    xhr.open('POST', url, true);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-CSRF-Token', app.csrf());
    // Roughly a minute per megabyte, floored at ten minutes - a 20MB chunk
    // to a spun-down array disk can genuinely take minutes.
    xhr.timeout = Math.max(600000, CHUNK / 1024 * 60);

    xhr.onload = function () {
      if (!state || state.cancelled) return;
      if (xhr.status < 200 || xhr.status >= 300) {
        return failCurrent('Server returned HTTP ' + xhr.status);
      }
      var reply = xhr.responseText || '';
      if (reply === 'stop')            return failCurrent('Upload rejected - destination is not writable.');
      if (reply.indexOf('error') === 0) return failCurrent('Server error: ' + reply);

      state.offset = end;
      render();

      if (end < file.size) {
        nextPromise.then(function (buffer) {
          if (!state || state.cancelled) return;
          sendChunk(buffer);
        }).catch(function () { failCurrent('Could not read from the source file.'); });
        return;
      }

      // File complete - move on, or finish.
      clearTemp(file.name).then(function () {
        if (!state || state.cancelled) return;
        state.sentBefore += file.size;
        if (state.index < state.files.length - 1) {
          state.index += 1;
          state.offset = 0;
          render();
          sendChunk(null);
        } else {
          finish('Uploaded ' + state.files.length + ' file'
            + (state.files.length === 1 ? '' : 's') + '.', false);
        }
      });
    };

    xhr.onabort = function () {
      // User cancelled: tell the server to bin the partial file.
      var f = file;
      abortServerSide(f).then(function () {
        finish('Upload cancelled.', false);
      });
    };
    xhr.onerror   = function () { if (state && !state.cancelled) failCurrent('Network error.'); };
    xhr.ontimeout = function () { if (state && !state.cancelled) failCurrent('Upload timed out.'); };

    /* Safari/WebKit never reaches readyState 4 when a file-backed Blob is
       sent directly as the request body - the chunk arrives but onload
       never fires and the upload stalls. Sending an ArrayBuffer takes a
       different WebKit path that completes properly. (Same workaround, and
       same reason, as dynamix Browse.page.) */
    (prefetched ? Promise.resolve(prefetched) : blob.arrayBuffer())
      .then(function (buffer) {
        if (!state || state.cancelled) return;
        xhr.send(buffer);
      })
      .catch(function () { failCurrent('Could not read from the source file.'); });
  }

  function failCurrent(message) {
    if (!state) return;
    var file = state.files[state.index];
    state.cancelled = true;
    abortServerSide(file).then(function () {
      finish(message, true);
    });
  }

  var transfer = {};

  transfer.upload = function (dir, files) {
    if (!files || !files.length) return;
    if (app.ops.isRunning()) {
      app.modal.alert('Busy', 'Another file operation is running. Wait for it to finish before uploading.');
      return;
    }
    if (state) {
      app.modal.alert('Busy', 'An upload is already in progress.');
      return;
    }

    state = {
      dir: dir,
      files: Array.prototype.slice.call(files),
      index: 0,
      offset: 0,
      sentBefore: 0,
      total: totalBytes(files),
      started: Date.now(),
      cancelled: false,
      xhr: null
    };

    showProgress();
    render();
    sendChunk(null);
  };

  transfer.isUploading = function () { return state !== null; };

  /* Download drives a real navigation via a hidden anchor - a fetch()
     would buffer the whole file in memory before anything reached disk,
     and would lose the browser's own download UI. */
  function navigate(url) {
    var a = document.createElement('a');
    a.href = url;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  transfer.download = function (dir, items) {
    if (!items.length) return;

    // A single plain file streams as itself; anything else (a folder, or
    // several items) is zipped server-side on the fly.
    if (items.length === 1 && !items[0].dir) {
      navigate(app.DOWNLOAD
        + '?path=' + app.enc(items[0].path)
        + '&csrf_token=' + app.enc(app.csrf()));
      app.setStatus('Downloading ' + items[0].name + '…');
      return;
    }

    var query = items.map(function (item) {
      return 'names[]=' + app.enc(item.name);
    }).join('&');

    navigate(app.DOWNLOAD
      + '?dir=' + app.enc(dir)
      + '&' + query
      + '&csrf_token=' + app.enc(app.csrf()));

    app.setStatus('Building zip of ' + items.length + ' item'
      + (items.length === 1 ? '' : 's') + '…');
  };

  app.transfer = transfer;

}(window.filesUI));
