# Cloudflare computer deployment and operations

Research lock: 2026-08-29

This is the authoritative runbook for Grokky's disposable OpenRouter computer. It explains what the system is, which Cloudflare products it uses, how an action travels through the system, how to deploy it, how to pair it on macOS and Windows, how to operate it safely, and how to troubleshoot it.

The short version is simple: Grokky does not send OpenRouter a reusable cloud credential. Electron approves and precommits one bounded action, the Worker validates it, a Durable Object claims it, and a seat-specific Cloudflare Sandbox or Browser Run session executes it. The result returns with a receipt and, for browser actions, integrity-checked visual evidence plus a short-lived live browser view.

## Product boundary

The current computer provides:

- A separate Linux `/workspace` for each active OpenRouter agent seat
- Structured file listing, literal search, text reads, exact edits, and safe file creation
- Shell commands only when the conversation is explicitly set to Full access
- A reusable isolated Chromium session for public web navigation
- Browser-scoped clicks and typing inside a fixed 1280 by 800 viewport
- A signed interactive Browser Run Live View for the active session
- Saved PNG evidence after browser actions, with SHA-256 verification in Electron
- Explicit teardown plus idle expiry as a fallback

It is not:

- A copy of the user's Mac or Windows desktop
- A general Linux GUI or remote desktop
- A browser with the user's personal cookies or logged-in sessions
- A synchronized copy of the selected local project
- A place where OpenRouter, Codex, or runner credentials are injected

The cloud `/workspace` is independent. If a model creates a file there, Grokky must not claim that the local project changed. Controlled project synchronization is future work.

## Cloudflare components

| Component | Configuration in this repository | Why Grokky uses it |
| --- | --- | --- |
| Workers | `services/sandbox-gateway/src/index.ts` | HTTPS control plane, request validation, authentication, routing, and response shaping |
| Durable Objects | `GrokkyControl` and `GrokkySandbox` | Strongly consistent enrollment, revocation epochs, action claims, replay receipts, and browser-session metadata |
| Durable Object SQLite | Declared by the `v1` migration | Durable one-time enrollment and action receipt ledgers outside model-controlled storage |
| Sandbox SDK | `@cloudflare/sandbox` pinned in `package.json` | Isolated command and file execution inside Cloudflare Containers |
| Containers | `GrokkySandbox`, `lite`, maximum 8 | One disposable non-root `/workspace` execution environment per active seat |
| Browser Run | `BROWSER` binding | Isolated Chromium, Playwright control, screenshots, and live browser viewing |
| Browser Run Live View | `Cloudflare.getLiveView` over CDP | Short-lived signed interactive view at `live.browser.run` |
| Workers Observability | Logs at 100 percent, traces sampled at 5 percent | Request failures, deployment diagnosis, and operational visibility |

The current version does not use D1, KV, R2, Queues, Workflows, Workers AI, AI Gateway, Access, or a Cloudflare Tunnel. Durable Object SQLite is sufficient for the small control and receipt ledgers. Model traffic goes from Electron to OpenRouter; it does not pass through the gateway.

## Architecture

```mermaid
flowchart LR
  subgraph Desktop[Mac or Windows Grokky app]
    UI[Renderer]
    MAIN[Electron main process]
    POLICY[Computer policy and approvals]
    MODEL[OpenRouter tool loop]
    EVIDENCE[Private evidence store]
    UI --> MAIN
    MAIN --> POLICY
    MODEL --> POLICY
    MAIN --> EVIDENCE
  end

  subgraph Cloudflare[Cloudflare account]
    WORKER[Sandbox gateway Worker]
    CONTROL[GrokkyControl Durable Object]
    SEAT[GrokkySandbox Durable Object]
    CONTAINER[Non-root Sandbox container]
    BROWSER[Browser Run session]
    LIVE[Signed Live View]
    WORKER --> CONTROL
    WORKER --> SEAT
    SEAT --> CONTAINER
    SEAT --> BROWSER
    BROWSER --> LIVE
  end

  MODEL -->|proposed tool call| POLICY
  POLICY -->|approved action lease over HTTPS| WORKER
  WORKER -->|receipt and bounded output| MAIN
  BROWSER -->|PNG and digest| MAIN
  LIVE -->|interactive stream| UI
```

