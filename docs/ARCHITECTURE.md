# Grokky architecture

This document describes the implementation that ships in this repository. It separates product behavior from provider-specific behavior so future work can extend one layer without weakening another.

## System context

```mermaid
flowchart TB
  USER[User] --> APP[Grokky desktop app]
  APP --> WORKSPACE[Selected local workspace]
  APP --> CODEX[Codex SDK and local Codex runtime]
  APP --> OPENROUTER[OpenRouter API]
  APP --> CODEXHOME[Codex home configuration]
  APP --> OS[Native OS permission services]
  APP --> RUNNER[Optional private file runner]
  APP --> GATEWAY[Optional Sandbox gateway]

  CODEX --> OPENAI[OpenAI services]
  OPENROUTER --> MODELS[OpenRouter models and server tools]
  RUNNER --> REMOTEWORKSPACE[Bounded remote workspace]
  GATEWAY --> SEATVM[Per-seat disposable Linux container]
```

Grokky owns the desktop interface, local persistence, typed boundary, provider normalization, OpenRouter tool loop, access policy, and remote runner. Codex owns its native thread runtime, authentication, SDK tools, skills, MCP execution, connectors, and child-thread implementation. OpenRouter owns model routing and server-side tools.

## Electron trust boundary

```mermaid
flowchart LR
  subgraph Untrusted renderer
    REACT[React application]
    CSS[Custom design system]
  end

  subgraph Sandboxed bridge
    PRELOAD[contextBridge API]
  end

  subgraph Trusted main process
    IPC[Validated IPC handlers]
    CONTROLLER[MainController]
    STATE[StateStore]
    AGENTS[AgentService]
    CAPS[CapabilitiesService]
    ACCESS[ComputerAccessService]
    AGENTBROWSER[Ephemeral agent browser host]
    CODEXPROVIDER[Codex provider]
    ORPROVIDER[OpenRouter provider]
  end

  REACT --> PRELOAD
  PRELOAD --> IPC
  IPC --> CONTROLLER
  CONTROLLER --> STATE
  CONTROLLER --> AGENTS
  CONTROLLER --> CAPS
  CONTROLLER --> ACCESS
  CONTROLLER --> AGENTBROWSER
  CONTROLLER --> CODEXPROVIDER
  CONTROLLER --> ORPROVIDER
```

The renderer runs with:

- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox: true`
- A preload exposing only the `GrokkyApi` contract
- External navigation blocked and web links opened through a validated main-process handler

The renderer receives complete application snapshots. It never receives a provider key, runner bearer token, Codex auth record, unrestricted filesystem handle, shell handle, or Node primitive.

## Source ownership

| Layer | Primary files | Responsibility |
| --- | --- | --- |
| Shared contracts | `src/shared/contracts.ts` | Serializable domain types, provider IDs, IPC names, UI snapshots |
| Runtime validation | `src/shared/validation.ts` | Validate every renderer-controlled IPC payload |
| Preload | `src/preload/index.ts` | Convert the allowlisted API into `ipcRenderer.invoke` calls |
| Controller | `src/main/controller.ts` | Coordinate conversations, providers, tools, state, cancellation, and snapshots |
| Codex adapter | `src/main/providers/codex-provider.ts` | Configure SDK threads and normalize SDK events |
| OpenRouter adapter | `src/main/providers/openrouter-provider.ts` | Run chat, tools, web research, and crew synthesis |
| Access gate | `src/main/computer-access.ts` | Resolve policy, approvals, target device, browser safety, and audit |
| Agent computers | `src/main/agent-computer*.ts` | Create identity-bound browser seats, private profiles, and integrity-checked evidence |
| Workspace tools | `src/main/workspace-tools.ts` | Enforce path, file, edit, and command boundaries |
| Native host | `src/main/computer-host-electron.ts` | Screen capture, Accessibility actions, and encrypted token storage |
| Remote runner | `src/main/runner-service.ts` | Expose paired, bounded workspace tools on another computer |
| Sandbox gateway | `services/sandbox-gateway/` | Enforce enrollment, authenticated liveness, per-seat action leases, replay-safe receipts, and disposable container execution |
| Capabilities | `src/main/capabilities.ts` | Discover and toggle Codex skills, MCP servers, and connectors |
| Agents | `src/main/agents.ts` | Discover, create, update, and delete Codex TOML agents |
| State | `src/main/state-store.ts` | Normalize, migrate, and atomically persist local state |
| Renderer | `src/renderer/src` | Present sessions, messages, activity, crews, settings, and approvals |

## Snapshot state model

The main process is authoritative. React does not optimistically own durable conversation state.

```mermaid
stateDiagram-v2
  [*] --> Idle
  Idle --> Running: send message
  Running --> Running: activity, usage, crew event
  Running --> Idle: final answer
  Running --> Error: provider or tool failure
  Running --> Idle: cancel
  Error --> Running: send next message
  Idle --> [*]: delete conversation
  Error --> [*]: delete conversation
