# Shared interface improvements, 0.1.6

This pass improves the interface used by both providers. It follows the [provider fixes in 0.1.5](UX-IMPROVEMENTS-2026-09-08.md) and the [experience audit](UX-AUDIT-2026-09-08.md). The [journey register](UX-JOURNEY-MAP.csv) remains the broader coverage map.

## Reading and composing

- Replies follow the bottom while you are reading the latest content. Scrolling up stops automatic following. **Back to latest** resumes it.
- Switching conversations restores your reading position during the current window session. Text and image drafts retain their existing per-conversation behavior.
- Composer controls wrap as the conversation pane narrows. Optional keyboard hints hide before they become cramped. The toolbar responds to the pane width when Watch is open.
- The floating working mascot no longer overlaps composer actions. Empty conversations use the available reading area without a fixed vertical spacer.
- New session immediately enters a pending state, prevents duplicate requests, reports failures, clears the session search after success, and focuses the composer.
- Enter during IME composition does not submit a message or commit a model prematurely.

## Keyboard and dialog behavior

- OpenRouter's model field supports arrow navigation, an announced active option, Enter to choose, custom model IDs, Escape to dismiss while keeping focus, and Tab to continue to the next control.
- Codex model menus can open with arrow keys. Escape closes the current select menu and returns focus without closing its parent dialog.
- Work control takes focus on opening, wraps Tab and Shift+Tab within the panel, and restores the opening control on close.
- Routine deletion uses an in-app confirmation with the safe action focused. Escape first dismisses that confirmation; a second Escape closes Work control.
- Routine and setup actions expose pending states and show errors inside the panel. Weekday controls have unambiguous accessible names. Form guidance is easier to read.

## Verification scope

`npm run verify` passed hygiene, TypeScript, 183 deterministic tests, and the production build; eight opt-in tests were skipped. `npm run smoke:electron:full` passed all 60 cases. The Apple Silicon package and bundled Codex executable also passed verification. Screenshots were reviewed with native Watch, phone controls, and routine settings visible.

The desktop suite includes new fixtures for reading-position retention through growing replies and conversation switches, keyboard selection on both providers, dialog focus and routine cancellation, and duplicate New session clicks. Shared layout assertions also check whether toolbar and composer controls escape the conversation pane or shortcut text wraps into a column.

These are deterministic Electron interactions with disposable state. They do not establish provider response latency, physical-phone behavior, Windows behavior, or full accessibility conformance. No paid model calls or gateway deployment are needed for this renderer pass.

## Remaining work

- Catalog-grounded proposals for new specialist definitions, with reviewable Use once and Save agent actions.
- Continue the control-by-control focus, loading, error and recovery sweep, including agent editing and phone handoff on physical devices.
- Measure local click feedback, rendering and state-write latency separately from provider response time.
- Continue visual review across all themes, resizing extremes and long-running conversations. The audit is a backlog, not a claim that every journey is complete.
