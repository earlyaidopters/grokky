# Grokky

Grokky is a standalone Early AI Dopters product repository. This directory is the project root. Source, assets, builds, tests, and session handoffs belong here. Its development workflow is independent of any YouTube production workspace.

## Start here

1. Read this file, then `handoff/LATEST.md` and the exact handoff it names when those local files exist. Older handoffs are historical records; the latest handoff supersedes their locations, versions, and instruction references.
2. Inspect `git status --short --branch`, `git log -3 --oneline`, and `git remote -v` before editing or pulling. Preserve local changes and unpublished commits.
3. Read `README.md`, `docs/ARCHITECTURE.md`, and the relevant provider or feature guide. Read `docs/SECURITY.md` before modifying IPC, tools, credentials, persistence, or remote control.
4. The GitHub repository is `https://github.com/earlyaidopters/grokky`, with default branch `main`. It is public and MIT-licensed; forks, rebranding, redistribution, and commercial use are permitted subject to `LICENSE.md`. Preserve copyright and license notices. Check current branch and remote state rather than assuming local changes have been pushed.

## Architecture and boundaries

- Electron main process owns credentials, provider clients, tools, permissions, state, and scheduling. Preload exposes typed IPC. React renders observed state.
- Codex uses the official SDK and native runtime. OpenRouter uses Grokky's bounded tool loop. Preserve their different capabilities and avoid claims of transparent parity.
- `services/sandbox-gateway/` contains the Cloudflare Worker, sandbox seats, Browser Run integration, and companion Durable Object.
- Semantic observations and fresh element references are the primary agent browser controls. Coordinates are an explicit human control path and an agent fallback. Preserve completion evidence, permission gates, argument-bound receipts, and seat teardown.
- Phone handoff has one owner. Pause new agent actions before waiting for in-flight actions; reject stale epochs and frames; discard planned model actions and require fresh observation on resume. Disconnects must not silently resume the model. See `docs/PHONE-CONTROL.md`.
- Keep human phone input and human-control frames out of model transcripts and durable action content. Keep provider secrets and signed browser URLs out of logs, handoffs, screenshots, and Git.
- Routines and model orchestration currently require the desktop app to remain open. Independent cloud execution and push notifications are separate unfinished capabilities.
- Study other products through documentation and independently implemented behavior. Do not import an unofficial reconstruction's renderer, binaries, installers, private protocols, or source archive into this product.

## Assets and persistence

- App icon sources are in `build/`; renderer brand and mascot assets are in `src/renderer/public/`.
- `output/` holds local QA evidence, legacy asset copies, and installation/relocation records. `release/` holds ignored packaging artifacts and rollback archives.
- `handoff/` is private, ignored continuity state. Keep historical timestamped documents intact. Update `LATEST.md`, write the next complete handoff, and validate it with the installed prime resolver. Local paths and machine-specific operational notes belong in ignored handoffs, not tracked documentation.
- User conversations, credentials, and paired-device state live outside the source checkout. A source-folder move must not reset app data or recreate credentials.
- Use project-relative paths in scripts and tracked docs. Do not add dependencies or symlinks back to another workspace.

## Verification and delivery

- Follow `CONTRIBUTING.md`. Use `npm run verify` for source changes and `npm run smoke:electron:full` for renderer/IPC changes.
- For gateway changes, run its typecheck, tests, and `smoke:companion`. For phone UI changes, run `smoke:phone-ui` with Playwright Chromium or the documented Chrome override.
- Use targeted live checks when the change warrants them. `npm run smoke:phone` and `npm run smoke:cloud-device` exercise the installed app with disposable cloud seats. Do not run paid model calls, redeploy production, or repeat live benchmarks merely to reconstruct context.
- Tests must not sign in, book, purchase, or mutate a real external account unless that task specifically authorizes it. Distinguish deterministic fixtures, scripted live tests, model-driven behavior, and physical-device checks.
- Package on the target OS and verify the bundled Codex executable. Bump the version for behavior changes. Preserve one runnable installed Grokky app; retain rollback copies as ZIPs rather than multiple app bundles.
- Deploy gateway changes before installing desktop features that require them. For Worker-only changes, the documented `--containers-rollout=none` option preserves the current container image. Container changes require a normal image build and rollout.
- Preserve local work and inspect the diff before committing. Run `npm run hygiene` and `git diff --check`. Never commit dependencies, app bundles, captures, credentials, conversations, personal paths, or handoffs.
- Write plainly, use actual observed outcomes, and avoid em dashes. Do not mix broad CSS refactors or unrelated product changes into a scoped fix.
