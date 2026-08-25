# Contributing to Grokky

Grokky is a private Early AI Dopters project. Repository access does not grant redistribution rights.

## Before changing code

1. Read [README.md](README.md) for product behavior.
2. Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for process boundaries.
3. Read [docs/SECURITY.md](docs/SECURITY.md) before touching IPC, tools, credentials, persistence, browser access, computer control, or the runner.
4. Read the provider guide before changing [Codex](docs/CODEX-SDK.md) or [OpenRouter](docs/OPENROUTER.md).

## Pull request standard

A focused pull request should include:

- The user-visible problem
- The root cause or intended capability
- The implementation boundary
- Tests added or changed
- Screens inspected for UI work
- Live provider checks run, when applicable
- Security or persistence implications
- Known limitations

## Required verification

```bash
npm ci
npm run verify
```

Run the smallest relevant credential-gated smoke check for provider changes. Never add a real credential to a fixture, command, issue, screenshot, or pull-request description.

## Source rules

- Keep secrets and provider clients in the main process.
- Validate every value crossing from the renderer.
- Keep provider differences explicit.
- Preserve local-first state ownership.
- Make crew execution observable through actual events.
- Use atomic writes for user configuration and app state.
- Protect workspace boundaries at execution time.
- Preserve unrelated user configuration and dirty workspace changes.
- Keep generated builds, captures, screenshots, local state, and logs out of Git.
- Use commas, colons, parentheses, or separate sentences instead of em dashes.

## Commit hygiene

Before commit, inspect:

```bash
git status --short
git diff --check
npm run hygiene
```

Do not commit:

- `.env` files or keys
- Codex auth data
- Conversation databases
- Runner state or bearer tokens
- Personal home paths, hostnames, email addresses, or internal URLs
- Screenshots showing personal data
- Packaged applications or release artifacts
- Generated dependencies or build output

## Design review

For interface changes, verify:

- Wide desktop and minimum supported window sizes
- Dark, light, and system themes
- Every accent palette
- Keyboard focus and Escape behavior
- Outside-click dismissal
- Empty, loading, running, error, and completed states
- Long labels, Markdown, tables, paths, and tool output
- Popover, modal, toolbar, message, and composer stacking
- Distinct mascot identity for each agent role

The interface should feel authored for this product. Do not introduce stock dashboard cards, generic pill collections, or library-default settings navigation without a product-specific reason.
