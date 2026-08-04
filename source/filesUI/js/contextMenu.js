/* filesUI - right-click context menu.
 *
 * Built fresh on each open from a caller-supplied item list, so the menu
 * can reflect exactly what the current selection supports (a folder has no
 * "Download" for a single file, a multi-selection has no "Rename", and
 * nothing is actionable while an operation is already running).
 */

window.filesUI = window.filesUI || {};

(function (app) {
  'use strict';

  var menu = null;

  function ensure() {
    if (menu) return menu;
    menu = document.getElementById('filesUI-context');

    // Any click, scroll or resize outside the menu dismisses it. Bound
    // once, in the capture phase, so a handler on the element underneath
    // can't swallow the dismissal first.
    document.addEventListener('mousedown', function (e) {
      if (!menu.hidden && !menu.contains(e.target)) app.contextMenu.close();
    }, true);
    window.addEventListener('resize', function () { app.contextMenu.close(); });
    window.addEventListener('scroll', function () { app.contextMenu.close(); }, true);
    document.addEventListener('keydown', function (e) {
      if (!menu.hidden && e.key === 'Escape') app.contextMenu.close();
    });
    return menu;
  }

  app.contextMenu = {
    /* open(x, y, items)
     *   items - array of:
     *     { header: 'text' }               section label
     *     { divider: true }                horizontal rule
     *     { label, icon, disabled, action }
     */
    open: function (x, y, items) {
      var el = ensure();
      el.innerHTML = '';

      items.forEach(function (item) {
        if (item.divider) {
          var hr = document.createElement('div');
          hr.className = 'filesUI-context-divider';
          el.appendChild(hr);
          return;
        }
        if (item.header !== undefined) {
          var header = document.createElement('div');
          header.className = 'filesUI-context-header';
          header.textContent = item.header;
          el.appendChild(header);
          return;
        }

        var row = document.createElement('div');
        row.className = 'filesUI-context-item' + (item.disabled ? ' disabled' : '');
        row.innerHTML = '<i class="fa fa-fw fa-' + item.icon + '"></i>';
        row.appendChild(document.createTextNode(item.label));
        if (!item.disabled && item.action) {
          row.addEventListener('click', function () {
            app.contextMenu.close();
            item.action();
          });
        }
        el.appendChild(row);
      });

      // Render off-screen first to measure, then clamp so the menu can't
      // open past the viewport edge near the bottom or right of the page.
      el.style.left = '-9999px';
      el.style.top  = '-9999px';
      el.hidden = false;

      var box = el.getBoundingClientRect();
      var left = Math.min(x, window.innerWidth  - box.width  - 6);
      var top  = Math.min(y, window.innerHeight - box.height - 6);
      el.style.left = Math.max(6, left) + 'px';
      el.style.top  = Math.max(6, top)  + 'px';
    },

    close: function () {
      if (menu) menu.hidden = true;
    }
  };

}(window.filesUI));