```

Every meaningful mutation follows the same pattern:

1. Validate the request in IPC or the controller.
2. Mutate main-process state.
3. Queue an atomic state save when the change is durable.
4. Publish a full `AppSnapshot` to the renderer.
5. Let React derive view state from the new snapshot.

This avoids partial renderer state when multiple SDK events arrive quickly.

## One conversation turn

```mermaid
sequenceDiagram
  autonumber
  actor U as User
  participant UI as Renderer
  participant IPC as Preload and IPC
  participant MC as MainController
  participant ST as StateStore
  participant PS as Provider
  participant AC as Access gate
  participant WS as Workspace or device

  U->>UI: Submit prompt
  UI->>IPC: sendMessage(conversationId, text)
  IPC->>MC: Validated message
  MC->>MC: Preflight project and access requirements
  MC->>MC: Append user message and await confirmed child threads
  MC->>ST: Atomic save
  MC-->>UI: Running snapshot
  MC->>PS: Frozen conversation, settings, agents, signal

  loop Until final answer or cancellation
    PS->>AC: executeTool(name, args, readOnly)
    AC->>AC: Check master switch, capability, run-seat-device grant, target
    alt Approval required
      AC-->>UI: Pending approval snapshot
      UI-->>AC: deny, allow once, or allow for this run
    end
    AC->>ST: Commit pending audit intent
    AC->>WS: Execute bounded operation
    WS-->>AC: Result
    AC->>ST: Finalize audit outcome
    AC-->>PS: Result or error
    PS-->>MC: ProviderEvent
    MC->>ST: Persist durable event
    MC-->>UI: Updated snapshot
  end

  PS-->>MC: Final and usage
  MC->>ST: Completed state
  MC-->>UI: Final snapshot
```

## Provider adapter contract

Both adapters receive a `ProviderRunContext` or `OpenRouterRunContext` containing:

- An immutable conversation snapshot
- An immutable settings snapshot
- Resolved selected agent definitions
- The current prompt
- An `AbortSignal`
- A computer-access snapshot
- A trusted `executeTool` callback
- An `onEvent` callback
- The OpenRouter API key only for the OpenRouter adapter

Both adapters emit a small union:

- Thread ID
- Activity item
- Orchestration event
- Final message
- Usage summary

The UI therefore renders one activity language even when the underlying provider protocols differ.

## Codex runtime

```mermaid
flowchart LR
  CONTROLLER[MainController] --> CONFIG[SDK config and thread options]
  CONFIG --> SDK[Codex SDK]
  SDK --> THREAD{Saved thread ID?}
  THREAD -->|No| START[startThread]
  THREAD -->|Yes| RESUME[resumeThread]
  START --> STREAM[runStreamed]
  RESUME --> STREAM
  STREAM --> JSONL[Typed thread events]
  JSONL --> NORMALIZE[Event normalizer]
  NORMALIZE --> LEDGER[Crew communication ledger]
  LEDGER --> MAILBOX[Inspectable crew mailbox]
  NORMALIZE --> SNAPSHOT[Activity, crew, final, usage]
