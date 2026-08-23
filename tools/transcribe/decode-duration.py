#!/usr/bin/env python3
"""Decode one audio file and report what is REALLY in it, as JSON on stdout.

WHY THIS EXISTS -- ADR-0008 names decode-and-compare as the instrument of last
resort ("fetch the enclosure, decode it, and compare the true duration
against..."), and records that no committed tool did it: `ad-inflation.mjs`
does ranged GETs only, and the two Gastropod probes that forced the ADR's
upper-bound rule were an ad-hoc script whose numbers live in a PR comment. Per
that ADR's own workflow note, the second show to need this gets a committed
script with a test floor rather than another ad-hoc run. This is that script.

It reads a file that is already on disk and makes NO network request. Fetching
is `tools/transcribe/fetch-audio.mjs`'s job and stays there: a decoder that
could also download is a decoder that can be pointed at a URL by accident, and
audio fetching in this repo is a gated decision (#108), not a convenience.

WHY THREE DURATIONS AND NOT ONE, which is the whole point of the file.

  1. `container_duration_sec` is ADR-0008's stated formula,
     `container.duration / av.time_base`. It is reported because that ADR's
     numbers were taken this way and a later reader has to be able to line
     ours up against Gastropod's.

  2. `packet_duration_sec` sums the demuxed packets' own durations. This one
     is load-bearing and the reason the file is not four lines long. For a
     constant-bitrate MP3 with no Xing/VBRI header, FFmpeg ESTIMATES the
     container duration as (file size - tag bytes) x 8 / bitrate. That makes
     reading #1 CIRCULAR for the question we are asking: we want to know
     whether the delivered bytes carry more audio than the transcript
     describes, and #1 would derive its answer from the byte count we are
     trying to check. Summing real frames cannot do that -- a frame either is
     in the file or is not.

  3. `frames` x `frame_size` / `sample_rate` is the same quantity counted from
     the codec's own frame geometry instead of from the demuxer's per-packet
     durations.

     BE PRECISE ABOUT HOW INDEPENDENT THIS IS, because an earlier draft of this
     docstring oversold it. `frames` is incremented once per demuxed packet in
     the same loop, so on any file whose frames share one geometry #2 and #3 are
     two arithmetic routes over one traversal and agree to full float precision
     -- which is what all five committed rows show, `duration_spread_sec: 0`.
     That zero is structural, not corroborative, and it must not be read as two
     witnesses agreeing. What the pair genuinely detects is a file whose frames
     do NOT share one geometry: #2 sums each packet's own duration while #3
     assumes a constant frame size, so a concatenation of differently-encoded
     parts drives them apart. That is a narrow check, and it is the one the
     agreement band is for.

WHAT `first_packet_pos` IS FOR. The byte offset of the first audio packet is
how many leading bytes of the file are NOT audio -- an ID3v2 tag, its artwork,
whatever else a host prepends. The Art Bell Archive question is precisely "are
these 99,345 constant bytes a metadata block or a house pre-roll", and this
number bears on it directly: metadata sits BEFORE the first frame and audio
does not. `decode-compare.mjs` cross-checks it against its own ID3v2 header
parse, so the claim rests on two independent readings rather than on trusting
either.

TWO MEASURED QUIRKS, recorded here so the next reader does not rediscover them
as bugs. Both were found by decoding a synthetic 96kbps MP3 written for the
purpose rather than by reasoning about the format:

  - `first_packet_pos` OVERSHOOTS the ID3v2 tag length by ONE FRAME on any file
    an ordinary encoder produced (measured: tag 45 bytes, first packet at 358,
    difference 313 = 96000/8 x 1152/44100). That frame is the Xing/LAME header
    -- a well-formed MPEG frame holding a duration table instead of audio,
    which FFmpeg's demuxer consumes as a header and never emits. So the two
    readings agree to within a frame, not to the byte, and `tagBoundaryAgrees`
    is written to that tolerance.

  - `frames` runs one or two ahead of the frames an encoder was handed, because
    of encoder delay padding. At 26ms per frame that is noise against every
    question this tool is pointed at (16s, 30s, minutes), but it is why
    `packet_duration_sec` and `container_duration_sec` differ by ~0.03s on a
    healthy file and why the agreement band is a second rather than a frame.

DEMUX, NOT DECODE. Nothing here turns compressed frames into PCM. Demuxing
reads frame headers and skips the payload, which is ~50x faster and enough for
every number above; decoding would buy only the ability to hear it, and we
never need to. R11 stands: nothing in this file identifies, classifies or
removes an advertisement, and it cannot -- it counts frames.

    python decode-duration.py FILE
    python decode-duration.py FILE --pretty

Requires `av==18.0.0`, already pinned in requirements.txt for the transcription
harness. No new dependency, and NOTHING ELSE is imported from that file: this
does not need faster-whisper and must stay runnable without it.
"""