## Trust zones and stored data

| Location | Data stored there | Data deliberately absent |
| --- | --- | --- |
| Electron renderer | Renderer-safe application snapshot and active Watch URL | Provider keys, device token, Worker secrets, Node handles |
| Electron main process | OpenRouter key, encrypted paired-device token, active signed Live View URL in memory | Worker enrollment and signing secrets |
| Application data | Conversations, audits, seat history, verified PNG evidence, encrypted paired-device token | Plaintext remote token, Worker secrets |
| `GrokkyControl` Durable Object | Used enrollment digests, device IDs, token epochs, revocation state | Enrollment plaintext, provider credentials, conversations |
| `GrokkySandbox` Durable Object | Action IDs, argument digests, receipt IDs, bounded outputs, saved browser artifact metadata, browser session metadata | Live View URL, provider credentials, local files |
| Sandbox container | Seat-specific `/workspace` and command processes | Grokky state, local project, provider key, device token, Worker bindings |
| Browser Run | Empty isolated browser state for the seat | Personal browser cookies and local desktop state |

Electron uses the operating system's secure storage for the paired device credential. On macOS this is backed by Keychain. On Windows it is backed by the operating system credential protection available through Electron `safeStorage`. Conversation state never contains the plaintext token.

The Live View URL is treated as a credential. The gateway requests it for at most one hour, validates that it is HTTPS on the exact `live.browser.run` host with a `/ui/` path, returns it only with an active browser action, and omits it from the Durable Object receipt. Electron repeats the host and path validation, keeps the URL only in memory, uses a no-referrer embed, and clears it when the seat ends.

## Source map

| File | Responsibility |
| --- | --- |
| `services/sandbox-gateway/wrangler.jsonc` | Worker name, bindings, compatibility date, observability, container, and Durable Object migration |
| `services/sandbox-gateway/Dockerfile` | Pinned Sandbox base image and non-root `/workspace` |
| `services/sandbox-gateway/src/index.ts` | HTTP routes, bounded request reader, authentication, execution dispatch, and response limits |
| `services/sandbox-gateway/src/control.ts` | One-time enrollment, device registry, epochs, and revocation |
| `services/sandbox-gateway/src/protocol.ts` | Canonical digests, signed device tokens, request schemas, path rules, and URL boundary |
| `services/sandbox-gateway/src/sandbox.ts` | Action receipt ledger, container lifecycle, Browser Run, network interception, screenshots, and Live View |
| `src/main/computer-access.ts` | Desktop pairing, token storage, heartbeat, policy, action leases, remote calls, and artifact validation |
| `src/main/agent-computer.ts` | Per-agent seat lifecycle, attribution, action history, and evidence contract |
| `src/main/agent-computer-electron.ts` | Private browser profiles, evidence storage, hashing, and cleanup |
| `src/main/controller.ts` | Run ownership, seat assignment, teardown, live state, and persistence |
| `src/main/providers/openrouter-provider.ts` | Bounded model tool loop and computer tool descriptions |
| `src/renderer/src/App.tsx` | Watch panel, Live and History modes, zoom, fit, full screen, resizing, and approval UI |

## Enrollment sequence

Enrollment converts one high-entropy, one-time bootstrap value into a revocable device credential.

```mermaid
sequenceDiagram
  autonumber
  participant O as Operator
  participant G as Grokky main process
  participant W as Worker
  participant C as GrokkyControl DO

  O->>W: Configure enrollment and signing secrets
  O->>G: Endpoint plus one-time enrollment key
  G->>W: POST /pair
  W->>W: Constant-time enrollment comparison
  W->>C: Claim SHA-256 enrollment digest
  C->>C: Reject if digest was used before
  C-->>W: New device ID and epoch 1
  W->>W: Mint HMAC-signed device token
  W-->>G: Device metadata, capabilities, token, epoch
  G->>G: Encrypt token with OS secure storage
  G->>W: POST /heartbeat with Bearer token
  W->>C: Confirm device epoch is current
  W-->>G: Online capabilities
```