```

Codex options are derived per conversation. They include working directory, model, reasoning, sandbox mode, network access, web search, and cancellation. Feature configuration is derived per application setting. It includes multi-agent limits, subagent defaults, connectors, browser use, computer use, skills, and workspace dependency discovery.

The SDK receives a precise crew contract when agents are selected. Grokky observes real collaboration items and does not invent child state from assistant prose. Legacy collaboration items and Sol v2's active local rollout records normalize into the same contract. Assignments and reports are retained as sender-to-receiver records, which lets the renderer show actual lead and specialist traffic instead of a generic loading state.

See [CODEX-SDK.md](CODEX-SDK.md).

## OpenRouter runtime

```mermaid
flowchart TB
  INPUT[Prompt and recent messages] --> CURRENT{Needs current web data?}
  CURRENT -->|Yes| WEB[Auditable server-side web search]
  CURRENT -->|No| CREW
  WEB --> CREW{Crew selected?}
  CREW -->|No| LEAD[Lead tool loop]
  CREW -->|Yes| PAR[Parallel read-only specialist loops]
  PAR --> FINDINGS[All findings]
  FINDINGS --> LEAD
  LEAD --> CALL{Tool call?}
  CALL -->|Yes| ACCESS[Shared access gate]
  ACCESS --> RESULT[Tool result]
  RESULT --> LEAD
  CALL -->|No| FINAL[Final answer and total usage]
```

The tool loop caps the number of model rounds, runs one tool call at a time, catches tool errors as model-visible results, and aggregates usage across web research, specialists, and the lead. Specialist tools are always read-only. The lead gets only the capabilities allowed by the conversation and selected device.

See [OPENROUTER.md](OPENROUTER.md).

## Crew state normalization

```mermaid
stateDiagram-v2
  [*] --> Starting: crew selected and turn queued
  Starting --> Working: child or specialist begins
  Working --> Waiting: provider reports wait state
  Waiting --> Working: child resumes
  Working --> Completed: result returned
  Working --> Failed: child error
  Working --> Stopped: user cancellation
  Starting --> Stopped: app relaunch or cancellation
  Waiting --> Stopped: app relaunch or cancellation
```

Agent rows persist their name, icon, bounded task, provider operation ID, thread ID, status, result, and timestamps. On launch, stale active states normalize to `stopped`. Completed specialist results remain inspectable with the conversation.

## Typed task and meeting workflow

Provider orchestration is normalized into two durable, provider-independent records:

- `AgentTask` records the real sender and recipient threads, readable assignment text, heuristically detected verification checks, lifecycle status, timestamps, and confirmed result evidence. A follow-up updates only an active assignment; terminal tasks are never silently reopened.
- `AgentMeeting` records the agenda, confirmed participants, observed contributions, explicit decisions, next actions, and whether the meeting completed. Repeated encrypted Codex follow-up signals fold by sender and recipient; Grokky does not expose or pretend to decrypt their content.

Codex uses child-thread spawn, direct-message, and final-report events already emitted by its runtime. Readable spawn messages become task instructions; encrypted payloads are ignored. A final response can promote a decision only when every named participant exists, completed, and produced an observed response after an opening or challenge. When the user explicitly requests a meeting, OpenRouter performs a tool-free review in which every specialist sees the other reports and returns a validated structured challenge, agreement, proposal, and next action. A separate lead moderator then emits one decision, one action, and dissent. Malformed or unresolved records make the meeting incomplete. Ordinary crew requests skip these calls for speed and cost.

Before the next user turn clears the live workflow projection, the controller archives runs, tasks, meetings, communications, activities, usage, outcome, and exactly that turn's agent-computer seats into a `CrewTurnSnapshot` on the originating user message. It then starts the next turn with an empty live-seat projection, preventing older seats from leaking into later history. Historical tabs remain inspectable without pretending they are live.

At provider completion, cancellation, restart, or failure, the controller reconciles every active task, meeting, specialist run, and computer seat. An unfinished task becomes `stopped` or `failed`; an unfinished meeting becomes `incomplete`; the renderer never infers live work or consensus from a stale record.

## Agent computer seats

```mermaid
flowchart LR
  PROVIDER[Provider tool request] --> ID[Explicit agent identity]
  ID --> SEAT[Conversation-owned computer seat]
  SEAT --> POLICY[Main-process permission gate]
  POLICY --> DEVICE[Pinned local or remote device]
  DEVICE -->|Local browser| PROFILE[Ephemeral Electron partition]
  DEVICE -->|Other tool| TOOL[Bounded host or workspace tool]
  PROFILE --> FRAME[Hashed PNG evidence]
  TOOL --> AUDIT[Pre-act intent and outcome]
  FRAME --> WATCH[Watch drawer]
  AUDIT --> WATCH
