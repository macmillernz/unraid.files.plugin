/* filesUI - file preview flyout.
 *
 * Slides in over the folder tree from the left edge of the pane area.
 * Content is loaded from download.php?inline=1, which serves a real
 * Content-Type (so the browser renders it natively) behind a sandbox CSP,
 * rather than this plugin trying to decode formats itself.
 *
 * Anything the browser cannot display falls back to a metadata card with a
 * Download button - the panel always tells you something useful rather
 * than showing an empty frame.
 */

window.filesUI = window.filesUI || {};

(function (app) {
  'use strict';

  /* Cap on how much of a text file is pulled in. A preview only needs the
     head of the file, and a multi-gigabyte log must not be dragged through
     the browser to show its first screen. */
  var TEXT_LIMIT = 256 * 1024;

  var KIND = {
    image: ['jpg','jpeg','png','gif','webp','bmp','svg','ico','avif'],
    video: ['mp4','webm','ogv','mov','mkv','m4v'],
    audio: ['mp3','m4a','aac','wav','flac','ogg','opus'],
    pdf:   ['pdf'],
    // Rendered as plain text, never as markup - previewing an .html file
    // should show you its source, not execute it.
    text:  ['txt','log','md','markdown','nfo','csv','tsv','json','xml','yml','yaml',
            'ini','cfg','conf','conf','toml','sh','bash','zsh','py','php','js','ts',
            'css','html','htm','sql','c','h','cpp','hpp','go','rs','rb','pl','java',
            'env','gitignore','dockerfile','service','page','plg','bak','old','diff','patch']
  };

  function kindOf(entry) {
    if (entry.dir) return 'dir';
    var ext = (entry.ext || '').toLowerCase();
    for (var kind in KIND) {
      if (KIND[kind].indexOf(ext) !== -1) return kind;
    }
    // Extensionless files are usually config or scripts; try them as text.
    if (!ext) return 'text';
    return 'other';
  }

  var panel, titleEl, bodyEl, metaEl, current = null;

  function build() {
    if (panel) return;
    panel   = document.getElementById('filesUI-preview');
    titleEl = document.getElementById('filesUI-preview-title');
    bodyEl  = document.getElementById('filesUI-preview-body');
    metaEl  = document.getElementById('filesUI-preview-meta');

    document.getElementById('filesUI-preview-close')
      .addEventListener('click', function () { api.close(); });

    document.getElementById('filesUI-preview-download')
      .addEventListener('click', function () {
        if (current) app.transfer.download(app.dirname(current.path), [current]);
      });

    document.addEventListener('keydown', function (e) {
      // Only when no dialog is up, so Escape still closes a dialog first.
      if (e.key === 'Escape' && api.isOpen()
          && document.getElementById('filesUI-modal-overlay').hidden) {
        api.close();
      }
    });
  }

  /* Release whatever the panel was showing. Without this an <img> or
     <video> keeps its decoded frames (and an open range request) alive
     after the panel is closed or moved to another file. */
  function clear() {
    if (!bodyEl) return;
    Array.prototype.forEach.call(bodyEl.querySelectorAll('video, audio'), function (el) {
      el.pause();
      el.removeAttribute('src');
      el.load();
    });
    bodyEl.classList.remove('is-text');
    bodyEl.innerHTML = '';
  }

  function placeholder(icon, message, detail) {
    return '<div class="filesUI-preview-empty">'
      + '<i class="fa fa-' + icon + '"></i>'
      + '<p>' + app.escapeHtml(message) + '</p>'
      + (detail ? '<p class="filesUI-preview-detail">' + app.escapeHtml(detail) + '</p>' : '')
      + '</div>';
  }

  function renderMeta(entry) {
    var bits = [
      app.formatSize(entry.size) || '—',
      app.formatDate(entry.mtime),
      entry.owner,
      entry.mode
    ].filter(Boolean);
    metaEl.innerHTML = bits.map(function (b) {
      return '<span>' + app.escapeHtml(b) + '</span>';
    }).join('');
  }

  function renderText(entry) {
    bodyEl.innerHTML = placeholder('spinner fa-spin', 'Loading…');

    // Range-limit the request so the server streams only the head of the
    // file rather than all of it.
    fetch(app.inlineUrl(entry.path), {
      credentials: 'same-origin',
      headers: { 'Range': 'bytes=0-' + (TEXT_LIMIT - 1) }
    }).then(function (res) {
      if (!res.ok && res.status !== 206) throw new Error('HTTP ' + res.status);
      return res.text();
    }).then(function (body) {
      // A file that is actually binary shows up as replacement characters
      // once decoded; saying so beats rendering a screen of mojibake.
      if (/�/.test(body.slice(0, 4096))) {
        bodyEl.innerHTML = placeholder('file-o', 'No preview available',
          'This looks like a binary file.');
        return;
      }
      var truncated = entry.size > TEXT_LIMIT;
      var pre = document.createElement('pre');
      pre.className = 'filesUI-preview-text';
      pre.textContent = body;
      bodyEl.innerHTML = '';
      // Switches the body from centred (media) to top-left flow (text).
      bodyEl.classList.add('is-text');
      bodyEl.appendChild(pre);
      if (truncated) {
        var note = document.createElement('p');
        note.className = 'filesUI-preview-detail';
        note.textContent = 'Showing the first ' + app.formatSize(TEXT_LIMIT)
          + ' of ' + app.formatSize(entry.size) + '.';
        bodyEl.appendChild(note);
      }
    }).catch(function (err) {
      bodyEl.innerHTML = placeholder('exclamation-triangle', 'Could not read this file',
        err.message);
    });
  }

  function render(entry) {
    var kind = kindOf(entry);
    var url  = app.inlineUrl(entry.path);

    switch (kind) {
      case 'image':
        bodyEl.innerHTML = '<img class="filesUI-preview-image" alt="'
          + app.escapeHtml(entry.name) + '" src="' + app.escapeHtml(url) + '">';
        bodyEl.querySelector('img').addEventListener('error', function () {
          bodyEl.innerHTML = placeholder('file-image-o', 'Could not display this image');
        });
        break;

      case 'video':
        // .mkv in particular often carries codecs no browser can decode;
        // the error handler is what turns that into a clear message
        // instead of a permanently blank player.
        bodyEl.innerHTML = '<video class="filesUI-preview-media" controls preload="metadata" src="'
          + app.escapeHtml(url) + '"></video>';
        bodyEl.querySelector('video').addEventListener('error', function () {
          bodyEl.innerHTML = placeholder('file-video-o', 'This video cannot play in the browser',
            'The container or codec is not supported. Download it to play locally.');
        });
        break;

      case 'audio':
        bodyEl.innerHTML = '<audio class="filesUI-preview-audio" controls preload="metadata" src="'
          + app.escapeHtml(url) + '"></audio>';
        bodyEl.querySelector('audio').addEventListener('error', function () {
          bodyEl.innerHTML = placeholder('file-audio-o', 'This audio cannot play in the browser');
        });
        break;

      case 'pdf':
        bodyEl.innerHTML = '<iframe class="filesUI-preview-frame" src="'
          + app.escapeHtml(url) + '" title="' + app.escapeHtml(entry.name) + '"></iframe>';
        break;

      case 'text':
        renderText(entry);
        break;

      default:
        bodyEl.innerHTML = placeholder('file-o', 'No preview available',
          'Use Download to open this file locally.');
    }
  }

  var api = {
    open: function (entry) {
      build();
      if (entry.dir) return;          // folders have nothing to preview
      current = entry;
      clear();
      titleEl.textContent = entry.name;
      titleEl.title = entry.path;
      renderMeta(entry);
      render(entry);
      panel.classList.add('open');
      panel.setAttribute('aria-hidden', 'false');
    },

    close: function () {
      if (!panel) return;
      panel.classList.remove('open');
      panel.setAttribute('aria-hidden', 'true');
      current = null;
      // Wait for the slide-out to finish before tearing the content down,
      // so the panel doesn't visibly empty itself on the way out.
      setTimeout(clear, 200);
    },

    isOpen: function () {
      return !!panel && panel.classList.contains('open');
    },

    /* Space bar behaves like a Quick Look toggle: same file closes it,
       a different file swaps the content without re-animating. */
    toggle: function (entry) {
      if (api.isOpen() && current && current.path === entry.path) api.close();
      else api.open(entry);
    },

    current: function () { return current; }
  };

  app.preview = api;

}(window.filesUI));