import argparse
import json
import os
import sys


def probe(path):
    """Every number we can read out of the container, or an `error` key."""
    import av  # imported late so --help works without the wheel installed

    out = {
        "path": os.path.basename(path),
        "file_bytes": os.path.getsize(path),
        "container_duration_sec": None,
        "packet_duration_sec": None,
        "frame_geometry_sec": None,
        "packets": 0,
        "first_packet_pos": None,
        "last_packet_end_pos": None,
        "codec": None,
        "sample_rate": None,
        "channels": None,
        "stream_bit_rate_bps": None,
        "container_format": None,
        "metadata_keys": [],
    }

    with av.open(path) as container:
        out["container_format"] = container.format.name
        # Tag KEYS only, never values. Episode titles and copyright lines are
        # the publisher's text, and this report is committed to the repo.
        out["metadata_keys"] = sorted(container.metadata.keys())

        if container.duration is not None:
            out["container_duration_sec"] = container.duration / av.time_base

        stream = next((s for s in container.streams if s.type == "audio"), None)
        if stream is None:
            out["error"] = "no audio stream"
            return out

        codec_ctx = stream.codec_context
        out["codec"] = codec_ctx.name if codec_ctx else None
        out["sample_rate"] = getattr(codec_ctx, "sample_rate", None)
        out["channels"] = getattr(codec_ctx, "channels", None)
        out["stream_bit_rate_bps"] = getattr(codec_ctx, "bit_rate", None) or None

        ticks = 0
        packets = 0
        frames = 0
        frame_size = None
        first_pos = None
        last_end = None

        for packet in container.demux(stream):
            # The demuxer emits one flush packet with no data at the end.
            if packet.size is None or packet.size == 0:
                continue
            packets += 1
            if packet.duration:
                ticks += packet.duration
            pos = packet.pos
            if pos is not None and pos >= 0:
                if first_pos is None or pos < first_pos:
                    first_pos = pos
                end = pos + packet.size
                if last_end is None or end > last_end:
                    last_end = end
            # `frame_size` is the codec's samples-per-frame (1152 for MPEG-1
            # Layer III). Read off the context once it is populated.
            if frame_size is None:
                fs = getattr(codec_ctx, "frame_size", None)
                if fs:
                    frame_size = fs
            frames += 1

        out["packets"] = packets
        out["first_packet_pos"] = first_pos
        out["last_packet_end_pos"] = last_end
        if ticks and stream.time_base:
            out["packet_duration_sec"] = float(ticks * stream.time_base)
        if frames and frame_size and out["sample_rate"]:
            out["frame_geometry_sec"] = frames * frame_size / out["sample_rate"]
        out["frames"] = frames
        out["frame_size"] = frame_size

    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("path", help="audio file already on disk")
    ap.add_argument("--pretty", action="store_true", help="indent the JSON")
    args = ap.parse_args(argv)

    if not os.path.isfile(args.path):
        json.dump({"error": "not a file", "path": args.path}, sys.stdout)
        sys.stdout.write("\n")
        return 2

    try:
        report = probe(args.path)
    except Exception as exc:  # noqa: BLE001 -- the caller wants the message, not a stack
        json.dump({"error": f"{type(exc).__name__}: {exc}", "path": os.path.basename(args.path)}, sys.stdout)
        sys.stdout.write("\n")
        return 1

    json.dump(report, sys.stdout, indent=2 if args.pretty else None, sort_keys=True)
    sys.stdout.write("\n")
    return 1 if "error" in report else 0


if __name__ == "__main__":
    sys.exit(main())
