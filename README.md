<p align="center">
  <img src="build/icon-mascot.png" width="168" alt="Grokky mascot" />
</p>

<h1 align="center">Grokky</h1>

<p align="center">
  <strong>A local-first desktop cockpit for Codex, OpenRouter, and coordinated AI crews.</strong>
</p>

<p align="center">
  <a href="https://github.com/earlyaidopters/grokky/actions/workflows/verify.yml"><img alt="Verify" src="https://github.com/earlyaidopters/grokky/actions/workflows/verify.yml/badge.svg" /></a>
  <img alt="Repository visibility" src="https://img.shields.io/badge/repository-private-10140e?style=flat-square" />
  <img alt="Electron" src="https://img.shields.io/badge/Electron-43-47848f?style=flat-square&logo=electron&logoColor=white" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-6-3178c6?style=flat-square&logo=typescript&logoColor=white" />
  <img alt="License" src="https://img.shields.io/badge/license-UNLICENSED-a8d84e?style=flat-square" />
</p>

Grokky turns a folder on your computer into a visual AI workspace. Pick the official Codex SDK or any compatible OpenRouter model, choose a crew, define the access boundary, and watch the work unfold as messages, tool activity, specialist handoffs, approvals, and usage.

The interface is only the cockpit. Credentials, model processes, files, commands, native permissions, and remote-computer tokens stay behind Electron's trusted main-process boundary.

> [!IMPORTANT]
> This repository is private and `UNLICENSED`. It contains no API keys, login sessions, local conversations, machine hostnames, screenshots with personal paths, or user-specific configuration.

## The product in one view

```mermaid
flowchart LR
  U[You] --> UI[Grokky cockpit]
  UI --> B[Typed IPC bridge]
  B --> C[Main controller]

  C --> CX[Codex SDK]
  C --> OR[OpenRouter SDK]
  C --> DB[Local JSON state]
  C --> CA[Computer access gate]
  C --> CM[Codex capability manager]

  CX --> CT[Persistent Codex thread]
  CT --> CW[Selected workspace]
  CT --> CC[Skills, MCP, connectors]

  OR --> OL[Bounded tool loop]
  OL --> CW
  OR --> OW[OpenRouter web search]

  CA --> CW
  CA --> RR[Paired private runner]
```

## Why this exists

Most AI desktop apps collapse three different concerns into one opaque chat box:

1. The model provider
2. The tools and permissions
3. The orchestration strategy

Grokky keeps them visible and independently configurable. A conversation records which provider, model, reasoning level, workspace, sandbox, command policy, and crew produced the result. The same React interface can drive a native Codex thread or an OpenRouter tool loop without pretending those runtimes work the same way.

## What is already built

| Area | Capability |
| --- | --- |
| Conversations | Create, search, switch, cancel, and delete local chats with a confirmation step |
| Providers | Switch between the official Codex SDK and OpenRouter per conversation |
| Models | Select Codex models, enter any valid OpenRouter model ID, and set reasoning effort |
| Workspaces | Choose a folder, use read-only or workspace-write mode, and gate commands separately |
| Live activity | Render reasoning, plans, files, commands, tools, errors, and usage as normalized events |
| Multi-agent | Run native Codex child threads or parallel OpenRouter specialists with a final lead |
| Agents | Create personal or project TOML agents with unique mascot colors, models, reasoning, and access |
| Skills | Discover and enable Codex skills from project, personal, system, and plugin roots |
| MCP | Inspect and toggle configured local or remote Codex MCP servers |
| Connectors | Inspect and toggle installed Codex connector plugins |
| Web | Use native Codex live search or OpenRouter's auditable server-side web search |
| Computer access | Gate files, commands, public web pages, and supported native controls |
| Remote computer | Pair a bounded runner over a private network, with encrypted bearer-token storage |
| Safety | Block credential files, path traversal, symlinks, private-network browser targets, and unsafe commands |
| Persistence | Atomically store sessions, settings, audit history, usage, and resumable Codex thread IDs |
| Appearance | System, dark, and light themes plus lime, electric blue, ultraviolet, amber, and ice accents |

