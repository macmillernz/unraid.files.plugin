/* filesUI - main controller: the right-hand file pane, selection,
 * navigation, sorting, keyboard handling, and the wiring between the tree,
 * the toolbar and the operation dialogs.
 *
 * The file list is virtualised: only the rows currently in view (plus a
 * small overscan) exist in the DOM, with two spacer rows standing in for
 * everything above and below. An Unraid share can easily hold tens of
 * thousands of files in one folder, and rendering that many <tr> - six
 * cells each - costs seconds of layout and makes every subsequent
 * selection repaint just as expensive. With windowing, drawing is
 * proportional to the viewport rather than the directory, so a 50,000-file
 * folder paints as fast as a 5-file one.
 *
 * Sorting and filtering work on the in-memory list and re-render, so
 * neither costs a round trip.
 */

window.filesUI = window.filesUI || {};

(function (app) {
  'use strict';

  /* Must match the row height the stylesheet fixes for tbody rows -
     virtualisation needs a known height to map scroll offset to index. */
  var ROW_HEIGHT = 29;
  /* Rows drawn beyond each edge of the viewport, so a fast scroll doesn't
     expose blank space before the next frame lands. */
  var OVERSCAN = 8;

  var tree     = null;
  var current  = '';        // absolute path of the directory on screen
  var entries  = [];        // raw listing from the server
  var view     = [];        // entries after filter + sort - what's drawn
  var selected = {};        // name -> true
  var focusIndex = -1;      // keyboard cursor into `view`
  var showHidden = false;
  var sortKey  = 'name';
  var sortDesc = false;

  var els = {};

  /* ------------------------------------------------------------ status */

  app.setStatus = function (message) {
    if (els.status) els.status.textContent = message || '';
  };

  app.setBusy = function (busy) {
    if (els.refresh) {
      els.refresh.querySelector('i').className = busy
        ? 'fa fa-refresh fa-spin' : 'fa fa-refresh';
    }
  };

  /* -------------------------------------------------------- navigation */

  function navigate(path, skipReveal) {
    current = path;
    selected = {};
    focusIndex = -1;
    // The previewed file belongs to the folder being left, and the panel
    // sits over the tree - leaving it up would obscure where you landed.
    if (app.preview) app.preview.close();

    // Reflect the location in the URL so a reload, a bookmark or a shared
    // link comes back to the same folder.
    try {
      var url = new URL(window.location.href);
      url.hash = '#' + encodeURIComponent(path);
      history.replaceState(null, '', url.toString());
    } catch (e) { /* older browsers - navigation still works */ }

    renderBreadcrumb();
    app.setBusy(true);
    app.setStatus('Reading ' + path + '…');

    return app.list(path, showHidden).then(function (data) {
      app.setBusy(false);
      entries = data.entries;
      // A new folder starts at the top; keeping the previous offset would
      // land the window somewhere arbitrary in a shorter listing.
      els.pane.scrollTop = 0;
      applyView();
      updateSelectionBar();
      app.setStatus('');
      loadUsage(path);
      if (!skipReveal && tree) tree.reveal(path);
      return true;
    }).catch(function (err) {
      app.setBusy(false);
      entries = [];
      applyView();
      app.setStatus('');
      app.modal.alert('Cannot open folder', app.escapeHtml(err.message));
      return false;
    });
  }

  app.refresh = function () {
    if (!current) return Promise.resolve();
    // Keep the selection across a refresh where the names still exist, so
    // a refresh after an operation doesn't silently drop the user's place.
    var keep = Object.keys(selected);
    return app.list(current, showHidden).then(function (data) {
      entries = data.entries;
      var names = {};
      entries.forEach(function (e) { names[e.name] = true; });
      selected = {};
      keep.forEach(function (name) { if (names[name]) selected[name] = true; });
      applyView();
      updateSelectionBar();
      loadUsage(current);
      if (tree) tree.invalidate(current);
    }).catch(function () { /* the folder may have just been deleted */ });
  };

  function loadUsage(path) {
    app.usage(path).then(function (data) {
      if (!data.total) { els.usage.textContent = ''; return; }
      els.usage.textContent = app.formatSize(data.total - data.free)
        + ' used of ' + app.formatSize(data.total)
        + ' (' + app.formatSize(data.free) + ' free)';
    }).catch(function () { els.usage.textContent = ''; });
  }

  /* ------------------------------------------------------- breadcrumb */

  function renderBreadcrumb() {
    var parts = current.split('/').filter(Boolean);
    els.breadcrumb.innerHTML = '';

    var path = '';
    parts.forEach(function (part, i) {
      path += '/' + part;
      var target = path;
      var isLast = i === parts.length - 1;

      if (i > 0) {
        var sep = document.createElement('span');
        sep.className = 'filesUI-crumb-sep';
        sep.textContent = '/';
        els.breadcrumb.appendChild(sep);
      }

      var crumb = document.createElement('a');
      crumb.className = 'filesUI-crumb' + (isLast ? ' filesUI-crumb-last' : '');
      crumb.textContent = part;
      crumb.title = target;
      if (!isLast) {
        crumb.addEventListener('click', function () { navigate(target); });
      }
      els.breadcrumb.appendChild(crumb);
    });

    // Scroll a deep path so the current folder stays visible.
    els.breadcrumb.scrollLeft = els.breadcrumb.scrollWidth;
    els.up.disabled = parts.length <= 1;
  }

  /* --------------------------------------------------- filter and sort */

  function applyView() {
    var needle = els.filter.value.trim().toLowerCase();

    view = entries.filter(function (entry) {
      return !needle || entry.name.toLowerCase().indexOf(needle) !== -1;
    });

    var dir = sortDesc ? -1 : 1;
    view.sort(function (a, b) {
      // Folders always lead, in both sort directions - a listing that
      // interleaves them is much harder to scan.
      if (a.dir !== b.dir) return a.dir ? -1 : 1;
      var result;
      switch (sortKey) {
        case 'size':  result = a.size - b.size; break;
        case 'mtime': result = a.mtime - b.mtime; break;
        case 'owner': result = a.owner.localeCompare(b.owner); break;
        case 'mode':  result = a.mode.localeCompare(b.mode); break;
        default:
          // Natural order, so file10 sorts after file9 rather than before.
          result = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
      }
      if (result === 0 && sortKey !== 'name') {
        result = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
      }
      return result * dir;
    });

    renderRows(true);
    renderSortIndicator();
  }

  function renderSortIndicator() {
    els.table.querySelectorAll('th[data-sort]').forEach(function (th) {
      th.classList.remove('sorted-asc', 'sorted-desc');
      if (th.dataset.sort === sortKey) {
        th.classList.add(sortDesc ? 'sorted-desc' : 'sorted-asc');
      }
    });
  }

  function buildRow(entry, index) {
    var tr = document.createElement('tr');
    tr.dataset.index = index;
    if (selected[entry.name]) tr.classList.add('selected');
    if (index === focusIndex) tr.classList.add('focused');

    // Checkbox
    var tdCheck = document.createElement('td');
    var box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = !!selected[entry.name];
    box.setAttribute('aria-label', 'Select ' + entry.name);
    box.addEventListener('click', function (e) {
      e.stopPropagation();
      toggle(index, box.checked);
    });
    tdCheck.appendChild(box);
    tr.appendChild(tdCheck);

    // Name + icon
    var tdName = document.createElement('td');
    var wrap = document.createElement('div');
    wrap.className = 'filesUI-name-cell';

    var icon = document.createElement('i');
    icon.className = 'fa fa-' + entry.icon + ' filesUI-name-icon'
      + (entry.dir ? ' fa-folder' : '');

    var name = document.createElement('span');
    name.className = 'filesUI-name-text';
    name.textContent = entry.name;
    name.title = entry.name;

    wrap.appendChild(icon);
    wrap.appendChild(name);
    if (entry.link) {
      var link = document.createElement('span');
      link.className = 'filesUI-link-target';
      link.textContent = '→ ' + entry.link;
      wrap.appendChild(link);
    }
    tdName.appendChild(wrap);
    tr.appendChild(tdName);

    // Size / modified / owner / mode
    var tdSize = document.createElement('td');
    tdSize.className = 'filesUI-col-size';
    tdSize.textContent = entry.dir ? '' : app.formatSize(entry.size);
    tr.appendChild(tdSize);

    var tdTime = document.createElement('td');
    tdTime.className = 'filesUI-col-mtime';
    tdTime.textContent = app.formatDate(entry.mtime);
    tr.appendChild(tdTime);

    var tdOwner = document.createElement('td');
    tdOwner.className = 'filesUI-col-owner';
    tdOwner.textContent = entry.owner;
    tr.appendChild(tdOwner);

    var tdMode = document.createElement('td');
    tdMode.className = 'filesUI-col-mode';
    tdMode.textContent = entry.mode;
    tr.appendChild(tdMode);

    return tr;
  }

  /* A stand-in row occupying the height of the rows not currently drawn,
     so the scrollbar reflects the whole listing. */
  function spacer(height) {
    var tr = document.createElement('tr');
    tr.className = 'filesUI-spacer';
    tr.style.height = height + 'px';
    var td = document.createElement('td');
    td.colSpan = 6;
    tr.appendChild(td);
    return tr;
  }

  var scrollPending = false;
  var lastRange = null;   // 'start:end' of the window currently drawn

  function renderRows(force) {
    var total = view.length;

    // Map the scroll offset to the slice of rows that can be on screen.
    // els.pane is the scrolling element; the sticky header sits inside it,
    // so its height is excluded from the usable viewport.
    var headHeight = els.table.tHead ? els.table.tHead.offsetHeight : 0;
    var scrollTop = Math.max(0, els.pane.scrollTop - headHeight);
    var visible = Math.ceil((els.pane.clientHeight || 600) / ROW_HEIGHT);

    var start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    var end   = Math.min(total, start + visible + OVERSCAN * 2);

    // Scrolling fires far more often than the window actually changes;
    // skip the rebuild when the same slice is already on screen. Callers
    // that changed row *content* (selection, focus, a new listing) pass
    // force, since the range alone can't tell them apart.
    var range = start + ':' + end + ':' + total;
    if (!force && range === lastRange) return;
    lastRange = range;

    var fragment = document.createDocumentFragment();
    if (start > 0) fragment.appendChild(spacer(start * ROW_HEIGHT));
    for (var i = start; i < end; i++) fragment.appendChild(buildRow(view[i], i));
    if (end < total) fragment.appendChild(spacer((total - end) * ROW_HEIGHT));

    /* Swap the whole body in one operation. Clearing first and then
       appending would leave the tbody momentarily empty, collapsing the
       scroll container's height - at which point the browser clamps
       scrollTop back to ~0 and the next repaint jumps to the top of the
       listing. replaceChildren never exposes that empty state. */
    els.rows.replaceChildren(fragment);

    els.empty.hidden = total > 0;
    els.empty.textContent = entries.length === 0
      ? 'This folder is empty.'
      : 'Nothing matches the filter.';

    els.checkAll.checked = total > 0 && view.every(function (e) { return selected[e.name]; });
  }

  /* Redraw on scroll, coalesced to one repaint per frame - a raw scroll
     handler fires far more often than the display refreshes. */
  function onScroll() {
    if (scrollPending) return;
    scrollPending = true;
    requestAnimationFrame(function () {
      scrollPending = false;
      renderRows(true);
    });
  }

  /* Scroll a row into view by index. The row may not be in the DOM yet
     (that is the point of windowing), so this works off arithmetic rather
     than the element, then repaints. */
  function scrollToIndex(index) {
    var headHeight = els.table.tHead ? els.table.tHead.offsetHeight : 0;
    var top    = index * ROW_HEIGHT;
    var bottom = top + ROW_HEIGHT;
    var viewTop    = els.pane.scrollTop - headHeight;
    var viewBottom = viewTop + els.pane.clientHeight - headHeight;

    if (top < viewTop)         els.pane.scrollTop = top + headHeight;
    else if (bottom > viewBottom) els.pane.scrollTop = bottom - els.pane.clientHeight + headHeight * 2;
    renderRows(true);
  }

  /* -------------------------------------------------------- selection */

  function toggle(index, on) {
    var entry = view[index];
    if (!entry) return;
    if (on === undefined) on = !selected[entry.name];
    if (on) selected[entry.name] = true; else delete selected[entry.name];
    focusIndex = index;
    renderRows(true);
    updateSelectionBar();
  }

  function selectOnly(index) {
    selected = {};
    if (view[index]) selected[view[index].name] = true;
    focusIndex = index;
    renderRows(true);
    updateSelectionBar();
  }

  /* Shift-click extends from the keyboard cursor to the clicked row. */
  function selectRange(index) {
    if (focusIndex < 0) { selectOnly(index); return; }
    var from = Math.min(focusIndex, index);
    var to   = Math.max(focusIndex, index);
    for (var i = from; i <= to; i++) selected[view[i].name] = true;
    renderRows(true);
    updateSelectionBar();
  }

  function selectedEntries() {
    return view.filter(function (entry) { return selected[entry.name]; });
  }

  function updateSelectionBar() {
    var items = selectedEntries();
    els.selectionBar.hidden = items.length === 0;
    if (!items.length) return;

    var folders = items.filter(function (i) { return i.dir; }).length;
    var files   = items.length - folders;
    var parts = [];
    if (folders) parts.push(folders + ' folder' + (folders === 1 ? '' : 's'));
    if (files)   parts.push(files + ' file' + (files === 1 ? '' : 's'));

    var bytes = items.reduce(function (sum, i) { return sum + (i.dir ? 0 : i.size); }, 0);
    els.selectionCount.textContent = parts.join(', ')
      + (bytes ? '  ·  ' + app.formatSize(bytes) : '') + ' selected';

    // Rename acts on exactly one item; everything else handles a set.
    els.selectionBar.querySelector('[data-op=rename]').disabled = items.length !== 1;
    // Extract acts on exactly one archive file.
    els.selectionBar.querySelector('[data-op=extract]').disabled =
      !(items.length === 1 && app.archive.isArchive(items[0]));
  }

  /* ------------------------------------------------------- activation */

  function activate(entry) {
    if (entry.dir) {
      navigate(app.join(current, entry.name));
    } else {
      // Opening a file shows it in the preview flyout rather than
      // downloading it. The panel carries its own Download button (and
      // falls back to a metadata card for anything the browser can't
      // render), so nothing is lost and the common case - "what is this
      // file?" - no longer costs a round trip to the Downloads folder.
      app.preview.open(withPath(entry));
    }
  }

  function withPath(entry) {
    var copy = {};
    Object.keys(entry).forEach(function (k) { copy[k] = entry[k]; });
    copy.path = app.join(current, entry.name);
    return copy;
  }

  function targets() {
    return selectedEntries().map(withPath);
  }

  /* -------------------------------------------------------- operations */

  function runOp(op, items) {
    items = items || targets();
    if (!items.length && op !== 'new') return;

    switch (op) {
      case 'new':       app.ops.create(current); break;
      case 'preview':   {
        // Preview acts on one file; with a mixed selection take the first
        // file in it rather than refusing outright.
        var file = items.filter(function (i) { return !i.dir; })[0];
        if (file) app.preview.open(file);
        else app.setStatus('Folders cannot be previewed.');
        break;
      }
      case 'download':  app.transfer.download(current, items); break;
      case 'copy':      app.ops.copy(items); break;
      case 'move':      app.ops.move(items); break;
      case 'rename':    if (items.length === 1) app.ops.rename(items[0]); break;
      case 'delete':    app.ops.remove(items); break;
      case 'owner':     app.ops.owner(items); break;
      case 'perms':     app.ops.permissions(items); break;
      case 'size':      app.ops.calculateSize(items); break;
      case 'compress':  app.archive.compress(current, items); break;
      case 'extract':   if (items.length === 1 && app.archive.isArchive(items[0])) app.archive.extract(items[0]); break;
    }
  }
  app.runOp = runOp;

  function openContextMenu(x, y, items) {
    var busy = app.ops.isRunning() || app.transfer.isUploading() || app.archive.isRunning();
    if (busy) {
      app.contextMenu.open(x, y, [{ label: 'An operation is running', icon: 'ban', disabled: true }]);
      return;
    }

    var single = items.length === 1;
    var onlyFile = single && !items[0].dir;
    var menu = [
      { header: single ? items[0].name : items.length + ' items selected' },
      { label: 'Preview', icon: 'eye', disabled: !onlyFile, action: function () { runOp('preview', items); } },
      { label: 'Download', icon: 'download', action: function () { runOp('download', items); } },
      { label: 'Copy',     icon: 'copy',     action: function () { runOp('copy', items); } },
      { label: 'Move',     icon: 'paste',    action: function () { runOp('move', items); } },
      { label: 'Rename',   icon: 'edit',     disabled: !single, action: function () { runOp('rename', items); } },
      { divider: true },
      { label: 'Compress', icon: 'file-archive-o', action: function () { runOp('compress', items); } },
      { label: 'Extract',  icon: 'folder-open-o',  disabled: !(single && app.archive.isArchive(items[0])),
        action: function () { runOp('extract', items); } },
      { divider: true },
      { label: 'Owner',       icon: 'user-o',     action: function () { runOp('owner', items); } },
      { label: 'Permissions', icon: 'lock',       action: function () { runOp('perms', items); } },
      { label: 'Occupied space', icon: 'calculator', action: function () { runOp('size', items); } },
      { divider: true },
      { label: 'Delete', icon: 'trash-o', action: function () { runOp('delete', items); } }
    ];
    app.contextMenu.open(x, y, menu);
  }

  /* ------------------------------------------------------------- wiring */

  /* Resolve the row an event landed on to an index into `view`, or -1.
     Spacer rows carry no index, so they resolve to -1 and are ignored. */
  function rowIndex(e) {
    var tr = e.target.closest('tr');
    if (!tr || tr.dataset.index === undefined) return -1;
    var index = parseInt(tr.dataset.index, 10);
    return (isNaN(index) || !view[index]) ? -1 : index;
  }

  function bindPane() {
    // Row interactions are delegated from tbody so re-rendering the list
    // never leaves stale listeners behind - and with windowing, rows are
    // created and discarded constantly.
    els.rows.addEventListener('click', function (e) {
      var index = rowIndex(e);
      if (index < 0) return;

      if (e.shiftKey)               selectRange(index);
      else if (e.ctrlKey || e.metaKey) toggle(index);
      else if (e.target.classList.contains('filesUI-name-text')) activate(view[index]);
      else                          selectOnly(index);
    });

    els.rows.addEventListener('dblclick', function (e) {
      var index = rowIndex(e);
      if (index >= 0) activate(view[index]);
    });

    els.rows.addEventListener('contextmenu', function (e) {
      var index = rowIndex(e);
      if (index < 0) return;
      e.preventDefault();
      // Right-clicking outside the current selection re-targets it, which
      // is what every file manager does.
      if (!selected[view[index].name]) selectOnly(index);
      openContextMenu(e.clientX, e.clientY, targets());
    });

    els.checkAll.addEventListener('change', function () {
      selected = {};
      if (els.checkAll.checked) view.forEach(function (e) { selected[e.name] = true; });
      renderRows(true);
      updateSelectionBar();
    });

    els.table.querySelectorAll('th[data-sort]').forEach(function (th) {
      th.addEventListener('click', function () {
        var key = th.dataset.sort;
        if (sortKey === key) sortDesc = !sortDesc;
        else { sortKey = key; sortDesc = false; }
        // Re-sorting invalidates where you were, so go back to the top
        // rather than landing mid-list at an unrelated position.
        els.pane.scrollTop = 0;
        applyView();
      });
    });

    els.pane.addEventListener('scroll', onScroll, { passive: true });
    // The window of rows to draw depends on the pane's height.
    window.addEventListener('resize', onScroll);
  }

  function bindToolbar() {
    els.up.addEventListener('click', function () {
      if (current && current !== '/') navigate(app.dirname(current));
    });
    els.refresh.addEventListener('click', function () { app.refresh(); });
    els.newButton.addEventListener('click', function () { runOp('new'); });
    els.upload.addEventListener('click', function () { els.fileInput.click(); });

    els.toggleHidden.addEventListener('click', function () {
      showHidden = !showHidden;
      els.toggleHidden.querySelector('i').className = showHidden ? 'fa fa-eye' : 'fa fa-eye-slash';
      els.toggleHidden.title = showHidden ? 'Hide hidden files' : 'Show hidden files';
      // A pressed state, because an icon-only toggle whose only feedback is
      // an eye/eye-slash swap is hard to tell from a dead button.
      els.toggleHidden.classList.toggle('is-active', showHidden);
      els.toggleHidden.setAttribute('aria-pressed', showHidden ? 'true' : 'false');

      app.refresh().then(function () {
        // Most folders contain no dotfiles at all, so toggling looks like
        // it did nothing. Say what happened rather than leaving the user to
        // conclude the button is broken.
        if (!showHidden) {
          app.setStatus('Hidden files hidden.');
          return;
        }
        var count = entries.filter(function (e) { return e.name.charAt(0) === '.'; }).length;
        app.setStatus(count
          ? 'Showing ' + count + ' hidden item' + (count === 1 ? '' : 's') + '.'
          : 'No hidden items in this folder.');
      });
    });

    // Debounced so typing in a 20,000-entry listing doesn't re-render on
    // every keystroke.
    var filterTimer = null;
    els.filter.addEventListener('input', function () {
      clearTimeout(filterTimer);
      filterTimer = setTimeout(applyView, 120);
    });

    els.selectionBar.addEventListener('click', function (e) {
      var button = e.target.closest('button[data-op]');
      if (button && !button.disabled) runOp(button.dataset.op);
    });

    els.fileInput.addEventListener('change', function () {
      if (els.fileInput.files.length) {
        app.transfer.upload(current, els.fileInput.files);
        els.fileInput.value = '';
      }
    });
  }

  function bindDragDrop() {
    var depth = 0;   // dragenter/dragleave fire per child element, so count

    els.pane.addEventListener('dragenter', function (e) {
      if (!Array.prototype.includes.call(e.dataTransfer.types || [], 'Files')) return;
      e.preventDefault();
      depth += 1;
      els.pane.classList.add('dragover');
    });
    els.pane.addEventListener('dragover', function (e) {
      if (!Array.prototype.includes.call(e.dataTransfer.types || [], 'Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    els.pane.addEventListener('dragleave', function () {
      depth = Math.max(0, depth - 1);
      if (depth === 0) els.pane.classList.remove('dragover');
    });
    els.pane.addEventListener('drop', function (e) {
      e.preventDefault();
      depth = 0;
      els.pane.classList.remove('dragover');
      var files = e.dataTransfer.files;
      if (!files || !files.length) return;
      // Directory drops arrive as zero-byte entries the File API cannot
      // read; say so rather than silently uploading empty files.
      var hasDirs = Array.prototype.some.call(files, function (f) {
        return f.size === 0 && f.type === '';
      });
      if (hasDirs) {
        app.setStatus('Folders cannot be uploaded by drag and drop - drop files instead.');
      }
      app.transfer.upload(current, files);
    });
  }

  function bindKeyboard() {
    document.addEventListener('keydown', function (e) {
      // Never hijack keys while a dialog is open or the user is typing.
      if (!document.getElementById('filesUI-modal-overlay').hidden) return;
      var tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea') {
        if (e.key === 'Escape' && e.target === els.filter) {
          els.filter.value = '';
          applyView();
        }
        return;
      }

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          moveFocus(1, e.shiftKey);
          break;
        case 'ArrowUp':
          e.preventDefault();
          moveFocus(-1, e.shiftKey);
          break;
        case 'Enter':
          if (focusIndex >= 0 && view[focusIndex]) { e.preventDefault(); activate(view[focusIndex]); }
          break;
        case ' ':
          // Quick Look convention: space toggles the preview for the row
          // under the cursor. preventDefault stops the pane page-scrolling.
          if (focusIndex >= 0 && view[focusIndex] && !view[focusIndex].dir) {
            e.preventDefault();
            app.preview.toggle(withPath(view[focusIndex]));
          }
          break;
        case 'Backspace':
          e.preventDefault();
          if (current && current !== '/') navigate(app.dirname(current));
          break;
        case 'Delete':
          if (selectedEntries().length) { e.preventDefault(); runOp('delete'); }
          break;
        case 'F2':
          if (selectedEntries().length === 1) { e.preventDefault(); runOp('rename'); }
          break;
        case 'a':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            view.forEach(function (entry) { selected[entry.name] = true; });
            renderRows(true);
            updateSelectionBar();
          }
          break;
        case 'Escape':
          // Escape peels one layer at a time: close the preview first, and
          // only clear the selection once nothing is open over the list.
          if (app.preview.isOpen()) { app.preview.close(); break; }
          selected = {};
          renderRows(true);
          updateSelectionBar();
          break;
        case '/':
          e.preventDefault();
          els.filter.focus();
          break;
      }
    });
  }

  function moveFocus(delta, extend) {
    if (!view.length) return;
    var next = focusIndex < 0
      ? (delta > 0 ? 0 : view.length - 1)
      : Math.min(view.length - 1, Math.max(0, focusIndex + delta));

    if (extend) {
      selected[view[next].name] = true;
      focusIndex = next;
      updateSelectionBar();
    } else {
      selectOnly(next);
    }

    // scrollToIndex repaints, which is also what applies the new focus and
    // selection classes - the row may not even be in the DOM yet.
    scrollToIndex(next);

    // With the preview already open, arrowing through the list swaps what
    // it shows - the same follow-the-cursor behaviour as Quick Look.
    // Folders leave the last preview up rather than blanking the panel.
    if (app.preview.isOpen() && view[next] && !view[next].dir) {
      app.preview.open(withPath(view[next]));
    }
  }

  /* Wire one resize handle to the pane immediately on its left.
   *
   * Each handle must be the pane's next sibling. When the preview sat
   * between the tree and the tree's handle, dragging measured from the
   * tree's left edge across the preview's whole width, so the tree jumped
   * by that much on the first movement - the "snapping" that made the bar
   * look like it belonged to the other pane.
   *
   * `apply` differs per pane: the tree takes a plain width, while the
   * preview's width has to go through a custom property so its closed
   * state can still collapse to zero (see the stylesheet).
   */
  function bindSplitter(handle, pane, options) {
    if (!handle || !pane) return;
    var dragging = false;

    function setWidth(px) {
      options.apply(pane, px);
    }

    /* Largest width this pane may take, but never below its own minimum.
       Clamping the other way round (min first, then an upper bound derived
       from the window) lets a narrow - or momentarily zero-width - viewport
       produce an upper bound *below* the minimum, which then wins and
       collapses the pane to nothing. That value would then be persisted,
       so the pane came back collapsed on the next visit. */
    function maxWidth() {
      return Math.max(options.min, Math.round(window.innerWidth * 0.6));
    }

    var saved = null;
    try { saved = localStorage.getItem(options.storageKey); } catch (e) { /* private mode */ }
    if (saved) {
      var restored = parseInt(saved, 10);
      // A width saved on a wider monitor must not leave the pane larger
      // than the window it is being restored into. A stored 0 or NaN is
      // discarded rather than applied.
      if (restored > 0) setWidth(Math.min(Math.max(restored, options.min), maxWidth()));
    }

    handle.addEventListener('mousedown', function (e) {
      e.preventDefault();
      dragging = true;
      document.body.style.cursor = 'col-resize';
      // Selecting text across the page while dragging looks broken.
      document.body.style.userSelect = 'none';
      if (options.dragClass) pane.classList.add(options.dragClass);
    });

    document.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      // Measured from this pane's own left edge, so whatever sits further
      // left (or between other panes) is irrelevant.
      var left = pane.getBoundingClientRect().left;
      setWidth(Math.min(Math.max(options.min, e.clientX - left), maxWidth()));
    });

    document.addEventListener('mouseup', function () {
      if (!dragging) return;
      dragging = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      if (options.dragClass) pane.classList.remove(options.dragClass);
      var final = Math.round(pane.getBoundingClientRect().width);
      // Never persist a degenerate width - a pane measured while hidden or
      // mid-transition would otherwise be restored collapsed.
      if (final < options.min) return;
      try {
        localStorage.setItem(options.storageKey, final);
      } catch (e) { /* private mode - width simply won't persist */ }
    });
  }

  function bindSplitters() {
    bindSplitter(els.splitter, els.tree, {
      min: 140,
      storageKey: 'filesUI.treeWidth',
      apply: function (pane, px) { pane.style.flexBasis = pane.style.width = px + 'px'; }
    });

    bindSplitter(els.previewSplitter, els.previewPane, {
      min: 260,
      storageKey: 'filesUI.previewWidth',
      dragClass: 'is-resizing',
      apply: function (pane, px) {
        pane.style.setProperty('--filesUI-preview-width', px + 'px');
      }
    });
  }

  /* ------------------------------------------------------------- start */

  function start() {
    els = {
      tree:           document.getElementById('filesUI-tree'),
      splitter:       document.getElementById('filesUI-splitter'),
      previewPane:     document.getElementById('filesUI-preview'),
      previewSplitter: document.getElementById('filesUI-preview-splitter'),
      pane:           document.getElementById('filesUI-pane'),
      rows:           document.getElementById('filesUI-rows'),
      table:          document.querySelector('.filesUI-table'),
      empty:          document.getElementById('filesUI-empty'),
      breadcrumb:     document.getElementById('filesUI-breadcrumb'),
      filter:         document.getElementById('filesUI-filter'),
      up:             document.getElementById('filesUI-up'),
      refresh:        document.getElementById('filesUI-refresh'),
      newButton:      document.getElementById('filesUI-new'),
      upload:         document.getElementById('filesUI-upload'),
      toggleHidden:   document.getElementById('filesUI-toggle-hidden'),
      checkAll:       document.getElementById('filesUI-check-all'),
      selectionBar:   document.getElementById('filesUI-selection-bar'),
      selectionCount: document.getElementById('filesUI-selection-count'),
      fileInput:      document.getElementById('filesUI-file-input'),
      status:         document.getElementById('filesUI-status'),
      usage:          document.getElementById('filesUI-usage')
    };

    bindPane();
    bindToolbar();
    bindDragDrop();
    bindKeyboard();
    bindSplitters();

    tree = new app.Tree(els.tree, { onSelect: function (path) { navigate(path, true); } });

    tree.load().then(function (roots) {
      // Restore the folder from the URL hash if it still exists, otherwise
      // open the first root (normally /mnt/user).
      var hash = '';
      try { hash = decodeURIComponent((window.location.hash || '').replace(/^#/, '')); } catch (e) { hash = ''; }

      var target = hash && hash.charAt(0) === '/' ? hash : (roots[0] && roots[0].path);
      if (!target) {
        app.setStatus('No mounted filesystems found under /mnt.');
        return;
      }
      return navigate(target).then(function (ok) {
        // If the hash pointed somewhere unreadable, navigate() already
        // reported it; fall back to the first root so the pane isn't blank.
        // Keyed off whether the read actually failed, not off the listing
        // being empty - deep-linking to a genuinely empty folder is a
        // perfectly good thing to do and must stay where it was asked.
        if (!ok && roots[0] && current !== roots[0].path) {
          return navigate(roots[0].path);
        }
      });
    });

    app.ops.startMonitor();
    app.archive.resume();
    checkEngine();
  }

  /* Warn up front if the file-operation engine is down. Without this the
     symptom is that create/delete/rename/copy/move/chown/chmod all appear
     to do nothing at all, with no error - the job is accepted and queued,
     and then simply never runs. */
  function checkEngine() {
    app.engine().then(function (state) {
      if (state.running) return;
      els.status.innerHTML = '<span class="filesUI-status-warn">'
        + '<i class="fa fa-exclamation-triangle"></i> '
        + "Unraid's file-operation service isn't running - create, delete, "
        + 'rename, copy, move and permission changes will not complete. '
        + 'Reload this page; if it persists, check the filesUI plugin is fully installed.'
        + '</span>';
    }).catch(function () { /* the warning is best-effort */ });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

}(window.filesUI));
