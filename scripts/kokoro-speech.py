#!/usr/bin/env python3
"""Local Kokoro adapter for OMARCHY_SPEECH_COMMAND; see docs/dictation.md."""

import argparse
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--text-file", type=Path, required=True)
    parser.add_argument("--wav-file", type=Path, required=True)
    parser.add_argument(
        "--model-dir",
        type=Path,
        default=Path.home() / ".local/share/omarchy-remote/kokoro/models",
    )
    parser.add_argument("--voice", default="af_heart")
    parser.add_argument("--blend-voice", help="Optional second voice to blend with --voice")
    parser.add_argument(
        "--blend-ratio", type=float, default=0.5,
        help="Weight of --voice: 1 is all first voice, 0 is all second voice",
    )
    parser.add_argument("--speed", type=float, default=1.0)
    parser.add_argument("--language", default="en-us")
    parser.add_argument("--threads", type=int, default=4)
    args = parser.parse_args()
    if not 0.5 <= args.speed <= 2.0 or not 1 <= args.threads <= 32:
        parser.error("speed must be 0.5–2.0 and threads must be 1–32")
    if not 0.0 <= args.blend_ratio <= 1.0:
        parser.error("blend ratio must be between 0 and 1")
    # Bound standalone use too; Herdr already enforces this input limit.
    with args.text_file.open("rb") as source:
        text = source.read(65537)
    if not text.strip() or len(text) > 65536:
        parser.error("text must be nonempty and at most 64 KiB")

    import onnxruntime as ort
    import soundfile as sf
    from kokoro_onnx import Kokoro

    options = ort.SessionOptions()
    options.intra_op_num_threads = args.threads
    options.inter_op_num_threads = 1
    # Do not spin CPU workers while waiting between inference operations.
    options.add_session_config_entry("session.intra_op.allow_spinning", "0")
    session = ort.InferenceSession(
        str(args.model_dir / "kokoro-v1.0.onnx"),
        sess_options=options,
        providers=["CPUExecutionProvider"],
    )
    kokoro = Kokoro.from_session(session, str(args.model_dir / "voices-v1.0.bin"))
    voice = args.voice
    if args.blend_voice:
        first = kokoro.get_voice_style(args.voice)
        second = kokoro.get_voice_style(args.blend_voice)
        if first.shape != second.shape:
            parser.error("voice styles must have matching shapes to blend")
        voice = first * args.blend_ratio + second * (1.0 - args.blend_ratio)
    samples, rate = kokoro.create(
        text.decode("utf-8"),
        voice=voice,
        speed=args.speed,
        lang=args.language,
    )
    sf.write(str(args.wav_file), samples, rate, format="WAV", subtype="PCM_16")


if __name__ == "__main__":
    main()