```

`AgentComputerSession` is durable conversation and per-turn history state. It holds the stable seat ID, agent identity, optional provider thread ID, role, task, lifecycle status, effective device, isolation mode, bounded action timeline, and up to twelve captured visual frames. New frames live in one application-owned store with a SHA-256 digest that is checked before preview. Trimming the active-seat projection never deletes an artifact still referenced by archived turn history; conversation deletion removes the deduplicated active and archived set. Active seats normalize to stopped after restart; in-flight actions normalize to indeterminate because the external outcome cannot be inferred.

OpenRouter creates an explicit `AgentComputerIdentity` for the lead and each specialist and passes it with every tool call. The controller resolves that identity to one seat before authorization, so the model cannot choose an arbitrary device or another agent's audit identity. Local browser calls route to a separate non-persistent Electron partition per seat. The browser window has no preload, Node integration, renderer bridge, or shared cookie jar. It is destroyed when the run ends.

Codex child lifecycle maps into the same seat contract from real orchestration events. Native Codex tool execution remains owned by the SDK and does not currently provide Grokky with a complete child-to-tool attribution callback, so every Codex seat remains on the local host and uses `policy-session`. Remote selection and spreading affect OpenRouter only.

## Permission evaluation

```mermaid
flowchart TB
  TOOL[Provider requests tool] --> CAP[Map tool to capability]
  CAP --> MASTER{Computer access enabled?}
  MASTER -->|No| DENY[Block and audit]
  MASTER -->|Yes| AVAILABLE{Capability available on device?}
  AVAILABLE -->|No| DENY
  AVAILABLE -->|Yes| LEVEL{Policy level}
  LEVEL -->|Blocked| DENY
  LEVEL -->|Always allow| EXEC
  LEVEL -->|Ask| CHAT{Run-seat-device grant exists?}
  CHAT -->|Yes| INTENT
  CHAT -->|No| APPROVAL[Render approval]
  APPROVAL -->|Deny| DENY
  APPROVAL -->|Allow once| INTENT[Commit pending audit intent]
  APPROVAL -->|Allow for run| MEMORY[Store scoped memory-only grant]
  MEMORY --> INTENT
  INTENT --> DEVICE{Effective device}
  DEVICE -->|Local| LOCAL[Local bounded tool]
  DEVICE -->|Remote| REMOTE[Authenticated runner request]
  LOCAL --> AUDIT[Result and audit]
  REMOTE --> AUDIT
```

The final effective permission is the intersection of:

1. Global computer-access master switch
2. Capability availability on the selected device
3. Persistent capability policy
4. Optional memory-only run, seat, device, and capability grant
5. Conversation sandbox mode
6. Provider-specific read-only restriction
7. Native operating-system permission when a supported screen or automation tool needs it
8. Remote runner startup flags

No single UI toggle can widen all layers.

## Private runner protocol

```mermaid
sequenceDiagram
  actor U as User
  participant G as Grokky main process
  participant R as Private runner
  participant K as Electron safe storage

  U->>R: Start with root and bind address
  R-->>U: One-time six-digit code
  U->>G: Submit endpoint and code
  G->>R: POST /pair
  R->>R: TTL/attempt check, timing-safe comparison, rotation
  R-->>G: Device metadata and bearer token
  G->>K: Encrypt token
  K-->>G: Ciphertext
  G->>G: Persist ciphertext and device metadata
  G->>R: POST /execute with bearer token
  R->>R: Revalidate tool, path, and mode; append accepted receipt
  R-->>G: Bounded result
  U->>G: Revoke device
  G->>R: POST /revoke with bearer token
  R->>R: Rotate and persist bearer
  G->>G: Forget encrypted copy
