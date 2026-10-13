# Generation providers: modes, variables, lanes and routing

Who serves each stage of the Foray generation pipeline, and how to choose it.
This page is the operator's reference for `backend/src/config/stageRouting.ts`
(GV-03, GV-68), the stage factories (GV-37) and the judge (GV-47). The plan it
belongs to is `docs/roadmap/generation-v2.md` (issue #1286).

## The rule: zero Anthropic calls

The generation pipeline makes **no Anthropic API call**. This is a founder
rule, recorded in `docs/roadmap/generation-v2.md` under "Constraints". The
models are Qwen on the DGX Spark and on the second box (both behind LiteLLM)
and Jev. Since GV-68 the rule is enforced in code, not left to convention:

- **A structural test.** `backend/test/noAnthropicInGeneration.test.ts` scans
  `backend/src/generation/**`, `cli/generateForays.ts` and
  `cli/generateForay.ts`. Only the seven `Anthropic*.ts` builders and
  `anthropicCall.ts` may import `@anthropic-ai/sdk`, `./anthropicCall` or an
  `./Anthropic*` module. The `create*.ts` factories may do so only on their
  lazy `require` line. `chat/**`, `jevClient.ts` and `qwenJudgeClient.ts` fall
  under the same rule.
  - One exception is pinned to its exact statement: `chat/ChatNarrationWriterBuilder.ts`
    imports the pure `actOutputTokenBudget` from the legacy writer (decision 10).
    It goes when the legacy builders are retired (GV-96).
  - Only `anthropicCall.ts` may call `messages.create` or `messages.stream`.
- **No key selects Claude.** `ANTHROPIC_API_KEY` alone no longer selects
  anything: a shell with only that key resolves every stage to the Stub. The
  driver's `MODE:` line then says the key was ignored.
- **Two explicit opt-ins for legacy.** The legacy Anthropic builders need both
  `FORAY_GENERATION_MODE=anthropic-legacy` and `FORAY_ALLOW_ANTHROPIC_LEGACY=1`.
  - The same holds for any `FORAY_STAGE_<STAGE>=anthropic` override, in any mode.
  - An `anthropic` route without both opt-ins stops the run before any stage
    runs. The error is a `RoutingConfigError` that names the rule and the
    missing variable.
- **Every batch reports its count.** `createMessage` counts every Anthropic
  request in the process, failed ones included. `generateForays` writes the
  count to `report.json` as `anthropicCalls`, on every row and at the top
  level. It exits non-zero when the count is above 0 and
  `FORAY_ALLOW_ANTHROPIC_LEGACY=1` is not set.
- **The relay is refused by default.** `tools/generation/start-run.mjs` (the
  Claude relay launcher) refuses to start anything, the bare relay included,
  unless `--legacy-claude` is passed.
  - With the flag, it sets both legacy opt-ins for the driver and prints that
    the run breaks the rule.
  - A local run needs no relay: run the driver directly (below).

`env.anthropicDryRun` is unchanged: `enrich/` and `cli/buildSession.ts` still
read it. The legacy builders still refuse to construct without a key, which is
why the relay launcher still sets its placeholder key.

## Modes

`FORAY_GENERATION_MODE` picks the mode when it is set. Otherwise the mode is
inferred:

| Set in the environment | Mode | What each stage is |
| --- | --- | --- |
| nothing (or only `ANTHROPIC_API_KEY`) | `stub` | every stage is the Stub; the judge is fail-closed `none` (or `jev` when a Jev key exists) |
| `FORAY_LLM_BASE_URL` | `local` | the local defaults below, on the LiteLLM lanes |
| `FORAY_GENERATION_MODE=stub` | `stub` | Stubs, even when `FORAY_LLM_BASE_URL` is set |
| `FORAY_GENERATION_MODE=local` | `local` | needs `FORAY_LLM_BASE_URL`, or the run stops naming it |
| `FORAY_GENERATION_MODE=anthropic-legacy` and `FORAY_ALLOW_ANTHROPIC_LEGACY=1` | `anthropic-legacy` | today's Anthropic builders on their `models.ts` tiers; breaks the zero-Anthropic rule |

`--dry-run` on the driver is a different switch: it only suppresses writes
(candidates, checkpoints, `report.json`). It does not choose a mode.

## Shell-environment caveat

**`FORAY_LLM_BASE_URL` alone switches every stage to local mode.** No other
variable is needed, and `FORAY_GENERATION_MODE` does not have to be set.

A developer shell that still exports `FORAY_LLM_BASE_URL` from an earlier
session (a profile line, a `.env` loader, a terminal left open after a live
check) has two effects:

- A run you meant as a stub dry-run sends every stage to the lanes. Against a
  reachable LiteLLM, that is real Spark and second-box work, with no unit caps
  until GV-90 and GV-93 land (decision 31).
- Backend suites that call the stage factories without an injected source
  build Chat builders instead of Stubs, so they fail or behave differently.
  `ANTHROPIC_API_KEY` used to cause the same trouble before GV-68.

To check, read the `MODE:` line the driver prints first. A local run says
`generation mode local (from FORAY_LLM_BASE_URL)`. The routing is also in
`report.json` as `generationMode` and `routing`.

To fix it, do one of these:

- Unset the variable for the session.
  - bash: `unset FORAY_LLM_BASE_URL`
  - PowerShell: `Remove-Item Env:FORAY_LLM_BASE_URL`
- Pin the mode explicitly, which wins over inference:
  - bash: `export FORAY_GENERATION_MODE=stub`
  - PowerShell: `$env:FORAY_GENERATION_MODE = "stub"`
- For a deliberate local run, pin `FORAY_GENERATION_MODE=local` as well, so the
  intent is on the command line and not inferred from a leftover variable.

Tests never depend on the ambient shell: they pass an injected source to
`resolveRouting` or the factories, or stub the variables with `vi.stubEnv`.

## The variables

### LiteLLM: one set, shared by the backend and the dossier selector

| Variable | Meaning |
| --- | --- |
| `FORAY_LLM_BASE_URL` | LiteLLM's OpenAI-compatible origin (the Spark serves it on port 4000). Setting it alone selects local mode (see the caveat above). Never logged: summaries print it without credentials, query or fragment. |
| `FORAY_LLM_API_KEY` | The LiteLLM key. |
| `FORAY_LLM_API_KEY_FILE` | A file holding the key (trimmed). Used when `FORAY_LLM_API_KEY` is unset. An unreadable or empty file stops the run, naming the variable. |
| `FORAY_DOSSIER_MODEL` | The dossier selector only (`tools/corpus/dossiers/`, GV-65). The LiteLLM model alias it asks; default `local-worker`. |

The dossier selector reads the same three `FORAY_LLM_*` variables as the
backend. It has no variables of its own beyond `FORAY_DOSSIER_MODEL`.

### Routing

| Variable | Meaning |
| --- | --- |
| `FORAY_GENERATION_MODE` | `stub`, `local` or `anthropic-legacy`. |
| `FORAY_ALLOW_ANTHROPIC_LEGACY` | `1` is the second legacy opt-in; `0` or unset is off; any other value is refused. |
| `FORAY_STAGE_<STAGE>` | `<impl>[:<lane>]` for one stage. It applies in any mode. |
| `FORAY_ALLOW_PROSE_ON_SECOND` | `1` lets the writer run on a lane whose profile has `allowsProse: false`. |
| `FORAY_MACHINE_PROFILES_FILE` | A JSON file of lane-profile overrides (aliases, concurrency, prose rule). |

`generateForays --stage-provider stage=impl[:lane][,...]` sets the same
`FORAY_STAGE_*` overrides from the command line.

### Jev (the judge, clarity and the verifier)

| Variable | Meaning |
| --- | --- |
| `JEV_API_KEY` / `JEV_KEY_FILE` | The Jev key, or a file holding it. Without one, a `jev` route is inert (fail-closed), or falls back to the Qwen judge when it names a lane. |
| `FORAY_JEV_BASE_URL` | The Jev host (default: jevClient.ts's pinned host). |
| `FORAY_JEV_MODEL` | The Jev model (default: jevClient.ts's pinned model). |
| `FORAY_JEV_BUDGET_MS` | The total time one Jev ask may take (default 4000). |

## Stages and their implementations

The stages, with the variable that routes each one: `understand.clarity`
(`FORAY_STAGE_UNDERSTAND_CLARITY`), `understand.intent`, `understand.title`,
`research`, `spine`, `spine-alt` (the best-of-2 spine's second sampler; unset
means none), `deepen`, `writer`, `verifier`, `continuity` and `judge`.

| Implementation | Where it may be used |
| --- | --- |
| `stub` | every stage except the judge |
| `local[:lane]` | every model stage except research; the judge as the Qwen judge |
| `jev[:lane]` | clarity, the verifier and the judge; a lane names the Qwen fallback |
| `none` | research (no outside research, OQ-04) and the judge (fail-closed) |
| `dossier` | research, from local dossiers (GV-69) |
| `anthropic` | the legacy builders; needs both opt-ins (above) |

## Lanes

| Lane | Machine | LiteLLM alias | Prose | Notes |
| --- | --- | --- | --- | --- |
| `spark` | DGX Spark, Qwen3.8-27B on SGLang | `local-heavy` | yes | `maxConcurrent: 2` is a Foray policy, not a hardware limit (decision 26). |
| `second` | the second box (Hermes records 2x Tesla P40 and Qwen3.6-35B-A3B; OQ-01 open) | `local-worker` | no | planning-side JSON only; prompt ceiling of 2,000 tokens. |

The profiles live in `backend/src/config/machineProfiles.ts`. Override them
with `FORAY_MACHINE_PROFILES_FILE`.

## Local-mode defaults

| Stage | Default in local mode |
| --- | --- |
| understand.clarity, understand.intent, understand.title | `local:spark` |
| research | `none` (OQ-04: clip transcripts only on the timed path) |
| spine | `local:spark` |
| deepen | `local:second` |
| writer, verifier, continuity | `local:spark` |
| judge | `jev:second` (Jev, with the Qwen judge on the second box as fallback) |
| spine-alt | none unless `FORAY_STAGE_SPINE_ALT` is set |

## The judge and its fallback

The judge is routed like any other stage (`FORAY_STAGE_JUDGE`, GV-47; OQ-05:
Jev inside generation with a Qwen-judge fallback).

| Route | What answers |
| --- | --- |
| `none` | `NullJevClient`. Fail-closed: every consumer reads the answer as "not passed". |
| `local:<lane>` | The Qwen judge on that lane. |
| `jev` | Jev. Without a key it is inert, which is the same as `none`. |
| `jev:<lane>` | Jev first, then the Qwen judge on `<lane>`, behind a circuit breaker. After repeated Jev failures the breaker opens and sends every ask straight to the fallback for a while. With no Jev key, the Qwen judge answers alone. |

The defaults:

- In local mode the judge is `jev:second`.
- In any other mode it is `jev` when a Jev key exists, otherwise `none`.
- Every answer is tagged with the judge that gave it, so gate thresholds are
  read per judge.

## Running

- **Stub dry run** (no keys; CI and offline checks). Run this from `backend/`.
  Pin the mode if your shell may carry `FORAY_LLM_BASE_URL`:

      FORAY_GENERATION_MODE=stub npm run generate-forays -- --prompts p.json --dry-run

- **Local run** (needs the LiteLLM key from #1163). Run this from `backend/`:

      FORAY_GENERATION_MODE=local FORAY_LLM_BASE_URL=http://<litellm-host>:4000 FORAY_LLM_API_KEY_FILE=<path> \
        npm run generate-forays -- --prompts p.json --limit 1

- **Legacy Claude run.** This breaks the zero-Anthropic rule and exits non-zero
  unless both opt-ins are set:

      node tools/generation/start-run.mjs --legacy-claude -- --prompts p.json

## Live steps

Every live step waits on founder-supplied secrets queued on #1163 (the LiteLLM
key, the Jev key). None blocks code work.

Until GV-90 (Spark, second-box and Jev unit caps) and GV-93 (lane-scheduler
metering) have both merged, decision 31 applies:

- Run no unattended or batch local generation: no golden-set batch, no
  swap-experiment arm, no overnight job.
- Run only watched single-prompt checks, started by an agent. The per-stage
  output budgets (GV-14) are the only bound on each call.

The dossier selection (GV-65) is not a generation run. It runs only with the
founder's key and his go-ahead on #1163.

To check that a live run kept the rule, read `report.json`:

- `anthropicCalls` is 0 at the top level and on every row;
- `generationMode` is `local`;
- `routing.stages` names a `local:<lane>`, `jev`, `none` or `dossier` route for
  every stage, and never `anthropic`.
