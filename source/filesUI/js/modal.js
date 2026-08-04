/* filesUI - the single reusable modal shell.
 *
 * One overlay in Files.page is reconfigured per operation rather than the
 * page carrying a separate block per dialog. stacksUI learned the hard way
 * that window.confirm() can silently do nothing in the context Unraid
 * renders plugin tabs in, so confirmations are real modals here too.
 */

window.filesUI = window.filesUI || {};

(function (app) {
  'use strict';

  var overlay, titleEl, bodyEl, errorEl, actionsEl;
  var onClose = null;

  function init() {
    overlay   = document.getElementById('filesUI-modal-overlay');
    titleEl   = document.getElementById('filesUI-modal-title');
    bodyEl    = document.getElementById('filesUI-modal-body');
    errorEl   = document.getElementById('filesUI-modal-error');
    actionsEl = document.getElementById('filesUI-modal-actions');

    // Click the backdrop to dismiss, but not a click that started inside
    // the dialog and drifted out (e.g. selecting text then releasing).
    overlay.addEventListener('mousedown', function (e) {
      if (e.target === overlay) app.modal.close();
    });

    document.addEventListener('keydown', function (e) {
      if (overlay.hidden) return;
      if (e.key === 'Escape') { e.preventDefault(); app.modal.close(); }
    });
  }

  app.modal = {
    /* open({ title, body, buttons, onOpen, onClose })
     *   body    - HTML string, or a DOM node to adopt
     *   buttons - [{ label, primary, danger, action }]; action returning
     *             false keeps the dialog open (used for validation).
     */
    open: function (config) {
      if (!overlay) init();

      titleEl.textContent = config.title || '';
      if (config.body instanceof Node) {
        bodyEl.innerHTML = '';
        bodyEl.appendChild(config.body);
      } else {
        bodyEl.innerHTML = config.body || '';
      }

      errorEl.hidden = true;
      errorEl.textContent = '';
      actionsEl.innerHTML = '';

      (config.buttons || []).forEach(function (spec) {
        var button = document.createElement('button');
        button.className = 'filesUI-btn' + (spec.danger ? ' filesUI-btn-danger' : '');
        button.textContent = spec.label;
        button.addEventListener('click', function () {
          if (!spec.action) { app.modal.close(); return; }
          if (spec.action() !== false) app.modal.close();
        });
        actionsEl.appendChild(button);
      });

      onClose = config.onClose || null;
      overlay.hidden = false;

      if (config.onOpen) config.onOpen(bodyEl);

      // Focus the first text input if there is one, otherwise the primary
      // button, so the dialog is immediately usable from the keyboard.
      var focusTarget = bodyEl.querySelector('input[type=text], select, textarea')
        || actionsEl.querySelector('button:last-child');
      if (focusTarget) focusTarget.focus();
      if (focusTarget && focusTarget.select) focusTarget.select();
    },

    close: function () {
      if (!overlay || overlay.hidden) return;
      overlay.hidden = true;
      bodyEl.innerHTML = '';
      actionsEl.innerHTML = '';
      var handler = onClose;
      onClose = null;
      if (handler) handler();
    },

    /* Show a validation message without dismissing the dialog. */
    error: function (message) {
      if (!errorEl) return;
      errorEl.textContent = message;
      errorEl.hidden = !message;
    },

    /* Convenience wrapper for a yes/no confirmation. */
    confirm: function (config) {
      app.modal.open({
        title: config.title,
        body: config.body,
        buttons: [
          { label: 'Cancel' },
          { label: config.confirmLabel || 'OK', danger: config.danger, action: config.onConfirm }
        ]
      });
    },

    /* Non-blocking notice, used for operation results and errors. */
    alert: function (title, body) {
      app.modal.open({ title: title, body: body, buttons: [{ label: 'Close' }] });
    }
  };

}(window.filesUI));