```

Runner endpoints:

| Endpoint | Authentication | Purpose |
| --- | --- | --- |
| `GET /health` | None | Report runner metadata and capabilities |
| `POST /pair` | Six-digit, five-minute, attempt-limited code | Return the persistent bearer token and rotate the code |
| `POST /test` | Bearer token | Test the file capability |
| `POST /execute` | Bearer token | Run one bounded workspace operation |
| `POST /revoke` | Bearer token | Rotate the remote bearer before local forgetting |

The private runner refuses to place its `0600` disk state inside the exposed workspace root. Grokky stores only an Electron `safeStorage` encrypted form of the bearer token. Plain HTTP is accepted only for literal loopback IP addresses; every non-loopback endpoint, including LAN and private-overlay addresses, requires HTTPS. Remote completion is accepted only when the server receipt and runner-computed canonical argument digest match the main-process authorization intent. The private runner exposes structured file operations only.

The optional Sandbox Gateway implements the same pairing and receipt surface with a one-time high-entropy `gsk_` enrollment key. Its signed device token remains in Electron. Every execution adds a two-minute lease bound to the action, conversation, agent-computer seat, and argument digest. A seat Durable Object atomically claims that action before launching an argv process in the associated non-root container; a repeated action returns the stored receipt and output. Gateway and provider secrets are Worker bindings and are never forwarded to the process. Grokky requests explicit container destruction when the seat ends, with idle sleep as a fallback.

## Skills, MCP, connectors, and agents

```mermaid
flowchart LR
  SETTINGS[Settings interface] --> IPC[Validated IPC]
  IPC --> CAPABILITY[CapabilitiesService]
  IPC --> AGENT[AgentService]

  CAPABILITY --> CONFIG[$HOME/.codex/config.toml]
  CAPABILITY --> SKILLROOTS[Project and user skill roots]
  AGENT --> PERSONAL[$HOME/.codex/agents]
  AGENT --> PROJECT[workspace/.codex/agents]

  CONFIG --> CODEX[Future Codex runs]
  SKILLROOTS --> CODEX
  PERSONAL --> CODEX
  PROJECT --> CODEX
```

Capability and agent writes are atomic. The settings layer edits only direct supported configuration blocks and preserves unrelated Codex configuration. Built-in agents cannot be overwritten or deleted; they can be duplicated into a user-owned definition.

## Persistence model

```mermaid
erDiagram
  APP_STATE ||--o{ CONVERSATION : contains
  APP_STATE ||--|| SETTINGS : contains
  APP_STATE ||--|| COMPUTER_ACCESS : contains
  CONVERSATION ||--o{ MESSAGE : contains
  CONVERSATION ||--o{ ACTIVITY : contains
  CONVERSATION ||--o{ AGENT_RUN : contains
  CONVERSATION ||--o| USAGE : records
  COMPUTER_ACCESS ||--o{ REMOTE_DEVICE : pairs
  COMPUTER_ACCESS ||--o{ AUDIT_ENTRY : records
```

Persisted state intentionally includes user content and may be sensitive, but it lives outside the repository under Electron's per-user data directory. It is written with mode `0600` through a `.next` file followed by rename.

Grokky does not persist:

- The OpenRouter key value
- Codex authentication contents
- Decrypted remote-runner tokens
- Memory-only chat approvals
- Screen captures in conversation state
- Provider objects, processes, or abort controllers

## Cancellation and deletion

A live run owns an `AbortController` stored by conversation ID. Cancelling aborts the provider request, resolves outstanding computer approvals as denied, marks active crew rows stopped, and returns the conversation to idle. Deleting a conversation performs cancellation first, removes its in-memory run references, updates the active conversation, and atomically saves the new state.

## Extension points

The cleanest future seams are:

- Add a provider behind the normalized `ProviderEvent` contract.
- Add a local or remote tool behind `ComputerToolName`, capability mapping, and access audit.
- Add persistence migrations in `StateStore.load` without exposing raw disk data to React.
- Add OpenRouter MCP or connector support by converting external tool definitions into the bounded tool-loop contract.
- Add remote screen or automation only after the runner has a transport, permission, and image-security design appropriate for it.

## Independent implementation boundary

This source was implemented against public SDKs, public API documentation, and observable product behavior. It does not import another commercial application's proprietary source, private protocols, internal packages, or brand assets. Do not describe the project as an official client or as an authenticated reproduction of another product's internals.