## Provider capability matrix

The runtimes intentionally share a UI contract, not an implementation.

| Capability | Codex | OpenRouter |
| --- | :---: | :---: |
| Persistent conversation context | Native thread resume | Recent message history |
| Streaming activity | SDK thread events | Grokky tool-loop events |
| Multi-agent specialists | Native child threads | Parallel read-only model loops |
| Final coordinator | Codex parent thread | One lead model after specialists finish |
| Workspace tools | Codex sandbox and SDK tools | Grokky's bounded functions |
| Skills | Yes | Not yet |
| MCP servers | Yes | Not yet |
| Connector plugins | Yes | Not yet |
| Live web research | Codex live search | OpenRouter server web-search tool |
| Screen input | Native SDK feature when always allowed | Grokky screenshot tool with approval on macOS |
| UI automation | Native SDK feature when always allowed | Grokky native tools with approval on macOS |

## Request lifecycle

```mermaid
sequenceDiagram
  autonumber
  actor User
  participant R as React renderer
  participant P as Sandboxed preload
  participant M as Main controller
  participant A as Access gate
  participant X as Provider adapter
  participant S as Atomic state store

  User->>R: Send a message
  R->>P: sendMessage(id, text)
  P->>M: Allowlisted IPC call
  M->>S: Persist user message and running state
  M-->>R: Publish snapshot
  M->>X: Run immutable conversation context

  loop Provider work
    X->>A: Request bounded capability
    A-->>User: Ask when policy requires approval
    User-->>A: Deny, allow once, or allow for chat
    A-->>X: Tool result or denial
    X-->>M: Normalized activity or crew event
    M->>S: Persist durable progress
    M-->>R: Publish snapshot
  end

  X-->>M: Final answer and usage
  M->>S: Persist completed turn
  M-->>R: Publish final snapshot
```

## Quick start

### Prerequisites

- macOS on Apple Silicon or Windows on x64 for the packaged desktop experience
- Node.js 20.19 or newer
- npm 10 or newer
- A saved Codex sign-in, an OpenRouter key, or both

### Install and run

```bash
git clone git@github.com:earlyaidopters/grokky.git
cd grokky
npm ci
npm run dev
```

The first session uses your home directory as its default workspace. Choose a narrower project folder before giving an agent write or command access.

### Verify everything reproducible

```bash
npm run verify
```

That command runs the privacy and repository-hygiene gate, TypeScript checks, the deterministic test suite, and a production renderer/main-process build.

Live provider checks are separate because they require existing credentials and may incur model usage:

```bash
npm run smoke:codex
npm run smoke:codex-provider
npm run smoke:codex-web
npm run smoke:multiagent
npm run smoke:openrouter
npm run smoke:openrouter-crew
npm run smoke:openrouter-web
npm run smoke:electron
```

## Codex SDK setup

