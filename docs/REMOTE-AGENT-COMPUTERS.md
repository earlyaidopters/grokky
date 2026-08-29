# Remote agent computers

Research lock: **2026-08-29**

Grokky's shipped default is local-first: every lead and selected specialist receives an identity-bound computer seat, and local OpenRouter browsing uses a separate ephemeral Electron profile. Remote compute is optional. It must not be required to see agent state or use Watch.

## What works now

1. Run `npm run runner` on another private computer or VM.
2. Pair it from **Settings → Computer access**.
3. Select that device to pin OpenRouter seats in the next run to it.
4. Or enable **Spread OpenRouter crew across computers** to keep the selected device first and distribute later seats across online paired devices in round-robin order.

Each seat stores the assigned device at run start. Models never receive a device selector or runner credential. Structured file actions pass through the conversation sandbox, run/seat/device-scoped approval, a durable main-process audit intent, and the runner's fixed startup flags. Codex does not route through remote seats and remains on the local SDK host.

The current private runner supports bounded files only. The optional Cloudflare Sandbox Gateway supports model-driven files and commands in a separate non-root container plus a seat-bound Cloudflare Browser Run session. It can navigate approved public pages, return readable text and a 1280 × 800 PNG, expose the active browser through a short-lived signed Live View, and apply browser-scoped clicks and typing. Every action uses the same precommitted audit digest, short lease, replay receipt, and seat identity. The result is a live browser desktop with action-by-action evidence, not a general Linux GUI. The gateway is separately deployed and billable; `/workspace` remains independent because local project sync is not implemented yet.

## Current free-compute options

These offers can change. Verify the linked first-party terms before relying on them.

| Provider | Current free allocation | Fit for Grokky | Important constraint |
| --- | --- | --- | --- |
| Google Compute Engine | One non-preemptible `e2-micro` VM per month in `us-west1`, `us-central1`, or `us-east1`, plus 30 GB-months standard disk and 1 GB outbound transfer | Stable single remote runner for light file work | One Always Free VM is not one VM per crew member; billing account required and overages are possible |
| Oracle Cloud Always Free | Up to two AMD micro VMs, plus Ampere A1 usage equivalent to 2 OCPUs and 12 GB memory across one or two A1 instances | Best zero-cost capacity for a two-seat experiment | Home-region capacity can be unavailable; idle instances may be reclaimed; account usually requires phone and card verification |
| Tailscale Personal | Free for personal/non-commercial use, currently with unlimited user devices and up to 50 tagged resources | Private transport between Grokky and VM runners | The Personal plan is not intended for commercial use; use an appropriate paid or organizational plan when required |

First-party references:

- [Google Cloud Free Tier](https://docs.cloud.google.com/free/docs/free-cloud-features)
- [Google Compute Engine startup scripts](https://docs.cloud.google.com/compute/docs/instances/startup-scripts/linux)
- [Oracle Always Free resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)
- [Tailscale pricing](https://tailscale.com/pricing)

## Recommended first deployment

Use one Oracle A1 or Google `e2-micro` instance as a manually paired test runner before attempting automatic pools.

- Create a dedicated unprivileged `grokky-runner` operating-system user.
- Give it only one narrow workspace directory.
- Do not install or copy provider credentials, Codex auth, Grokky conversations, or the desktop app onto the runner.
- Start the runner without `--allow-write`; add it only after the read-only path is verified. `--allow-commands` is intentionally unsupported.
- Bind the built-in runner to `127.0.0.1`. Put an authenticated HTTPS reverse proxy or tunnel in front of it for remote access; Tailscale Serve, Caddy, or an equivalent managed TLS edge can provide that endpoint. Grokky rejects plain HTTP for every non-loopback address, including private LAN and Tailscale IPs.
- Use cloud firewall rules that deny public ingress and restrict egress where practical.
- Treat the five-minute pairing code and persistent runner token as secrets. Revoke the device while it is reachable so the runner persists a rotated token and monotonic epoch, returns its receipt, and only then lets Grokky remove the encrypted local copy.
- Set provider budgets and billing alerts even when using an Always Free shape.

## Optional isolated command gateway

See the authoritative [Cloudflare computer deployment and operations runbook](CLOUDFLARE-COMPUTER.md) for architecture, trust zones, exact deployment and pairing steps, Windows commands, rotation, rollback, monitoring, and troubleshooting. [`services/sandbox-gateway/README.md`](../services/sandbox-gateway/README.md) remains the service quick reference. The gateway implements one-time high-entropy enrollment, signed revocable device tokens, per-seat sandbox IDs, two-minute action leases, atomic replay claims, receipt replay, non-root command execution, a reusable Browser Run session, and explicit teardown. Cloudflare Sandbox requires Workers Paid; Browser Run usage and limits are accounted separately by Cloudflare.

## Why Grokky does not auto-provision general VMs yet

Provisioning a cloud VM changes external state, requires a cloud account and billing authority, and can create cost. More importantly, a safe automatic pool needs a stronger remote lease protocol than a reusable device bearer alone.

Before Grokky can create one VM per agent automatically, the runner protocol should add:

1. A control-plane pairing credential that is never available to a model-controlled process.
2. Short-lived, single-seat capabilities bound to agent ID, run ID, device ID, allowed tools, workspace root, and expiry.
3. Nonce or idempotency protection so a capability cannot be replayed for another action.
4. Cryptographically chained or remotely synchronized runner receipts and a server-issued seat identity. Phase 1 writes local append-only accepted/completed/failed receipts, but the shared bearer still authenticates the device rather than an independently leased agent.
5. Lease expiry, authenticated liveness heartbeats, cancellation, and guaranteed teardown.
6. Non-root containers or VMs, restricted ingress/egress, private transport, encrypted disks, and no shared provider/database secrets.
7. Budget ceilings and a user-confirmed apply step. Preview must be the default.

This keeps the OpenBot-style computer experience while avoiding its critical trust-boundary failure: a reusable actuator credential must not live in the same process compartment as arbitrary model-generated shell commands.

## Delivery phases

- **Phase 1 (shipped):** local identity-bound seats, Watch, exact OpenRouter action attribution, ephemeral browser profiles, integrity-checked captured evidence, online-only device pinning/spread, HTTPS enforcement away from literal loopback, and receipt-confirmed remote token rotation on revoke.
- **Phase 2 (sandbox slice shipped):** short-lived seat/action leases, authenticated 30-second heartbeats, durable replay claims, server-side device epochs, signed device tokens, and explicit container teardown. Cross-device receipt synchronization remains.
- **Phase 2B (browser desktop implemented):** seat-bound Browser Run reuse, approved-host navigation, ephemeral interactive Live View, screenshot evidence on every action, browser coordinate and text input, digest verification, model-visible frames, and explicit browser-session teardown.
- **Phase 3:** controlled project preview/apply, artifact survival, budget guardrails, private-network bootstrap, and stronger egress policy.
- **Phase 4:** a general remote operating-system GUI or continuous streaming only after its image, input, secret, cost, and approval boundaries are independently reviewed.
