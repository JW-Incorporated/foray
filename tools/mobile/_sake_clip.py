#!/usr/bin/env python3
"""Short before/after clips for the 'sake' fix -- kanban card t_040740c1.
Mirrors PR #383's short per-word clip style (ipa_default_*.mp3 / ipa_override_*.mp3)
rather than a full-beat render, so the proof clip stays small.
"""
from kokoro import KPipeline
import soundfile as sf
import numpy as np

CARRIER = "In this Foray, sake is a Japanese rice wine made by fermenting rice with koji mold."

pipeline = KPipeline(lang_code="a")
voice = "af_heart"

# Default (no override) -- what beat-6 sounded like before this card's fix:
# Kokoro reads "sake" as the English word.
chunks = []
for _, _, audio in pipeline(CARRIER, voice=voice):
    chunks.append(audio)
sf.write("/workspace/projects/foray/docs/research/fixtures/kokoro-acceptance-2026-08-31/sake_default_no_override.wav", np.concatenate(chunks), 24000)

# With misaki inline IPA override syntax applied to "sake" using the newly
# authored ipa from hard-terms.json.
CARRIER_OVERRIDE = "In this Foray, [sake](/ˈsɑːkeɪ/) is a Japanese rice wine made by fermenting rice with koji mold."
chunks = []
for _, _, audio in pipeline(CARRIER_OVERRIDE, voice=voice):
    chunks.append(audio)
sf.write("/workspace/projects/foray/docs/research/fixtures/kokoro-acceptance-2026-08-31/sake_ipa_override.wav", np.concatenate(chunks), 24000)

print("done")