The raw enrollment key is not stored in Durable Object SQLite. Only its SHA-256 digest is recorded after successful use. Reusing the same key fails even if the configured Worker secret has not yet been rotated.

The signed device token contains only a version, device ID, epoch, and issued-at timestamp. Every authenticated request checks the signature and then asks the device-specific control object whether that epoch is still current. Revocation advances the epoch and immediately makes the prior token stale.

## Action sequence

```mermaid
sequenceDiagram
  autonumber
  participant M as OpenRouter model
  participant P as Desktop policy
  participant W as Worker
  participant S as Seat Durable Object
  participant X as Sandbox or Browser Run
  participant V as Watch panel

  M->>P: Propose one structured tool call
  P->>P: Validate capability, access mode, device, target, and approval
  P->>P: Commit audit ID plus canonical argument digest
  P->>W: POST /execute with bearer and short action lease
  W->>W: Bound body, parse schema, authenticate device, recompute digest
  W->>S: Claim action ID and argument digest
  alt First valid claim
    S-->>W: Accepted with receipt ID
    W->>X: Execute in seat-specific environment
    X-->>W: Bounded output and optional PNG, digest, Live View URL
    W->>S: Persist completed receipt without Live View URL
    W-->>P: Receipt, output, and visual artifact
  else Completed duplicate
    S-->>W: Original receipt and stored result
    W-->>P: Same result with replayed=true
  else In-flight duplicate
    S-->>W: Outcome still unknown
    W-->>P: 409, never execute again
  end
  P->>P: Verify PNG signature, dimensions, size, and SHA-256
  P->>V: Save evidence and publish live state
  P-->>M: Tool result plus current visual context
```

Each lease is bound to:

- Device identity
- Conversation ID
- Agent-computer seat ID
- Action ID
- Canonical SHA-256 digest of the arguments
- Expiry

The normal desktop lease is two minutes. The gateway accepts only safe clock skew and refuses leases beyond five minutes. A duplicate action ID with different arguments is an error. An in-flight duplicate is reported as inconclusive because silently retrying a side effect would be unsafe.

## Browser sequence and live viewing

1. The desktop authorizes `browse_url`, `capture_screen`, `open_application`, `click_screen`, or `type_text`.
2. The gateway validates the URL, coordinate, text length, or supported application name.
3. The seat Durable Object reconnects to its prior Browser Run session, or acquires a new one with ten minutes of keep-alive.
4. Playwright fixes the viewport to 1280 by 800 and installs a request route before navigation.
5. The route blocks credential-bearing URLs, private and local literal addresses, and unauthorized top-level host changes.
6. The action runs in the same seat browser so cookies created inside that isolated session and page state can continue for the run.
7. The gateway extracts readable body text, takes a viewport PNG, computes its SHA-256, and requests a signed Live View URL over the Cloudflare DevTools Protocol.
8. Electron validates and stores the PNG, exposes it as History, and shows the signed page as Live.
9. Fit, 100 to 300 percent zoom, scroll-to-pan, panel resizing, and full screen operate in the renderer. Browser input in Live View is interactive and the next tool action still produces an audited saved frame.
10. Run completion, cancellation, conversation deletion, or explicit device disposal closes Browser Run and destroys the command container. Browser inactivity and the five-minute container idle sleep are fallbacks.

Live View does not exist before the first successful browser action. The saved History frames remain available after the signed Live URL expires.

## Prerequisites

For app users:

- Grokky on Apple Silicon macOS or Windows x64
- An OpenRouter API key saved through Grokky Settings
- The deployed gateway HTTPS URL
- A fresh one-time enrollment key

For gateway operators:

