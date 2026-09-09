# Provider experience improvements, 0.1.5

This pass addresses the most disruptive conversational and continuity failures from the [0.1.4 experience audit](UX-AUDIT-2026-09-08.md). The [87-journey register](UX-JOURNEY-MAP.csv) and [control inventory](UX-CONTROL-INVENTORY.csv) remain the broader improvement backlog.

## What changed

| Audit finding | New behavior |
| --- | --- |
| F01: “spin up agents” demands Full access | Agent wording no longer matches server-start preflight. Negated file instructions do not demand a project folder. |
| F02: native Codex agents invisible without picker selection | The enabled multi-agent observer records real native starts and reports even with an empty selected roster. |
| F03: OpenRouter cannot discover agents from conversation | Auto mode makes a bounded local roster available for explicit delegation or named-specialist requests. Picker selections take precedence. |
| F04: negated browser words trigger navigation | Negated clauses do not activate the browser completion workflow or preliminary web research. |
| F05: switching conversations loses drafts | Text and image drafts stay with their conversation for the window lifetime. Delayed sends cannot clear newer drafts. Sending, removing attachments, deleting conversations, and closing the window release retained image previews. |
| F06: blocked chat shows completed Watch | The lead seat follows the classified outcome. Blocked state persists across restart and has explicit Watch wording. |
| F08: empty Watch opens for ordinary text requests | Auto-open requires cloud browser, screen or automation activity, or captured evidence. Native Codex sessions explain that no cloud screen is available. |
| F09: access picker ignores Escape | Escape dismisses the menu and restores focus to its trigger. |
| F17: strict OpenRouter models reject delegation schema | All declared properties are required. The default strict model can delegate and return attributed reports. |

The composer uses **Auto** when multi-agent is enabled with no selected crew; **Solo** means multi-agent is disabled. Provider capabilities remain distinct: Codex owns its native execution; Grokky owns OpenRouter's read-only specialist loops. A local native model override inherits the lead's OpenRouter model when used on OpenRouter.

## Verification

- `npm run verify`: hygiene, TypeScript, 183 deterministic tests, and production build passed. Eight opt-in tests were skipped during the default run.
- Two separately invoked live cases passed, one using Codex `gpt-5.6-sol`, the other OpenRouter `openai/gpt-5.2`. Both began with no picker selections and asked for two independent fictional gardening-club names. Both returned at least two confirmed child reports and a final answer.
- These single text-only runs took approximately 20.3 seconds for Codex and 13.2 seconds for OpenRouter. They are observations, not comparable latency benchmarks or percentile measurements.
- `npm run smoke:electron:full`: all 56 cases passed. An initial crew-selection fixture failed with a missing selected row; its isolated rerun and the subsequent complete suite passed. The intermittent failure is retained in private verification notes rather than presented as a diagnosed product defect.
- New desktop fixtures cover text and image draft switching, native Watch auto-open behavior and blocked wording, and Escape focus restoration.
- Controller verification checks blocked state in the conversation, lead seat, and reloaded persistence. Provider fixtures cover strict-schema compatibility, actual report attribution, disabled delegation, intent boundaries, and roster limits.
- Private live event evidence is retained under ignored `output/provider-ux-2026-09-08/`. No credentials or personal conversation content belong in this document.

## Local delivery

The Apple Silicon 0.1.5 app was packaged, its bundled Codex executable verified, installed and reopened. All 59 existing conversations and their message records, settings, and remote-device credentials were preserved. A verified 0.1.4 rollback ZIP and private state backup were retained. Installed-app interaction confirmed Auto mode and draft switching. No commit, push, or gateway deployment was performed.

## Still to improve

1. Ground proposed new specialists in the real catalog, with a reviewable Use once / Save agent flow. Current Auto mode discovers existing agents; it does not create definitions from chat.
2. Finish keyboard navigation and modal focus behavior across model selection, agent editing, and feature panels.
3. Correct the narrow composer/phone layout, preserve the reader's scroll position during updates, and unify small control and loading states.
4. Tune typography, spacing, motion and empty states against the journey register. Measure click feedback, rendering and provider latency separately before setting performance claims.
5. Continue Windows, physical-phone, slow-network and interrupted-run coverage. Existing deterministic desktop fixtures do not establish these outcomes.

This is the first correctness pass toward a polished experience across both providers. It does not close the entire audit or establish that every model, journey, or device is production-ready.
