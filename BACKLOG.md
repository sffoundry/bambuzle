# bambuzle Backlog

> Ideas pending refinement. No IDs minted.

## Inbox

### ui-in-app-dialogs
- **Captured:** 2026-10-04
- **Source:** SF Foundry UI rule adopted 2026-10-04 (HamTab QSO delete used a native confirm)
- **One-liner:** Check and correct: errors, confirmations, prompts and attestations must use in-app UI (modal, inline message or toast), never native window.alert/confirm/prompt or OS dialogs; failures the user needs to see must not be console-only. Use one promise-based in-app dialog helper (theme tokens, focus trap + return, Esc cancels, destructive confirms red with focus on Cancel; prefer Undo when cheap). Check: rg -n '\b(window\.)?(alert|confirm|prompt)\(' over UI code. Reference: HamTabV1 src/dialog.js (v0.73.3). 2 found 2026-10-04: public/js/maintenance.js:168 (confirm), public/js/alerts-ui.js:59 (confirm). Bambuzle already has an in-app confirm dialog to reuse.
- **Tags:** ui, ux-rule


## Killed
