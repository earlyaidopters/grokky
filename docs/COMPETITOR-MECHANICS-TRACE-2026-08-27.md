# Competitor mechanics trace: 2026-08-27

## Scope and safety

This trace used only net-new sessions in Grok Bot and Grokky. Existing conversations were not opened, edited, renamed, or messaged. A Grok Bot request to inspect the local computer was not approved; the trace recorded the permission state without executing the command.

## Grok Bot trace

The net-new parent bot was named `Mechanics Tracer`. It created `Spawn Scout`, `Urgency Scout`, and `Computer Scout`; `Spawn Scout` then created the net-new dormant child `Spawn Probe`.

### Strong mechanics

- Creating a bot applies its name and identity immediately, with no blocking setup wizard.
- Spawned bots become first-class sidebar entities with their own avatars, unread/working presence, persistent profile, folder, and conversation.
- The parent can keep working while children report independently. Peer exchanges collapse into compact `Messaged …` / `Message from …` rows that can be opened on demand.
- Parent bots send brief proactive status updates without requiring the user to open the raw exchange log.
- Conversation details expose a stable name, title, purpose/description, avatar, and completion/attention notification control.
- The separate agent computer starts without a user approval step. Access to the user's computer produces an explicit approval gate.

### Queue and interruption behavior

- The exposed peer API has normal and `priority=true` messages. There is no third urgent tier.
- Priority mail interrupts an active turn. Interrupted work is discarded rather than paused.
- Normal mail waits behind the active turn and every priority message. One normal follow-up arrived roughly three minutes later.
- Sender acknowledgement differs from receiver completion; there is no clear delivery/read receipt.
- Several peer assignments or priority messages were delivered again after the receiving bot had already stopped or reported. These late replays interrupted finished/addendum work and made queue state opaque.
- Child creation is immediate enough to race a later stop instruction. `Spawn Probe` was created before the read-only stop reached its parent, but stayed dormant and unmessaged.
- A newly assigned bot can skip an introductory greeting and wake directly on the assignment.

### Confusing or unfinished areas

- No visible user-facing distinction between a queued normal peer message and a dropped one until it eventually wakes the receiver.
- No urgency badge or urgent user notification channel beyond priority interruption.
- Generated bot metadata can be incomplete: empty title/avatar, `namedBy: "user"` for agent-created bots, and a teammate list that can lag persisted state.
- Computer permission errors are legible to the agent (`Aborted`, then `went unanswered`) but the approval location and queue semantics are not obvious from the child computer view.
- Some scout reports were truncated when another priority message arrived.

## Grokky baseline trace

The first net-new Grokky run selected `explorer`, `worker`, and `tester` and completed in about 1 minute 16 seconds.

Already stronger than Grok Bot:

- Explicit role identities and independent reports.
- Visible per-role states and elapsed time.
- A structured overview plus a grouped message transcript.
- Clear final synthesis with retained evidence.
- Clear invalid-target errors and observable interruption/recovery states in the collaboration runtime.

Baseline gaps:

- The composer was disabled during a run, so the user could neither steer nor queue work.
- Coordinator narration existed in the event stream but was hidden from the primary run surface.
- Sessions had no stable name/purpose controls or notification identity.
- Selected specialists were not persistent sidebar presences.
- Completed background work had no unread indicator.
- Messages had no copy or quote/reply affordances.

## Mechanics pass implemented

- Live follow-up composer during active runs.
- Normal follow-up queue with a visible `Up next` panel.
- Explicit priority redirect using the lightning action or Command+Enter.
- Priority redirects abort the active turn cleanly and begin immediately; ordinary queued work remains visible.
- Compact live coordinator updates in the crew overview.
- Session name and persistent purpose/instructions, injected into every provider turn.
- Nested crew presence and per-agent states in the sidebar, including background running sessions.
- Unread completion count for inactive sessions.
- Message-level Copy and Reply/quote actions.
- Clearer stop placement, running keyboard hints, queue state, and responsive 1100-pixel layout.

## Installed-build verification

The post-update net-new session `World-class mechanics QA` verified:

- identity and purpose save immediately and persist;
- all three selected roles appear in the sidebar;
- a normal follow-up appears in the visible queue;
- a priority redirect interrupts the active turn and starts as a new user turn;
- queued normal work survives the redirect;
- coordinator narration appears in the overview without opening raw messages;
- switching to another net-new session leaves the background run active.
- a deliberately slow redirected crew run remained responsive and cancellable, but produced no specialist report in 9 minutes 40 seconds; cancellation now renders `Crew run stopped` instead of incorrectly presenting zero reports as delivered;
- a separate short background crew run completed in 2 seconds and produced a visible `1 unread reply` badge; opening it cleared the badge;
- Copy changed to `Copied` on activation, and Reply inserted a Markdown quote into the composer without sending it.

Automated verification: repository hygiene, TypeScript, 56 tests, production build, Electron smoke tests, 1440×960 and 1100×900 layout assertions, and packaged Codex runtime verification all passed.
