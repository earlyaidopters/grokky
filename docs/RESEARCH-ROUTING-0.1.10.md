# Ordinary research routing, 0.1.10

An OpenRouter request to “spin up agents to reserah the best apple mac mini right now” opened the cloud browser. The search trigger did not recognize research wording or “right now”, and dynamically delegated specialists did not automatically receive the lead's verified search brief. A specialist could receive browser tools and independently choose computer use for a normal research request.

## Resulting behavior

Ordinary research uses the audited web-search stage. The lead and its delegated specialists receive the verified findings and source URLs. Research wording, common misspellings, current-information phrases, and computer-product comparison requests are recognized. Mentioning a computer or browser as the research subject no longer counts as asking to operate one.

During ordinary research, browser, screen-control, and sandbox-command tools are withheld. Attempted calls are rejected before execution. The route comes from the user's request, so a model-written assignment cannot enable computer use. File capabilities and external-tool policies retain their existing boundaries.

Explicit requests such as “Use your computer to research Apple's current Mac mini on its website” keep the browser route. Web search being disabled or failing does not silently enable computer use. Pure text comparisons and fictional naming tasks do not trigger research merely because they ask for a comparison or the “best” answer.

## Reproduce

1. Enable **Web search** and **Settings → Agents → Multi-agent orchestration**.
2. Leave the agent picker on **Auto**.
3. Send: “Spin up agents to research the best Mac mini right now.”
4. Expect **Live web search**, real specialist assignments and reports, and cited findings. This request should not open the cloud browser.
5. To operate the website instead, explicitly request browser or computer use.

Phone pairing still belongs to a running cloud-browser task; this fix does not change its lifecycle or permissions.

## Verification

Product commit: `8eb18f3` on `feat/phone-handoff`.

- `npm run verify`: hygiene, TypeScript, production build, and 227 passing tests. Ten opt-in live tests were skipped. Local fixture servers required sandbox escalation; no local foreground Electron suite was run.
- Seventeen added deterministic cases cover the reported wording, ordinary research topics, source sharing in real provider-loop control flow with mocked model/search responses, rejected browser/screen/command attempts, explicit computer requests, disabled and failed search, and ordinary text-only prompts.
- Hosted Mac and Windows full desktop suites each passed 73 cases. Each platform produced 73 accessibility reports covering 182 states with no automatic violations. Manual-review findings remain in the artifacts.
- Gateway checks and Chromium/WebKit phone interaction checks passed. No gateway source or production deployment changed.
- Hosted macOS and Windows installers built and passed bundled Codex verification. The local Apple Silicon package and Codex CLI 0.149.1 were verified, then the app was updated after the active task completed.

[Hosted verification and artifacts](https://github.com/earlyaidopters/grokky/actions/runs/34374237662).

A separately prepared live OpenRouter search/delegation canary did not run: automatic approval review required explicit authorization for potentially billable provider calls. Deterministic fixtures establish routing and tool enforcement, not the quality or latency of a live model's research answer. Earlier live provider checks remain historical evidence. No physical-phone or new sustained-use test was performed for this provider routing fix.
