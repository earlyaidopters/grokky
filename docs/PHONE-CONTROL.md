# Phone control

Version 0.1.4 adds a mobile web companion for a running OpenRouter task on a paired Cloudflare computer. The Mac still runs the model and must remain awake with Grokky open.

## Use it

1. Start an OpenRouter task with the cloud computer selected.
2. Open **Watch**, expand **Control from your phone**, and select **Pair phone**.
3. Scan the QR code within two minutes. Confirm the claimed phone in the desktop app.
4. Watch the latest browser frame, approve or deny an individual pending action, or select **Take control**.
5. After Grokky acknowledges the pause, tap the browser, zoom for precise targeting, type into the focused field, use Tab/Enter/Escape/Backspace, or scroll.
6. Select **Return to Grokky**, optionally with an instruction. Grokky discards its old planned actions and must inspect the page before new browser input.

Pairing is scoped to one active task and expires after 30 minutes. Disconnecting while a human owns the browser stops the task. Stop also closes the browser seat. A lost phone connection never silently returns control to the model. Use **Return control to Grokky** on the desktop to recover, or stop the task. Closing or restarting Grokky interrupts the run; active handoffs do not resume automatically.

Phone watch uses the latest action frame, rather than video streaming. During human control, an additional frame refresh every minute keeps the retained tab active and captures delayed page changes. **Refresh frame** updates it immediately. Browser actions still require a gateway round trip.

## Implementation

The phone receives a revocable companion token after claiming a single-use invite and receiving desktop confirmation. The QR secret is in a URL fragment, immediately removed from browser history. The phone token lives in that tab's session storage. The phone receives neither the cloud device credential nor a raw Browser Run Live View URL.

One SQLite Durable Object per pairing stores token hashes, expiration, confirmation, and command identities. Latest frames, human command text, pending commands, and recent outcomes remain in memory. Desktop polling runs every 1.5 seconds; phone polling runs every two seconds while visible. Unchanged frames are omitted in both directions. The relay allows one pending command; the desktop executes one at a time. HTTP polling was chosen for the initial release to keep command delivery and failure handling explicit. Hibernating WebSockets remain a possible later efficiency improvement.

The desktop owns the execution gate. Takeover blocks new agent actions, waits for in-flight actions to settle, and changes the control epoch before granting human input. Phone commands carry an epoch and, for page input, a frame identity. The relay and desktop reject stale input. Each provider loop checks ownership around model requests and before tools. Returning control invalidates planned responses and requires a fresh page observation. Repeated no-progress browser actions request intervention when a confirmed phone is available.

Human action receipts preserve metadata and completion, but omit screenshots, observations, and page text. Human input does not enter the model transcript while the phone owns the browser. After return, ordinary model observation resumes: visible content left on the page can then be read by the model. Browser sessions and third-party sites retain their normal state.

Browser request construction retains the two newest tool-image messages and all textual evidence by default. User attachments remain intact, and requests explicitly comparing historical screenshots retain historical frames. Local evidence is preserved. Activity shows cumulative message payload size and model-request waiting time for the main tool loop; these are diagnostics, not a measured speed or billing improvement. Full gateway phase profiling remains future work.

Watch now keys its Live View cache by browser session and the exact page target, preventing same-URL tabs from sharing a cached view. Builds expose version, source identity, and UTC build time in the phone panel.

## Verification

The September 8, 2026 implementation was checked with:

- `npm run verify`: 176 passing tests, six opt-in live tests skipped; hygiene, TypeScript and production build pass.
- `npm run smoke:electron:full`: 53 desktop UI cases, including pairing QR rendering at compact and wide sizes.
- Gateway typecheck and 27 unit tests; Wrangler deployment bundle validated without changing the container image.
- `npm --prefix services/sandbox-gateway run smoke:companion`: real local Worker routes, device authorization, origin checks, single-use pairing, confirmation, serialized commands, duplicate delivery, stale frame/epoch, ownership, unchanged-frame omission and revocation.
- `npm --prefix services/sandbox-gateway run smoke:phone-ui`: browser automation at 320px and 390px portrait widths and landscape, including typing, zoom, approvals, offline/reconnect and forgetting credentials. Install Chromium with `npx playwright install chromium`, or set `GROKKY_CHROME_EXECUTABLE` to an installed Chrome executable.
- `npm run smoke:phone`: packaged-app canary against the paired production gateway, using disposable local state and a disposable cloud seat. Exercises the real controller, pairing, confirmation, takeover, tap/type/Tab, same-tab state after resume, stale input rejection, revocation and redacted human action replay receipts. It does not call a model or change the user's conversation state.

Physical iOS Safari and Android Chrome testing remains outstanding, particularly software keyboards, rotation with the keyboard open, camera QR scanning, and background/sleep behavior. Windows packaging was not exercised locally. This first release supports cloud-browser control, not arbitrary native desktop input or operation while the Mac sleeps. Push notifications are not included.

The root application dependency audit is clean. The gateway's development toolchain currently reports the upstream Sharp/libheif advisory through Miniflare/Wrangler; it is not a deployed Worker dependency. Avoid an automatic major downgrade of Wrangler as an audit workaround.

## Deployment and rollback

Deploy the gateway with its `COMPANION` binding and `v2-companion` SQLite migration before installing 0.1.4. For a Worker-only change, `npx wrangler deploy --containers-rollout=none` preserves the current container image. A deployment touching the Dockerfile or container dependencies must build and roll out that image normally.

Build the Mac app with `npm run package:mac:dir`; the packaging script verifies the bundled Codex executable. Preserve a ZIP of the previous application before replacing it, and quit Grokky only when its tasks are idle. Retain user data separately; installing the new bundle does not require deleting it.

To roll back the desktop, quit Grokky and restore the previous app bundle from the saved ZIP. The new gateway remains backward compatible with the prior desktop. Do not delete the new Durable Object namespace or revert its migration during a desktop rollback. If the gateway itself needs rollback, inspect current Wrangler deployment state and migration compatibility first.