- A Cloudflare account with a Workers Paid plan
- Access to Cloudflare Workers, Durable Objects, Containers, Sandbox SDK, and Browser Run
- Node.js 20.19 or newer and npm 10 or newer
- Wrangler authentication for the target Cloudflare account
- Docker when building the custom Sandbox image locally or during deployment

Cloudflare limits and pricing can change. Review the current [Sandbox platform limits](https://developers.cloudflare.com/sandbox/platform/limits/), [Browser Run limits](https://developers.cloudflare.com/browser-rendering/platform/limits/), and [Containers pricing](https://developers.cloudflare.com/containers/pricing/) before production use. The repository caps concurrent container instances at eight, but account and product limits may be lower or impose additional usage controls.

## First deployment

Run these commands from the repository root. Secret values are entered interactively by Wrangler and must never be written into tracked files, issue comments, chat messages, or CI logs.

```bash
cd services/sandbox-gateway
npm ci
npm run verify
npx wrangler whoami
docker info
npm run secrets:new
npx wrangler secret put GROKKY_ENROLLMENT_TOKEN
npx wrangler secret put GROKKY_TOKEN_SECRET
npm run deploy
```

`npm run secrets:new` prints two independent values:

- `GROKKY_ENROLLMENT_TOKEN`: starts with `gsk_` and is used once to pair one installation
- `GROKKY_TOKEN_SECRET`: independently signs all device tokens and stays only in the Worker secret binding

Paste each value only into its matching Wrangler prompt. Save the one-time enrollment key temporarily in an approved secret manager so it can be entered into Grokky. Keep the signing secret in the Cloudflare secret binding. Never reuse an OpenRouter key, Codex credential, local runner token, or the same random value for both bindings.

`wrangler deploy` builds the Dockerfile, publishes the Worker and Durable Object migration, and begins the container rollout. A Worker script update and its container image rollout are not transactional. The first deployment can take several minutes. Retain the previous known-good deployment until the new container image is healthy.

Wrangler prints the deployed `https://...workers.dev` endpoint. Save only the endpoint, not its query string or a Live View URL.

### Verify the endpoint

```bash
curl --fail --silent --show-error https://YOUR-WORKER.workers.dev/health
```

Expected properties include:

```json
{
  "ok": true,
  "service": "grokky-sandbox-gateway",
  "isolation": "disposable-container",
  "capabilities": ["files", "commands", "browser", "screen", "automation"]
}
```

The health route does not provision a container and does not require a bearer token. It intentionally returns no secret or device metadata.

## Pair Grokky

On macOS or Windows:

1. Open Grokky.
2. Open Settings.
3. Select Computer access.
4. Select Pair computer.
5. Enter the deployed HTTPS Worker endpoint.
6. Enter the fresh `gsk_...` enrollment key.
7. Complete pairing once.
8. Select Grokky Cloud Sandbox as the active computer.
9. Run the capability test from the device controls.
10. Confirm that files, commands, browser, screen, and automation report available.

After successful pairing, rotate `GROKKY_ENROLLMENT_TOKEN` to a new unused value or remove access to the temporary plaintext copy. A used digest cannot enroll again, but rotating the configured secret prevents unnecessary reuse attempts and prepares the next controlled enrollment.

The desktop sends an authenticated heartbeat every 30 seconds. A paired device with no successful heartbeat for 90 seconds is shown offline and is not scheduled for new OpenRouter work.

## Test the complete computer

Create an OpenRouter session, select the cloud computer, set Full access, and send this safe proof prompt:

```text
Use your cloud computer to open https://example.com. Tell me the page title, click no links, and capture the screen. Then run printf 'Grokky cloud command works\n' > grokky-proof.txt && cat grokky-proof.txt. Do not submit any form or sign in anywhere. Report the exact command output.
```

Verify all of these outcomes:

- The browser action asks only according to the selected computer policy.
- Watch opens for the active agent and displays a useful live viewport after the first browser action.
- Live can be resized, fit, zoomed, panned, and opened full screen.
- History contains a readable 1280 by 800 action frame.
- The page title is reported accurately.
- The command returns `Grokky cloud command works`.
- The timeline attributes both browser and command actions to the correct agent seat.
- Stopping the run tears down the seat without another model action.

The command file exists only in the disposable cloud `/workspace`.

## Windows use and deployment

Using the cloud computer from Windows does not require Docker, Wrangler, WSL, or a local browser extension. The installed Grokky app talks to the same HTTPS Worker as macOS. Pairing, OS-protected token storage, OpenRouter commands, cloud files, Browser Run, Live and History, Watch resizing, zoom, full screen, approvals, and audit receipts use platform-neutral Electron and HTTPS code.

Windows does not currently provide Grokky-owned capture or control of the user's native Windows desktop. Select Grokky Cloud Sandbox when screen or automation tools are needed. This is a different boundary from the cloud computer and does not reduce its capabilities.

An operator who wants to deploy the gateway from Windows needs Node.js, npm, Docker Desktop, and Wrangler. In PowerShell:

```powershell
Set-Location services/sandbox-gateway
npm ci
npm run verify
npx wrangler whoami
docker info
npm run secrets:new
npx wrangler secret put GROKKY_ENROLLMENT_TOKEN
npx wrangler secret put GROKKY_TOKEN_SECRET
npm run deploy
```

Do not place the generated values in PowerShell history manually. Use Wrangler's interactive prompt. For local development only, copy `.dev.vars.example` to ignored `.dev.vars` and fill it through a trusted editor or secret injection mechanism:

```powershell
Copy-Item .dev.vars.example .dev.vars
npm run dev
```

The Windows installer is built on a native `windows-2022` GitHub runner. The workflow runs TypeScript, tests, the production build, and all responsive Electron fixtures on Windows before creating the NSIS package. It then verifies that `codex.exe` is unpacked outside `app.asar` before uploading the installer artifact. See [Windows support and release](WINDOWS.md).

## Local development

Docker Desktop must be running before `wrangler dev` can start the Sandbox container.

```bash
cd services/sandbox-gateway
npm ci
cp .dev.vars.example .dev.vars
npm run typegen
npm run verify
npm run dev
```

Replace the two placeholders in `.dev.vars` with independently generated local values. The file and `.wrangler` state are ignored. `worker-configuration.d.ts` is generated by Wrangler during type checking and is intentionally ignored so it always reflects the installed Wrangler and Cloudflare types.

Wrangler's local Sandbox helper currently uses elevated Docker capabilities for Sandbox filesystem behavior. Local mode is suitable for trusted protocol and integration fixtures. It is not the production hostile-code isolation boundary. Do not connect a live model to local `wrangler dev` and invite untrusted command execution on the host.

## HTTP API

| Method and path | Authentication | Purpose | Creates compute? |
| --- | --- | --- | :---: |
| `GET /health` | None | Service identity and capability discovery | No |
| `POST /pair` | One-time enrollment key in JSON | Enroll one device and return its signed token | No |
| `POST /heartbeat` | Bearer device token | Confirm token epoch and refresh capabilities | No |
| `POST /test` | Bearer device token | Provision a disposable capability probe, then destroy it | Yes |
| `POST /execute` | Bearer device token plus action lease | Claim and execute one bounded seat action | Yes |
| `POST /dispose` | Bearer device token plus seat identity | Close Browser Run and destroy the seat container | Existing seat only |
| `POST /revoke` | Bearer device token | Advance the device epoch and invalidate that token | No |

All JSON request bodies are streamed through a 300,000-byte hard limit even if `Content-Length` is missing or false. Tool output is capped at 120,000 bytes. Browser PNGs are capped at 4,000,000 bytes. File content, paths, search queries, commands, text input, allowlists, IDs, and timestamps have separate schema limits.

## Security controls

### Authentication and revocation

- One-time high-entropy enrollment with a stored digest, not stored plaintext
- HMAC-SHA-256 signed device tokens
- Constant-time Web Crypto verification
- Per-request server-side epoch check
- Immediate revocation by advancing the epoch
- No long-lived device bearer in the renderer or model context

### Action integrity

- Approval before remote execution when policy requires it
- Canonical argument digest committed in Electron
- Worker recomputation and equality check
- Short expiry
- Conversation and agent-seat binding
- Durable first-writer action claim before execution
- Replay of completed results without duplicate side effects
- In-flight duplicates reported as unknown rather than retried

### Files and commands

- Seat-specific container ID derived from device, conversation, and agent seat
- Non-root UID 1000
- Fixed `/workspace` working directory
- Fixed small environment: `HOME`, `CI`, and `NO_COLOR`
- No provider credential, device bearer, Worker binding, or local home mounted into the container
- Relative paths only
- Traversal, backslashes, excluded build directories, credential filenames, and private-key extensions blocked
- UTF-8 text only for reads and edits
- Exact unique old-text replacement for edits
- Commands require Full access in both Electron and the Worker
- Argument-array process launch for gateway-owned commands
- Explicit timeouts and output caps

`run_command` intentionally invokes `/bin/bash -lc` with the model's approved command as one argument. That command is arbitrary inside the disposable container. The security boundary is the isolated container and explicit Full access approval, not a pretend shell allowlist.

### Browser

- HTTP and HTTPS only
- Credential-bearing URLs blocked
- Localhost, private IPv4 ranges, link-local, mapped IPv4, local suffixes, and non-public IPv6 classes blocked before navigation
- Top-level navigation restricted to the approved or allowlisted host set
- Fixed coordinate bounds of 1280 by 800
- Text input capped at 20,000 characters
- Application names limited to Browser, Terminal, and Files concepts
- Empty Browser Run profile with no personal cookies
- Bounded screenshot plus digest
- Live URL exact-host validation and memory-only lifecycle

### Desktop

- Context-isolated, sandboxed renderer with no Node integration
- Typed and validated IPC bridge
- Device token encrypted by OS secure storage
- Evidence written to application-owned storage
- PNG format, size, dimensions, and digest checked before display or model reuse
- Active Live URL omitted from persisted conversation state
- Explicit stop and teardown paths

## Secret rotation

### Enrollment key

Rotate the enrollment key after each successful pairing:

```bash
cd services/sandbox-gateway
npm run secrets:new
npx wrangler secret put GROKKY_ENROLLMENT_TOKEN
```

Use only the newly generated `gsk_...` value from that run. Updating this secret does not disconnect already paired devices because their signed device token is checked with the independent signing secret and server-side epoch.

### Token-signing secret

Rotating `GROKKY_TOKEN_SECRET` invalidates every existing paired-device token at once:

```bash
npx wrangler secret put GROKKY_TOKEN_SECRET
```

After this emergency or planned rotation, generate a new enrollment key and pair every authorized Grokky installation again. Do not rotate the signing secret casually during an active run.

### One device

Use Revoke in Grokky's Computer access settings when only one paired installation should lose access. The gateway advances that device's epoch. The old token remains cryptographically well-formed but fails the server-side epoch check.

## Updating and rollback

1. Read current Cloudflare Workers, Sandbox, Containers, Browser Run, and Wrangler release documentation.
2. Update dependencies and the pinned Docker base together when the Sandbox SDK requires it.
3. Run `npm ci` and `npm run verify` in the gateway.
4. Run the root `npm run verify` and `npm run smoke:electron`.
5. Inspect the Wrangler dry-run bundle and generated binding types.
6. Deploy from a clean commit.
7. Wait for both Worker and container rollout to settle.
8. Call `/health`.
9. Run the disposable capability test from Grokky.
10. Run the complete safe proof prompt.
11. Check logs, traces, container usage, and teardown.

Cloudflare Worker code and the referenced container image do not roll out atomically. If the new Worker contract is incompatible with the old image, design an additive transition or deploy a new Worker name. A rollback must restore both compatible Worker code and container image. Use Cloudflare's deployment/version controls and verify a real test seat after rollback rather than assuming the script rollback also restored compute behavior.

## Operations

### Health and status

- `/health` proves the Worker route and static capability declaration are reachable.
- Pairing proves Worker secrets and the control Durable Object migration are correct.
- Heartbeat proves the device token, epoch, and desktop network path are valid.
- The capability test proves a real container or browser can be acquired and destroyed.
- A complete browser and command prompt proves the model loop, policy, action ledger, Live View, evidence, and teardown paths together.

Do not treat `/health` alone as proof that Containers or Browser Run can currently provision.

### Logs and traces

Use the Cloudflare dashboard or Wrangler tail against the deployed Worker:

```bash
npx wrangler tail grokky-sandbox-gateway
```

Gateway failures are logged as structured JSON with a generated request ID, route path, and bounded error message. User secrets, bearer tokens, request bodies, and Live View URLs are not intentionally logged. A request error returns its request ID so the operator can correlate it without asking the user for credentials.

### Capacity and cost

- `max_instances` is eight in `wrangler.jsonc`.
- Each active agent seat derives its own Sandbox Durable Object and may consume one container instance.
- Browser Run capacity and billing are separate from Containers.
- A capability test provisions compute briefly and destroys it.
- Browser sessions request ten minutes of keep-alive.
- Containers sleep after five idle minutes and are explicitly destroyed on teardown.
- Live View URLs expire after at most one hour in this implementation.

Set Cloudflare usage notifications and limits appropriate to the intended number of simultaneous lead and specialist seats. Spreading a large OpenRouter crew can increase concurrent compute.

## Troubleshooting

### The device is offline

- Confirm the endpoint is HTTPS and `/health` responds.
- Confirm the local clock is correct.
- Confirm the Worker was not renamed or moved to another account.
- Check Wrangler tail for authorization failures.
- If the signing secret changed, revoke the stale entry and pair again with a new enrollment key.
- If only one device was revoked, that device must be paired again.

### Pairing says the enrollment key is invalid or already used

- Confirm the value begins with `gsk_` and was copied without spaces.
- Confirm it matches the currently deployed `GROKKY_ENROLLMENT_TOKEN` secret.
- A successful key is one-time by design. Generate and deploy a fresh key for another installation.
- Do not change `GROKKY_TOKEN_SECRET` unless all devices should be re-paired.

### The capability test passes files but commands are unavailable

- The gateway may advertise commands, but OpenRouter exposes `run_command` only when the conversation is set to Full access.
- Confirm Grokky Cloud Sandbox is the selected online computer.
- Confirm the model is OpenRouter. Codex uses its own local SDK runtime.

### Live is blank or says there are no frames

- Live View is created only after the first successful cloud browser action.
- Ask the agent to `browse_url` or capture the browser screen.
- Select Live, then Fit. Widen the Watch panel by dragging its left edge or use full screen.
- If History works but Live does not, the signed URL may have expired or Browser Run may be temporarily unable to issue it. Start another browser action to refresh it.
- Confirm embedded navigation to `https://live.browser.run/ui/...` is allowed and no local security product is blocking that host.
- Saved History is the fallback evidence and should remain visible after Live expires.

### The screen is visible but too small

- Drag the Watch panel divider left to widen it.
- Select Fit for the complete 1280 by 800 viewport.
- Use plus and minus for 100 to 300 percent zoom.
- Scroll inside the viewport to pan when zoomed.
- Use the full-screen control for the largest view.

### The agent keeps asking for approval

- Choose Allow all for this agent run only when the exact run and selected cloud boundary are trusted.
- Run-wide approval applies to that agent run, not every future conversation or device.
- Hostname approval and Full access remain separate constraints.
- If prompts continue for the same capability and run, inspect the audit target and confirm the seat did not restart or change devices.

### The first action is slow

Cloudflare may need to acquire Browser Run or start the container image. The first deployment and a cold seat are expected to be slower than subsequent actions. Check container rollout and account limits if acquisition consistently times out.

### An action reports that its outcome is unknown

The Durable Object already has an accepted receipt but no completed result. Grokky deliberately does not execute the same side effect again. Inspect the target state or start a new explicit action with a new action ID after deciding whether a retry is safe.

### A browser navigation is blocked

- The initial hostname must be approved once or present in Grokky's network allowlist.
- Top-level redirects to another hostname are blocked unless that host is also allowed.
- Private, local, and credential-bearing URLs are never supported by this browser boundary.
- Subresources still pass the public-address validator.

### Deployment fails while building the image

- Confirm Docker Desktop or the Docker engine is running.
- Confirm `docker info` succeeds for the same user.
- Confirm the Sandbox SDK package and `cloudflare/sandbox` Docker tag remain compatible.
- Confirm the Cloudflare account has the required paid Workers and Containers access.
- Run `npm run verify` before another deployment attempt.

### Windows SmartScreen blocks the installer

Current workflow artifacts are unsigned development installers. Confirm the repository, workflow run, branch, and commit before choosing to continue. Production distribution requires a trusted Windows code-signing certificate. SmartScreen is unrelated to the Cloudflare pairing credential.

## Release acceptance checklist

- [ ] Root `npm ci` completes from the lockfile.
- [ ] Root `npm run verify` passes.
- [ ] Root `npm run smoke:electron` passes on macOS and Windows CI.
- [ ] Gateway `npm ci` completes from its lockfile.
- [ ] Gateway `npm run verify` generates types, typechecks, tests, and produces a Wrangler dry-run bundle.
- [ ] Wrangler is authenticated to the intended account.
- [ ] Docker is available for the deployment build.
- [ ] Both Worker secrets are configured independently.
- [ ] `/health` succeeds on the deployed HTTPS endpoint.
- [ ] Pairing succeeds exactly once with the enrollment key.
- [ ] Heartbeat shows the device online with all five capabilities.
- [ ] The disposable capability test succeeds and cleans up.
- [ ] Full access is required before OpenRouter receives `run_command`.
- [ ] A browser test yields readable Live and History views.
- [ ] Resize, Fit, zoom, pan, and full screen remain usable at narrow and wide desktop sizes.
- [ ] The saved PNG digest is accepted and the frame is attached to the correct agent seat.
- [ ] A stopped or completed run closes its Browser Run session and destroys its container.
- [ ] Revoking a test device makes its prior bearer fail.
- [ ] Worker logs contain no enrollment key, signing secret, bearer, model key, or signed Live URL.
- [ ] Cloudflare usage alerts and `max_instances` fit the intended crew size.
- [ ] macOS DMG and Windows NSIS artifacts come from the same green commit.

## Official references

- [Cloudflare Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
- [Cloudflare Sandbox SDK overview](https://developers.cloudflare.com/sandbox/)
- [Sandbox architecture](https://developers.cloudflare.com/sandbox/concepts/architecture/)
- [Sandbox Wrangler configuration](https://developers.cloudflare.com/sandbox/configuration/wrangler/)
- [Sandbox transport and local security](https://developers.cloudflare.com/sandbox/configuration/transport/)
- [Sandbox lifecycle](https://developers.cloudflare.com/sandbox/api/lifecycle/)
- [Sandbox platform limits](https://developers.cloudflare.com/sandbox/platform/limits/)
- [Cloudflare Containers](https://developers.cloudflare.com/containers/)
- [Deploying Containers](https://developers.cloudflare.com/containers/deploy/)
- [Workers connecting to Containers](https://developers.cloudflare.com/sandbox/guides/workers-connections/)
- [Browser Run Live View](https://developers.cloudflare.com/browser-run/features/live-view/)
- [Browser Run limits](https://developers.cloudflare.com/browser-rendering/platform/limits/)

Recheck these first-party pages when changing versions or before a production deployment. Sandbox SDK and Containers behavior can evolve faster than the desktop application.
