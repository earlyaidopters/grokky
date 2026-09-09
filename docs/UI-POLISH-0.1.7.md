# Interface and agent journeys, 0.1.7

This release extends the shared interface work across conversation, agent, settings, computer, Watch, routine, setup, and phone surfaces. The [87-journey register](UX-JOURNEY-MAP.csv) separates the original audit evidence from the checks added in this release. The [control inventory](UX-CONTROL-INVENTORY.csv) is the original source inventory, with historical line numbers.

## What changed

- **Agent requests:** explicit requests to create or recommend an agent produce a catalog-grounded, editable role brief. Use once selects it for the next turn; Save for reuse creates a personal or project definition; Dismiss creates nothing. This is a deterministic brief from the user's request, not a claim that a model designed or started an agent. Ordinary natural-language delegation continues without redundant picker clicks.
- **Native execution:** one-time Codex roles are registered through temporary native configuration files. The files are private, removed when the provider call ends, and do not modify the personal or project agent library. OpenRouter keeps its separate bounded, read-only specialist loop. Role selection still respects the conversation's permissions and crew limit.
- **Agent library:** searchable names, descriptions, and scopes; common templates; global defaults in a separate disclosure; meaningful no-results feedback. One-time roles appear in selection controls without appearing as editable library files.
- **Conversation:** retained cursor selection, larger independent preview/remove attachment controls, keyboard-contained image previews, retry for unavailable saved images, clipboard failure feedback, and consistent Stopping/error states in the composer, crew panel, and Watch.
- **Dialogs and settings:** unsaved session, agent, allowlist, pairing, and routine edits are protected on close. Nested confirmations restore the correct focus and keep background controls inert. Device revocation and agent deletion have explicit safe defaults. Save and computer actions report failures inside their panel.
- **Visual system:** shared spacing and motion tokens, quieter control borders, rounded panel geometry, stronger text hierarchy, tabular timing labels, visible focus, immediate pressed states, and compact-layout adjustments. Existing mascots, native typography, and five accent palettes remain.
- **Phone:** specific pending states, larger touch targets, masked pairing/typing fields, clearer ownership and offline states, visible QR preparation, and session expiry. Text clears only after a successful receipt; rejection keeps it available to retry. Reduced motion and pointer cancellation are handled. No ownership, stale-epoch, frame, or approval boundary is relaxed.

## Verification

The full Electron suite passed **67 cases** on Apple Silicon macOS. It includes real renderer/IPC interactions against disposable state, existing provider and Watch fixtures, proposal editing/use/dismiss, duplicate clicks, unsaved nested dialogs, attachment preview and cursor retention, and every settings section across two themes and five accents at 640px and 1440px. A separate case checks settings at 200% zoom in a 1440×900 window and emulates reduced motion.

Root verification passed **197 deterministic tests**, TypeScript, repository hygiene, and production build. Ten opt-in live tests are skipped in the default suite. The gateway passed typecheck, **27 tests**, companion integration, and a Worker-only deployment dry run. The ordinary container-building dry run required a running Docker daemon; the UI-only dry run used `--containers-rollout=none` and did not change a container.

The phone browser suite passed at 320px and 390px portrait and 844px landscape. It exercised pairing, confirmation, takeover, tap, keys, scrolling, zoom, successful and rejected typing, pending feedback, reduced motion, return instructions, approval, offline/reconnect, and forgetting credentials. These are deterministic Chromium checks, not physical iPhone or Android checks.

Two separately invoked live checks passed: Codex `gpt-5.6-sol` and OpenRouter `openai/gpt-5.2` each received the reviewed `interface_reviewer` role, returned a confirmed specialist report, and produced an attributed lead answer. The text-only checks used no external-account actions. Their single-run durations were about 19.6s and 6.7s respectively; these are observations, not benchmarks. The first Codex attempt exposed the missing native role registration and was fixed before the successful rerun.

A local Settings click fixture measured 30 samples after five warmups, timing the click through two animation frames. The initial measurement was approximately 33.4ms p50 and 33.5ms p95 on this Mac. This measures local rendering for that action only. It is not a provider, persistence, long-session, network, or physical-input latency claim.

## Reproduce the checks

```bash
npm run verify
npm run smoke:electron:full
GROKKY_SMOKE_VIEW=agent-proposal npm run smoke:electron
GROKKY_SMOKE_VIEW=settings-unsaved npm run smoke:electron
GROKKY_LIVE_PROPOSAL_UX=1 npx vitest run tests/provider-ux.integration.test.ts
```

The last command makes real model calls and needs existing provider credentials. `GROKKY_OPENROUTER_CREDENTIAL_PATH` can point to a private env file for this opt-in test. Never commit the file. Phone interaction checks run with `npm --prefix services/sandbox-gateway run smoke:phone-ui`; install Playwright Chromium first, or use the documented Chrome executable override.

## Coverage boundaries

The UI pass is implemented across the mapped surfaces; it is not a claim that every possible state or device is perfect. Physical iOS/Android behavior, assistive-technology use, a native Windows installation, long-session rendering under simultaneous tools/images, cold credential onboarding, and every live failure/teardown combination still need environment-specific evidence. The Settings timing fixture does not close the broader performance audit. Drafts remain window-local and do not survive quitting the app.

The phone page is served by the gateway. Committing its source does not update a deployed gateway; operators must deploy the Worker update before expecting the revised phone page. Desktop features in this release do not require a new gateway protocol.

Native role registration follows the official [subagent documentation](https://learn.chatgpt.com/docs/agent-configuration/subagents) and [configuration schema](https://learn.chatgpt.com/docs/config-schema.json). Historical audit findings and verification records remain available rather than being overwritten as universal passes.
