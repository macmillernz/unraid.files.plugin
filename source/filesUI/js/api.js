/* filesUI - API layer and shared formatting helpers.
 *
 * Two backends are spoken to here:
 *   - /plugins/filesUI/include/ajax.php  - this plugin's read-only JSON
 *     listing/tree/stat endpoints.
 *   - /webGui/include/Control.php        - Unraid's *own* file-operation
 *     API, used unchanged for every mutation so this plugin doesn't carry
 *     a duplicate (and inevitably divergent) copy of the engine that
 *     actually moves data around. See include/ajax.php's header.
 */

window.filesUI = window.filesUI || {};

(function (app) {
  'use strict';

  var AJAX    = '/plugins/filesUI/include/ajax.php';
  var CONTROL = '/webGui/include/Control.php';

  app.DOWNLOAD = '/plugins/filesUI/include/download.php';

  app.csrf = function () {
    var root = document.getElementById('filesUI-root');
    return root ? root.dataset.csrfToken : '';
  };

  /* Unraid's Control.php reads most of its arguments rawurldecode()'d, so
     everything sent to it has to be rawurlencoded on the way out - matching
     what dynamix's own Browse.page does. encodeURIComponent is the exact
     JS counterpart of PHP's rawurlencode. */
  function enc(value) {
    return encodeURIComponent(value == null ? '' : String(value));
  }
  app.enc = enc;

  function request(url, options) {
    return fetch(url, options).then(function (res) {
      return res.text().then(function (body) {
        if (!res.ok) {
          var message = body;
          try { message = JSON.parse(body).error || body; } catch (e) { /* not JSON */ }
          throw new Error(message || (res.status + ' ' + res.statusText));
        }
        return body;
      });
    });
  }

  /* Parse a response that is supposed to be JSON.
   *
   * A blank or non-JSON body is not a hypothetical here: Unraid's global
   * CSRF guard (local_prepend.php) aborts a rejected POST *before* this
   * plugin's code runs, and because that file emits a newline before it
   * can set a status, the rejection arrives as an empty 200 rather than a
   * 403. Letting JSON.parse throw on that would surface to the user as
   * "Unexpected end of JSON input", which says nothing useful. An expired
   * session behaves the same way, and that is the usual cause. */
  function parseJSON(body) {
    try {
      return JSON.parse(body);
    } catch (e) {
      throw new Error(body
        ? 'Unexpected response from the server.'
        : 'The server rejected the request. Your session may have expired - reload the page and try again.');
    }
  }

  function getJSON(params) {
    var query = Object.keys(params)
      .filter(function (k) { return params[k] !== undefined && params[k] !== null; })
      .map(function (k) { return k + '=' + enc(params[k]); })
      .join('&');
    return request(AJAX + '?' + query, { credentials: 'same-origin' })
      .then(parseJSON);
  }

  /* POST to Unraid's Control.php. The CSRF token goes in the X-CSRF-Token
     header rather than the body: local_prepend.php accepts either, and the
     header form keeps it out of the form fields Control.php then decodes. */
  function control(fields) {
    var body = Object.keys(fields)
      .map(function (k) { return k + '=' + encodeURIComponent(fields[k]); })
      .join('&');
    return request(CONTROL, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-CSRF-Token': app.csrf()
      },
      body: body
    });
  }
  app.control = control;

  /* ------------------------------------------------------------ reads */

  app.roots  = function ()         { return getJSON({ action: 'roots' }); };
  app.engine = function ()         { return getJSON({ action: 'engine' }); };
  app.tree  = function (path)      { return getJSON({ action: 'tree',  path: path }); };
  app.stat  = function (path)      { return getJSON({ action: 'stat',  path: path }); };
  app.usage = function (path)      { return getJSON({ action: 'usage', path: path }); };
  app.list  = function (path, hidden) {
    return getJSON({ action: 'list', path: path, hidden: hidden ? 1 : 0 });
  };

  /* Create a single empty file. Unraid has no action code for this - its
     own file manager cannot create files - so unlike every other mutation
     it is handled by this plugin's own endpoint. See include/ajax.php. */
  app.makeFile = function (dir, name) {
    return request(AJAX + '?action=mkfile', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-CSRF-Token': app.csrf()
      },
      body: 'path=' + enc(dir) + '&name=' + enc(name)
    }).then(parseJSON);
  };

  /* 7-Zip compress/extract. Like makeFile these go to this plugin's own
     endpoint, because Unraid's file_manager daemon has no archive action -
     see include/ajax.php's archive section.

     Values are encoded twice, the same as control() does with its
     already-enc()'d fields: PHP decodes the form body once and ajax.php
     rawurldecode()s again, so a single encoding would turn a real "%20"
     in a filename into a space. */
  function post(action, fields) {
    var body = Object.keys(fields)
      .map(function (k) { return k + '=' + enc(enc(fields[k])); })
      .join('&');
    return request(AJAX + '?action=' + action, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-CSRF-Token': app.csrf()
      },
      body: body
    }).then(parseJSON);
  }

  app.archiveStatus = function () { return getJSON({ action: 'archive_status' }); };
  app.compress = function (dir, names, archiveName, format) {
    return post('compress', { path: dir, names: names.join('\n'), name: archiveName, format: format });
  };
  app.extract = function (archive, dest, overwrite) {
    return post('extract', { path: archive, dest: dest, overwrite: overwrite ? '1' : '' });
  };
  app.archiveCancel  = function () { return post('archive_cancel', {}); };
  app.archiveDismiss = function () { return post('archive_dismiss', {}); };

  /* URL that serves a file for *display* rather than download - used by
     the preview panel for images, video, audio, PDFs and text. */
  app.inlineUrl = function (path) {
    return app.DOWNLOAD + '?path=' + enc(path)
      + '&inline=1&csrf_token=' + enc(app.csrf());
  };

  app.downloadUrl = function (path) {
    return app.DOWNLOAD + '?path=' + enc(path) + '&csrf_token=' + enc(app.csrf());
  };

  /* --------------------------------------------------------- mutations */

  /* Unraid's action codes, from dynamix Browse.page / nchan/file_manager.
     Folder and file variants are separate codes even where the daemon
     handles them identically, so the codes are kept verbatim rather than
     collapsed - the daemon's status text differs per code. */
  app.ACTION = {
    CREATE_FOLDER: 0,
    DELETE_FOLDER: 1,
    RENAME_FOLDER: 2,
    COPY_FOLDER:   3,
    MOVE_FOLDER:   4,
    DELETE_FILE:   6,
    RENAME_FILE:   7,
    COPY_FILE:     8,
    MOVE_FILE:     9,
    CHOWN:        11,
    CHMOD:        12,
    CALC_SIZE:    14,
    SEARCH:       15,
    KILL:         99
  };

  /* Start a file operation immediately.
     `sources` is an array of absolute paths; Control.php expects them
     joined by \r (not \n - that separator is used by the queue file). */
  app.startOperation = function (action, title, sources, target, options) {
    options = options || {};
    var root = document.getElementById('filesUI-root');
    return control({
      mode:   'file',
      action: action,
      title:  enc(title),
      source: enc(sources.join('\r')),
      target: enc(target || ''),
      hdlink: root && root.dataset.fuseDirectio ? '1' : '',
      sparse: options.sparse ? '--sparse' : '',
      // Control.php inverts this one: a falsy `exist` means
      // --ignore-existing, i.e. do NOT overwrite. So sending a value here
      // is what *enables* overwriting.
      exist:  options.overwrite ? '1' : '',
      zfs:    enc(options.zfs || '')
    });
  };

  /* Queue an operation instead of running it now. Unraid runs one file
     operation box-wide at a time; anything started while another is
     running has to wait, so the UI offers Queue alongside Start exactly
     as the built-in File Manager does. */
  app.queueOperation = function (action, title, sources, target, options) {
    options = options || {};
    var root = document.getElementById('filesUI-root');
    return control({
      mode:   'file',
      task:   enc(String(title).toLowerCase()),
      action: action,
      title:  enc(title),
      source: enc(sources.join('\r')),
      target: enc(target || ''),
      hdlink: root && root.dataset.fuseDirectio ? '1' : '',
      sparse: options.sparse ? '--sparse' : '',
      exist:  options.overwrite ? '1' : '',
      zfs:    enc(options.zfs || '')
    });
  };

  app.cancelOperation = function () {
    return control({ mode: 'file', action: app.ACTION.KILL });
  };

  /* Occupied-space calculation returns ready-made HTML (Unraid builds and
     translates it server-side), so it's shown as-is. */
  app.calculateSize = function (sources) {
    return control({ mode: 'calc', source: enc(sources.join('\n')) });
  };

  /* ------------------------------------------------------- formatting */

  /* Unraid reports sizes in decimal units throughout its GUI (see
     autoscale() in Browse.page), so this matches rather than using
     binary units and disagreeing with every other page. */
  app.formatSize = function (bytes) {
    if (bytes === 0) return '0 B';
    if (!bytes) return '';
    var units = ['B', 'kB', 'MB', 'GB', 'TB', 'PB', 'EB'];
    var i = Math.floor(Math.log(bytes) / Math.log(1000));
    if (i >= units.length) i = units.length - 1;
    var value = bytes / Math.pow(1000, i);
    return (i === 0 ? value : value.toFixed(value < 100 ? 1 : 0)) + ' ' + units[i];
  };

  app.formatDate = function (epoch) {
    if (!epoch) return '';
    var d = new Date(epoch * 1000);
    var now = new Date();
    var opts = { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };
    // Older-than-this-year entries show the year instead of the time,
    // which is the more useful discriminator at that age.
    if (d.getFullYear() !== now.getFullYear()) {
      opts = { year: 'numeric', month: 'short', day: 'numeric' };
    }
    return d.toLocaleString(undefined, opts);
  };

  app.escapeHtml = function (text) {
    var div = document.createElement('div');
    div.textContent = text == null ? '' : text;
    return div.innerHTML;
  };

  /* Join a directory and an entry name into an absolute path, without
     producing '//' at the root. */
  app.join = function (dir, name) {
    if (!dir || dir === '/') return '/' + name;
    return dir.replace(/\/+$/, '') + '/' + name;
  };

  app.basename = function (path) {
    var parts = String(path).replace(/\/+$/, '').split('/');
    return parts[parts.length - 1] || '/';
  };

  app.dirname = function (path) {
    var trimmed = String(path).replace(/\/+$/, '');
    var cut = trimmed.lastIndexOf('/');
    if (cut <= 0) return '/';
    return trimmed.slice(0, cut);
  };

}(window.filesUI));
