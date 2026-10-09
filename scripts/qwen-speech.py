#!/usr/bin/env python3
"""Local Qwen3-TTS CustomVoice adapter for OMARCHY_SPEECH_COMMAND."""

import argparse
import os
from pathlib import Path
import re


def paragraphs(text, limit=500):
    """Keep generations bounded without dropping long paragraphs or sentences."""
    for paragraph in re.split(r"\n\s*\n", text.strip()):
        paragraph = " ".join(paragraph.split())
        while len(paragraph) > limit:
            # Prefer complete sentences to preserve the voice's natural phrasing.
            boundaries = list(re.finditer(r"[.!?]\s", paragraph[:limit + 1]))
            end = boundaries[-1].end() if boundaries else paragraph.rfind(" ", 0, limit + 1)
            if end <= 0:
                end = limit
            yield paragraph[:end].strip()
            paragraph = paragraph[end:].strip()
        if paragraph:
            yield paragraph


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--text-file", type=Path, required=True)
    parser.add_argument("--wav-file", type=Path, required=True)
    parser.add_argument(
        "--model-dir",
        type=Path,
        default=Path.home() / ".local/share/omarchy-remote/qwen-tts/model",
    )
    parser.add_argument("--speaker", default="Ryan")
    parser.add_argument("--language", default="English")
    parser.add_argument("--instruct", default="")
    parser.add_argument("--device", default="cuda:0")
    args = parser.parse_args()
    with args.text_file.open("rb") as source:
        text = source.read(65537)
    if not text.strip() or len(text) > 65536:
        parser.error("text must be nonempty and at most 64 KiB")

    import numpy as np
    import soundfile as sf
    import torch
    from qwen_tts import Qwen3TTSModel

    # Avoid benchmarking convolution kernels for every new audio length on AMD.
    if torch.version.hip:
        os.environ.setdefault("MIOPEN_FIND_MODE", "FAST")
    torch.set_num_threads(4)
    model = Qwen3TTSModel.from_pretrained(
        str(args.model_dir),
        device_map=args.device,
        dtype=torch.float32 if args.device == "cpu" else torch.bfloat16,
        attn_implementation="sdpa",
        local_files_only=True,
    )
    # One WAV per response, with the model reused across its text chunks.
    with sf.SoundFile(str(args.wav_file), "w", samplerate=24000, channels=1,
                      format="WAV", subtype="PCM_16") as output:
        for index, chunk in enumerate(paragraphs(text.decode("utf-8"))):
            waves, rate = model.generate_custom_voice(
                text=chunk,
                language=args.language,
                speaker=args.speaker,
                instruct=args.instruct,
                max_new_tokens=2048,
            )
            if rate != 24000:
                raise ValueError("Unexpected Qwen sample rate")
            if index:
                output.write(np.zeros(6000, dtype=np.float32))
            output.write(waves[0])


if __name__ == "__main__":
    main()
