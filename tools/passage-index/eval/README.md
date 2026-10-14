# tools/passage-index/eval

Gold labels for the retrieval replay gate (GV-88, W3-15;
`docs/roadmap/generation-v2.md`). The replay and the gate are described in
`../README.md` ("replay.mjs"); this directory holds only the labels the gate
measures candidate recall@8 against.

## gold.json

Optional. A JSON array of rows:

```json
[
  {
    "claim_hash": "<sha256 hex of the trimmed claim>",
    "show_id": "practical-ai",
    "guid": "<the archive guid>",
    "startSec": 1552,
    "endSec": 1662,
    "label": "on"
  }
]
```

| Field | Meaning |
| --- | --- |
| `claim_hash` | `claimHash` in `backend/src/generation/replayCompare.ts`: sha256 hex of the claim, trimmed. A replay report carries it on every beat. |
| `show_id`, `guid` | The episode, as the transcript archive names it. |
| `startSec`, `endSec` | The window the label was judged on. |
| `label` | `on`: the claim can be heard in the window. `adjacent`: same subject, does not state the claim. `off`: neither. |

**Ids and seconds only.** No claim, no transcript line, no episode title. The
schema (`parseGold`) rejects any string over 64 characters and any field it
does not name, and the replay refuses a file that fails it. A guid longer
than 64 characters cannot be labelled.

**Labelling method.** The tape-yield brief's
(`docs/curation/tape-yield-brief-2026-09-10.md`, appendix): read the full cue
text of the window and judge whether the claim is said there (`on`), the
subject is the same but the claim is not stated (`adjacent`), or neither
(`off`). Label from a local replay report (it has the claims and the
candidates); copy only the hash, the ids, the seconds and the label here.

**recall@8.** For each labelled episode (claim, show, guid, deduplicated) whose
claim is a beat of the replay, whether that episode is among the beat's first
8 candidates. Reported for `on` alone and for `on` or `adjacent`, for both
sides of a comparison. The seconds are recorded for a later window-level
measure; recall@8 is episode-level.
