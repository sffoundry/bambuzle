// In-app confirmation dialog (replaces window.confirm, which is unstyled and can't follow the theme).
// Usage: if (await confirmDialog({ title, message, confirmLabel, danger })) { ... }
// Escape / backdrop click / Cancel → false; Enter or the confirm button → true. Focus returns to the
// element that opened it. Built with DOM APIs only — message text is never parsed as HTML.

let open = null; // the pending dialog, so a second request replaces the first

/** True when `overlay` is the most recently opened dialog (dialogs are appended to <body> in order). */
export function isTopDialog(overlay) {
  const all = document.querySelectorAll('.confirm-dialog, .conn-dialog');
  return all[all.length - 1] === overlay;
}

export function confirmDialog({ title = 'Confirm', message = '', confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false } = {}) {
  if (open) open.finish(false);

  const previouslyFocused = document.activeElement;
  const overlay = document.createElement('div');
  overlay.className = 'modal confirm-dialog';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');

  const box = document.createElement('div');
  box.className = 'modal-content confirm-dialog-content';
  const h = document.createElement('h3');
  h.id = `confirm-title-${Date.now()}`;
  h.textContent = title;
  overlay.setAttribute('aria-labelledby', h.id);
  const p = document.createElement('p');
  p.className = 'confirm-dialog-message';
  p.textContent = message;

  const actions = document.createElement('div');
  actions.className = 'form-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn-secondary';
  cancel.textContent = cancelLabel;
  const ok = document.createElement('button');
  ok.type = 'button';
  ok.className = danger ? 'btn-primary confirm-danger' : 'btn-primary';
  ok.textContent = confirmLabel;
  actions.append(cancel, ok);
  box.append(h, p, actions);
  overlay.append(box);

  return new Promise((resolve) => {
    const onKey = (e) => {
      if (!isTopDialog(overlay)) return; // a dialog stacked above us handles its own keys
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); finish(false); }
      else if (e.key === 'Tab') {
        // keep focus inside the dialog
        const focusables = [cancel, ok];
        const i = focusables.indexOf(document.activeElement);
        e.preventDefault();
        focusables[(i + (e.shiftKey ? -1 : 1) + focusables.length) % focusables.length].focus();
      }
    };
    function finish(result) {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      open = null;
      if (previouslyFocused && previouslyFocused.isConnected) previouslyFocused.focus();
      resolve(result);
    }
    open = { finish };
    cancel.addEventListener('click', () => finish(false));
    ok.addEventListener('click', () => finish(true));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) finish(false); });
    document.addEventListener('keydown', onKey, true);
    document.body.append(overlay);
    // Destructive actions default focus to Cancel so a stray Enter doesn't confirm them
    (danger ? cancel : ok).focus();
  });
}
