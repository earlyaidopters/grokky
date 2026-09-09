# Phone pairing readiness, 0.1.9

A completed text-only reply still offered an enabled **Pair phone** button. Clicking it failed because the desktop requires a running OpenRouter cloud task. The panel now explains availability before a click and disables pairing until that requirement is met.

## What changed

- The main process publishes pairing readiness for each conversation's current lead browser. The panel explains an inactive task, missing cloud setup, an outdated gateway, or an existing phone session.
- Pairing requests include the exact browser shown in Watch. An archived browser cannot pair a newer one, and a browser cannot display another browser's private pairing code, even in the same conversation.
- The desktop checks availability again when clicked. If the task finishes or is replaced while the invite is being prepared, that invite is revoked.
- Unexpected pairing failures appear once inside the panel. Availability changes clear obsolete feedback.
- The README and phone guide include a browser-task example and recovery steps.

Pairing still requires a running task and ends with that task. It may begin before the first browser frame arrives. This update does not add pairing for idle sessions, independent phone execution, or persistent browsers after task completion.

## Verification

Product commit: `dd89279` on `feat/phone-handoff`.

- `npm run verify`: hygiene, TypeScript, 210 passing tests, and production build. Ten opt-in live tests were skipped.
- Thirteen new controller tests cover completed greetings, provider/device/protocol eligibility, cancellation, missing runs, archived browsers, successful pairing before the first frame, disconnect recovery, duplicate starts, and run/seat replacement during invite creation.
- Hosted Mac and Windows full Electron suites each passed 73 cases, including compact and wide pairing transitions through the typed preload/IPC path. The fixture verifies disabled controls never call IPC, eligible requests target the correct browser, a failure produces one alert, and another browser's invite stays hidden.
- Each desktop platform produced 73 accessibility reports covering 182 states, with zero automatic violations. Manual-review findings remain in the reports; this is not a full accessibility conformance claim.
- Pairing-panel screenshots at 720 × 720 and 1440 × 900 were inspected on both platforms. Their embedded live browser uses an intentionally invalid fixture address; those screenshots do not establish a working live cloud connection.
- The gateway verification and Chromium/WebKit phone interaction checks passed. No gateway source or production deployment changed.
- Hosted macOS and Windows installers built successfully and passed bundled Codex verification. The local Apple Silicon package and its bundled Codex CLI 0.149.1 were verified. The app was installed with a verified rollback ZIP; existing conversation state and settings were preserved.

[Hosted verification and artifacts](https://github.com/earlyaidopters/grokky/actions/runs/34371124078).

No paid model calls or new production pairing canary were run for this change. The prior production canary and two-hour soak remain historical evidence described in [0.1.8 verification](UI-POLISH-0.1.8.md). Physical-phone testing remains outstanding. Desktop interaction tests ran on hosted machines; local UI automation was limited to the one-time app update.
