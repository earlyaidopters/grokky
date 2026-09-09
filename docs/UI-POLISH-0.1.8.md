# Grokky 0.1.8: accessibility and sustained use

This follow-up addresses issues found while closing the remaining 0.1.7 verification work. The original [journey coverage](UI-POLISH-0.1.7.md) remains available.

## Changes

Opening a conversation with 2,000 formatted messages previously rendered the entire history and repeatedly parsed its Markdown. A sustained-workload preflight measured a Settings/composer cycle above three seconds.

Grokky now opens the latest 100 messages and provides **Load earlier messages** in batches of 100. Loading older content preserves the reading position and moves keyboard focus to the retained reading anchor. Earlier messages remain available in the conversation. While reading older content, new replies preserve that content; while following the latest reply, incoming messages keep the rendered history bounded. Markdown with unchanged content is reused across renderer updates. Browser Find searches the loaded portion of a long conversation, so load the earlier portion before searching it.

Automated accessibility checks found insufficient contrast in the light theme's lime and teal accent text and in faded Copy/Reply actions. Message actions now remain readable without hovering. Their foreground colors are darker while retaining the existing palettes. Destructive-button text now contrasts with its red background. Labeled toolbar sections now expose grouping roles, the decorative crew illustration has an image role, and collapsed menus omit references to absent popups. Compact Settings icons retain accessible names and tooltips. The access-mode menu supports arrow keys, Home, End, Enter, Space, Tab, and Escape with selection state and focus restoration. Scrollable lead notes, crew messages, tasks, and meeting transcripts can receive keyboard focus. The checks wait for finite interface animations to settle before measuring contrast.

## Phone deployment

The revised phone page was deployed on 2026-09-09 as Worker version `acacdb99-a6d9-42b1-8567-687d3689691a`. The deployment used `--containers-rollout=none`, preserving the existing container image. Health returned HTTP 200 with protocol version 2. The deployed `/phone` HTML matched the source byte for byte, including its no-store, no-referrer, and Content Security Policy headers.

The installed-app production canary passed pairing, desktop confirmation, takeover, tap, typing, keyboard input, return to the same browser state, stale-epoch rejection, and revocation. It used a disposable cloud browser and local test state. It made no model call and did not submit the external form.

Chromium and WebKit both passed the phone interaction suite and seven automated accessibility states: pairing, human control, rejected input, three viewport sizes, and offline state. This covers browser-engine behavior; it does not substitute for physical-phone keyboard, camera, touch, rotation, or sleep tests.

## Reproducible checks

```bash
npm ci
npm run verify
npm run smoke:electron:full
npm run smoke:accessibility
npm run smoke:soak
```

The default soak lasts two hours in a disposable profile. It begins with 100 sessions and 2,000 formatted messages, sends progress updates and incoming replies, opens and closes Settings, types into a draft, switches sessions, checks persisted state, and repeatedly attaches, previews, and removes an image. It checks the rendered-history bound, focus, modal cleanup, retained heap, and interaction timing. It makes no model or computer calls. `GROKKY_SOAK_MINUTES` can shorten a diagnostic run; a short run is not two-hour evidence.

On a computer in active use, run the interactive suite in hosted CI. The **Verify** workflow has an optional **Run the two-hour sustained-use check on a hosted Mac** input so the long run does not take focus from the desktop.

The full Electron suite also scans the final state of each interaction fixture, including approvals, Watch, images, agent proposals, and compact layouts. `node scripts/smoke-electron.mjs --audit-all` collects every screen failure in one diagnostic pass.

Local reports are written to ignored `output/accessibility/` and `output/soak/`. Axe's manual-review findings remain separate from its automated violations. Neither an automated pass nor a native accessibility-tree inspection establishes conformance for every assistive technology.

The full desktop suite includes the large-history navigation regression and an axe scan of 110 combinations: two themes, five accents, empty and populated conversations, six Settings sections, Routines, Attention, and the model menu. The source inventory contains [226 control locations](UI-CONTROL-INVENTORY-0.1.8.csv), including repeated and conditional controls. This is an inventory, not a claim that each runtime interaction was independently tested.

For phone checks:

```bash
npm --prefix services/sandbox-gateway ci
cd services/sandbox-gateway
npx playwright install chromium webkit
npm run smoke:phone-ui
GROKKY_PHONE_BROWSER=webkit npm run smoke:phone-ui
```

The Chromium run also accepts `GROKKY_CHROME_EXECUTABLE`. CI runs both browser engines. The WebKit browser engine does not emulate every iPhone behavior.

## Physical-device and screen-reader checks

For a physical phone, verify camera QR scanning and desktop confirmation, typing with the software keyboard visible, rotating with the keyboard open, touch scrolling and zoom, interrupted connectivity, background/foreground transitions, and explicit return of control. Use a disposable browser task and do not submit a form or sign into an account for verification. Never publish pairing fragments or browser credentials in a test report.

For VoiceOver or another screen reader, verify navigation landmarks, labels and values, provider/model selection, Settings dialog boundaries, nested discard confirmation, draft image preview and focus return, earlier-history loading, status/error announcements, and escape back to the invoking control. Restore the tester's original assistive-technology settings afterward.

## Verification record

The source checks passed 197 deterministic tests, TypeScript, repository hygiene, and the production build. Ten credential-gated tests remain opt-in. Gateway verification passed 27 tests, companion integration, and both phone browser engines.

A native macOS check enabled VoiceOver against the installed 0.1.7 app and exercised composer navigation, Settings focus containment, reverse Tab wrapping, and Escape focus restoration. VoiceOver was restored to its original off state. Spoken output was not reliably observable through the available automation, so announcement quality remains unverified. This check is separate from the 0.1.8 automated accessibility reports.

Physical-phone testing is blocked on device availability. Browser-engine fixtures and the production phone canary do not close the software-keyboard, touch, camera, rotation, and sleep checklist above.

The local sustained-use run was interrupted after its last sample at 2,983 seconds and 2,520 cycles when the user reported pointer interference during concurrent desktop automation. Retained renderer heap was 9.5 MiB at that sample; persistence, draft, history-bound, and image-preview assertions had not failed. This is approximately 50 minutes of partial evidence, not a completed two-hour pass. All automated desktop windows were stopped to restore normal computer use. The complete suite subsequently passed on hosted Mac and Windows runners.

The final [release verification run](https://github.com/earlyaidopters/grokky/actions/runs/34356725593) passed on commit `8cbb70d`: 71 Electron cases on macOS and Windows, the gateway checks, and both platform packages. Each desktop artifact contains 71 reports covering 180 audited states (110 theme/screen combinations plus 70 interaction end states), with zero automated violations. Manual-review findings remain visible in the artifacts. The locally installed macOS 0.1.8 build, bundled Codex runtime, and preservation of existing conversation/configuration state were checked after installation.
