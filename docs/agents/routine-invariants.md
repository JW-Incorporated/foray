# Routine invariants — what must always be true of the scheduled fleet

Adopted from Swift2 (`JW-Incorporated/swift2`, `docs/agents/routine-invariants.md`)
after a 2026-07-25 audit there found **~69% of all scheduled agent token spend**
was agents re-reading their own unchanged PRs on self-armed hourly loops —
~144 cloud sessions/day, invisible to git, CI and the watchdog because the loops
were explicitly instructed not to comment when nothing changed.

Foray runs on the same Claude account as Swift2, so **this applies here too and
the same runaway is possible.**

## Foray's position today

Foray's scheduled routines are `foray-classify-shard0`–`shard5` (every 8h) and
`foray-nightly-enrich` (daily) — **~19 runs/day, which is currently the majority
of all agent spend across both projects** (~19 of ~32). That's not a problem by
itself; it's just where the money is, so it's the first place to look when
trimming. Wyatt's standing decision (2026-07-25) is to leave the cadence as-is.

**Foray does not need its own auditor.** The Swift2-hosted
`Routine Auditor — fleet invariants` (`trig_018V66TnhXVAt8BLt5AZZuUa`, weekly)
lists triggers **account-wide**, so it already covers Foray's routines and will
flag any violation below. Its findings land on a `routine-audit` issue in the
swift2 repo — check there, not here.

## The invariants

| # | Invariant | Why |
|---|---|---|
| 1 | **No trigger named `send_later*`** | That name means an agent armed a self-check-in. There is no legitimate use. |
| 2 | **No trigger carries the `Claude_Code_Remote` connector** (except the auditor) | That connector is the ability to *create triggers*. Removing it makes rogue spawning impossible rather than merely forbidden. New routines get it **by default**, which is why this needs checking forever, not once. |
| 3 | **No trigger sets `persist_session: true`** | A persistent session re-reads a growing history every wake, so cost climbs each cycle. |
| 4 | **Account-wide enabled trigger count ≤ 35** | A ceiling shared with Swift2. Adding Foray routines eats the same budget — raise it deliberately, don't dismiss the alert. |
| 5 | **No `Task` in `allowed_tools`** unless the charter says why | `Task` is subagent fan-out: one scheduled run silently becomes ten. |

## Adding a new Foray routine — the checklist

1. **Remove the `Claude_Code_Remote` connector.** Edit → Connectors → the `×` on
   the chip → Save. It is added by default and is the easiest thing to forget.
   **The API cannot do this** — it accepts `mcp_connections: []` with a 200 and
   silently keeps the connector. UI only.
2. Set `persist_session: false`.
3. Narrowest `allowed_tools` that works. No `Task`, no `Monitor` without a reason.
4. Pick the model deliberately. Opus is not the default answer: a
   script-and-summarize job is Sonnet, a deterministic poll is Haiku.
5. Add a **Run discipline** block: do the work, open the PR, exit. Never arm a
   self-check-in — CI and auto-merge already cover PR health.
6. Register it in [`runners.md`](runners.md) **with a prompt file**. Nine Swift2
   runners drifted precisely because their prompts lived only inside the trigger,
   where the "repo file is the source of truth" rule silently did not apply.

## The generalizable lesson

The cheap controls are at **creation time**: `allowed_tools` and connectors are
set when a routine is made, cost nothing, and are enforced by the runtime.
Prompt text is expensive to add, drifts, and is enforced by nobody. Everything
in Swift2's cleanup was retrofitting the second kind because the first kind
wasn't set at the start.