Grokky uses the official [`@openai/codex-sdk`](https://www.npmjs.com/package/@openai/codex-sdk) in Electron's main process. The SDK controls a local Codex agent, keeps model execution out of the renderer, and supports starting, continuing, and resuming threads. See the [official Codex SDK guide](https://learn.chatgpt.com/docs/codex-sdk).

### 1. Sign in once

Use the normal Codex login flow on the computer that runs Grokky:

```bash
codex login
```

Grokky checks the normal Codex auth location, or the location selected by `CODEX_HOME`. It does not copy session material into this repository or its conversation database.

### 2. Start or resume a thread

The provider creates one SDK client per run, applies Grokky's feature settings, then chooses the thread operation from the conversation state:

```ts
const codex = new Codex({ config });

const thread = conversation.threadId
  ? codex.resumeThread(conversation.threadId, options)
  : codex.startThread(options);

const { events } = await thread.runStreamed(prompt, { signal });
```

When the SDK emits `thread.started`, Grokky stores the thread ID. The next turn resumes the same thread with the active model, reasoning, workspace, sandbox, network, and search options.

### 3. Normalize SDK events

The provider maps SDK items into renderer-safe contracts:

| SDK event or item | Grokky representation |
| --- | --- |
| `thread.started` | Persisted thread ID |
| `reasoning` | Reasoning activity |
| `command_execution` | Command activity and output |
| `file_change` | File activity and changed paths |
| `mcp_tool_call` | Tool activity |
| `todo_list` | Plan activity |
| `web_search` | Web-search activity |
| `agent_message` | Coordinator update or final answer |
| `turn.completed` | Token usage |
| `collab_tool_call` | Live crew member state |

### 4. Package the native executable correctly

Electron archives application code inside `app.asar`, but a native executable cannot be spawned from that virtual path. The build unpacks the Codex platform package, and the provider resolves the real binary into `codexPathOverride` at runtime.

Full implementation notes: [docs/CODEX-SDK.md](docs/CODEX-SDK.md)

## OpenRouter setup

Grokky uses the official [`@openrouter/sdk`](https://www.npmjs.com/package/@openrouter/sdk) for typed chat calls and a direct OpenRouter request for the current server-side web-search tool.

### 1. Supply a key outside the renderer

Use any one of these sources, in priority order:

1. `OPENROUTER_API_KEY` in the launching process
2. An env file chosen in **Settings → Session → OpenRouter credential**
3. `GROKKY_OPENROUTER_ENV_FILE` pointing to an env file
4. `$HOME/.config/grokky/.env`

Example local file:

```dotenv
OPENROUTER_API_KEY=replace_with_your_key
```

Only the selected file path can be persisted. The key value is resolved in the main process for the request and never enters React, typed IPC, chat state, logs, or Git.

### 2. Run a bounded tool loop

The OpenRouter provider sends message history, reasoning effort, and only the tools allowed by the active conversation and computer policy. It executes returned calls through the same access gate, appends tool results, and repeats for at most eight steps.

```mermaid
flowchart LR
  Q[Prompt + recent history] --> M[OpenRouter model]
  M --> D{Tool calls?}
  D -->|No| F[Final answer]
  D -->|Yes| G[Computer access gate]
  G --> T[Bounded tool execution]
  T --> R[Tool result]
  R --> M
```

The tool catalog can include file listing, literal search, file reads, exact edits, safe file creation, allowlisted development commands, public-page reads, and platform-supported native controls. The catalog shrinks automatically for read-only specialists and restricted devices.

### 3. Use auditable live web search

When web search is enabled and the prompt calls for current information, Grokky invokes OpenRouter's current server tool:

```json
{
  "type": "openrouter:web_search",
  "parameters": {
    "engine": "auto",
    "max_results": 5,
    "max_total_results": 10,
    "max_uses": 3,
    "search_context_size": "medium"
  }
}
```

The research step must return evidence that a server search ran plus source URLs. Grokky retries once if either is absent, records the sources in activity, and feeds the verified brief to the final answer. This follows OpenRouter's [server tools](https://openrouter.ai/docs/guides/features/server-tools/overview) and [web search](https://openrouter.ai/docs/guides/features/server-tools/web-search) documentation.

Full implementation notes: [docs/OPENROUTER.md](docs/OPENROUTER.md)

## Multi-agent orchestration

Selecting a crew is an execution contract, not a decorative prompt hint.

```mermaid
flowchart TB
  P[User prompt + selected crew] --> V{Provider}

  V -->|Codex| CP[Parent thread receives exact roster]
  CP --> CS[spawn_agent for every selected role]
  CS --> CW[Wait for every child result]
  CW --> CF[Parent consolidates]

  V -->|OpenRouter| OS[Create isolated read-only specialist loops]
  OS --> OP[Run specialists with Promise.all]
  OP --> OL[Lead receives every finding]
  OL --> OF[Lead may use normal chat permissions]

  CF --> UI[One answer + inspectable crew timeline]
  OF --> UI
```

For Codex, Grokky enables the SDK's multi-agent features and translates collaboration events into named specialist cards plus an inspectable crew mailbox. The mailbox shows confirmed assignments, direct messages when the runtime emits them, specialist reports, sender and receiver routing, source tools, and delivery state. For OpenRouter, every specialist gets its own prompt, optional model, optional reasoning level, developer instructions, and read-only tool catalog. All specialists run concurrently. One lead runs only after they finish, owns any allowed writes, and produces the user-facing result.

Agent definitions live in normal Codex TOML locations:

- Personal: `$HOME/.codex/agents/*.toml`
- Project: `<workspace>/.codex/agents/*.toml`

Grokky adds a comment-only `grokky_icon` metadata field so the interface can assign a different mascot color without changing the agent contract.

## Skills, MCP servers, and connectors

The capability manager reads the active Codex configuration and presents three dedicated settings views:

- **Skills** discovers `SKILL.md` packages from the project tree, personal skill folders, system skills, and plugin caches.
- **MCP servers** discovers `[mcp_servers.*]` tables and preserves whether each server is local, remote, or otherwise configured.
- **Connectors** discovers `[plugins.*]` entries.

Toggles update only the relevant `enabled` field or skill config block in `$HOME/.codex/config.toml`. Writes are atomic and preserve unrelated configuration. These capabilities currently feed Codex runs. OpenRouter uses Grokky's built-in bounded tools and does not yet consume Codex skills, MCP servers, or connectors.

## Computer access model

Every sensitive tool maps to one of five capabilities:

| Capability | Examples | Default |
| --- | --- | --- |
| Files | List, search, read, create, edit | Always allow inside workspace |
| Commands | Tests, builds, inspection, safe Git commands | Ask |
| Browser | Read an approved public URL | Ask |
| Screen | Capture the current display | Ask |
| Automation | Open an app, click coordinates, type text | Ask |

Each capability can be **Blocked**, **Ask each time**, or **Always allow**. An approval can deny the request, allow that request once, or allow the capability for the current chat. Chat grants are memory-only and disappear when the app exits.

The browser tool rejects URLs with embedded credentials and any destination that resolves to loopback, link-local, RFC1918, carrier-grade NAT, or unique-local IPv6 space. Persistent web access also requires a domain allowlist.

Workspace file tools reject:

- Absolute paths and traversal outside the selected root
- Symlinks for file reads and edits
- Dependency, build, release, and Git internals
- `.env`, auth, credential, private-key, and certificate files
- Non-unique search and replace edits
- Arbitrary shell composition, network commands, deletion, and system control

Read the complete threat model and trust boundaries in [docs/SECURITY.md](docs/SECURITY.md).

## Pair a private computer

The included runner exposes only bounded workspace tools. It has no model credential, renderer, or access to Grokky's conversation database.

On the computer to control:

```bash
git clone git@github.com:earlyaidopters/grokky.git
cd grokky
npm ci
npm run runner -- \
  --root "/absolute/path/to/workspace" \
  --host "100.x.x.x" \
  --port 4747
```

The runner prints a one-time six-digit pairing code. In Grokky, open **Settings → Computer access**, enter the private endpoint and code, then select the device.

Add `--allow-write` only if the runner may accept workspace-write requests. Add `--allow-commands` only if it may accept the small command allowlist. Grokky's own conversation sandbox and capability policy still apply, creating two independent checks.

> [!WARNING]
> Bind the runner only to loopback or an authenticated private network such as Tailscale. The built-in runner speaks HTTP and relies on the private transport for encryption. Never expose it directly to the public internet.

## Persistence and chat deletion

Grokky stores state in Electron's per-user application-data directory. The default conversation file is:

```text
macOS:  $HOME/Library/Application Support/Grokky/conversations.json
Windows: %APPDATA%\Grokky\conversations.json
```

The file contains conversations, messages, activity summaries, settings, usage, Codex thread IDs, access policy, recent audit entries, and encrypted remote-runner tokens. Writes use a temporary file plus atomic rename and private filesystem permissions.

Deleting a chat from the sidebar or toolbar removes it from that local state and cancels an active run first. Deleting local metadata does not delete a provider's remote records, Codex home data, agent TOML files, or workspace files.

## Repository map

```text
grokky/
├── .github/workflows/verify.yml       macOS and Windows CI and package gate
├── build/icon-mascot.png              active application icon
├── docs/
│   ├── ARCHITECTURE.md                process, data, and orchestration design
│   ├── CODEX-SDK.md                   Codex integration guide
│   ├── DEVELOPMENT.md                 development and release workflow
│   ├── OPENROUTER.md                  OpenRouter integration guide
│   └── SECURITY.md                    threat model and privacy boundary
├── scripts/
│   ├── check-repository-hygiene.mjs   privacy and secret guard
│   └── smoke-*.mjs                    credential-gated integration checks
├── src/
│   ├── main/                          trusted Electron process and providers
│   ├── preload/                       minimal typed IPC bridge
│   ├── renderer/                      React interface and custom design system
│   └── shared/                        contracts and runtime validation
└── tests/                              deterministic and live integration tests
```

## Build and package

Create an unpacked Apple Silicon application:

```bash
npm run package:mac:dir
```

Create a DMG:

```bash
npm run package:mac
```

Create an unpacked Windows x64 application or an NSIS installer from Windows:

```powershell
npm run package:win:dir
npm run package:win
```

Artifacts are written under `release/` and are ignored by Git. Every push to `main` verifies and packages on native macOS arm64 and Windows x64 GitHub runners, checks that the correct Codex executable is present outside `app.asar`, and uploads both installers as workflow artifacts. Development packages are unsigned. External distribution requires the appropriate Apple Developer ID or Windows code-signing identity and a release-specific security review.

## Design principles

1. **The renderer is untrusted.** It cannot read credentials, import Node, spawn processes, or touch the filesystem directly.
2. **Provider behavior must be honest.** The UI distinguishes native Codex behavior from Grokky-owned OpenRouter orchestration.
3. **Delegation must be observable.** A crew is not shown as working until a real child or specialist run exists.
4. **Permission is layered.** Workspace mode, chat command setting, capability policy, native OS permission, and remote-runner flags all narrow access.
5. **State is local and inspectable.** Conversations are not hidden in a bundled cloud database.
6. **Brand carries function.** Mascot colors identify roles and live states, while the interface remains information-dense and calm.
7. **Generated output is not source.** Builds, captures, local state, and smoke screenshots stay outside version control.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Codex SDK integration](docs/CODEX-SDK.md)
- [OpenRouter integration](docs/OPENROUTER.md)
- [Security and privacy](docs/SECURITY.md)
- [Development and release workflow](docs/DEVELOPMENT.md)
- [Contributing](CONTRIBUTING.md)

## Current boundaries

- Packaged targets are Apple Silicon macOS and Windows x64.
- Native screen and Accessibility automation are macOS-only.
- Codex skills, MCP servers, and connectors do not automatically become OpenRouter tools.
- The remote runner supports bounded file and command capabilities, not remote screen or UI automation.
- OpenRouter web research currently uses a dedicated research model constant before final synthesis.
- Packaged development builds are unsigned and not notarized.

## Independent implementation notice

Grokky is an independent application built against public SDKs and documented provider contracts. It does not include proprietary source code, assets, protocol definitions, internal packages, or installers from another commercial desktop agent. Product inspiration and behavioral research do not imply affiliation, endorsement, or compatibility certification.

## Ownership

Copyright © 2026 Early AI Dopters. All rights reserved.

This private repository is `UNLICENSED`. No permission to copy, redistribute, sublicense, or publish the source is granted outside the repository owner's explicit authorization.
