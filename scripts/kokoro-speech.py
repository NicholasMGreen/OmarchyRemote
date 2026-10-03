#!/usr/bin/env python3
"""Local Kokoro adapter for OMARCHY_SPEECH_COMMAND; see docs/dictation.md.

The model stays loaded in a background worker between requests: the first request
starts it, and it exits after ten idle minutes. --no-server generates in this process.
"""

import argparse
import asyncio
import hashlib
import json
import os
from pathlib import Path
import socket
import struct
import subprocess
import sys
import time
import wave

FRAME = struct.Struct("<I")
# A worker that cannot speak a request sends this length, then a UTF-8 message, and closes.
FAILED = 0xFFFFFFFF
MAX_TEXT = 65536


def load(model_dir, threads):
    import onnxruntime as ort
    from kokoro_onnx import Kokoro

    options = ort.SessionOptions()
    options.intra_op_num_threads = threads
    options.inter_op_num_threads = 1
    # Do not spin CPU workers while waiting between inference operations.
    options.add_session_config_entry("session.intra_op.allow_spinning", "0")
    session = ort.InferenceSession(
        str(model_dir / "kokoro-v1.0.onnx"),
        sess_options=options,
        providers=["CPUExecutionProvider"],
    )
    return Kokoro.from_session(session, str(model_dir / "voices-v1.0.bin"))


def style(kokoro, request):
    if not request.get("blend_voice"):
        return request["voice"]
    first = kokoro.get_voice_style(request["voice"])
    second = kokoro.get_voice_style(request["blend_voice"])
    if first.shape != second.shape:
        raise ValueError("voice styles must have matching shapes to blend")
    ratio = request["blend_ratio"]
    return first * ratio + second * (1.0 - ratio)


async def generate(kokoro, request, write):
    """PCM v1: little-endian u32 byte count, mono 24kHz s16le, zero terminator."""
    import numpy as np

    async for samples, rate in kokoro.create_stream(
        request["text"], voice=style(kokoro, request), speed=request["speed"],
        lang=request["language"],
    ):
        if rate != 24000:
            raise ValueError("Streaming requires 24 kHz audio")
        pcm = (np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes()
        for offset in range(0, len(pcm), 16384):
            chunk = pcm[offset:offset + 16384]
            write(FRAME.pack(len(chunk)) + chunk)
    write(FRAME.pack(0))


class Sink:
    """Passes frames to stdout in pcm-stream mode; otherwise writes one WAV at the end."""

    def __init__(self, args, frames):
        self.args = args
        self.frames = frames
        self.pcm = bytearray()

    def write(self, frame):
        if self.args.format == "pcm-stream":
            self.frames.write(frame)
            self.frames.flush()
        elif len(frame) > 4:
            self.pcm.extend(frame[4:])
        else:
            with wave.open(str(self.args.wav_file), "wb") as output:
                output.setnchannels(1)
                output.setsampwidth(2)
                output.setframerate(24000)
                output.writeframes(self.pcm)


def socket_path(args):
    """A private per-user socket, named for this script and model so updates start a new worker."""
    base = os.environ.get("OMARCHY_KOKORO_SOCKET_DIR") or os.environ.get("XDG_RUNTIME_DIR")
    if not base:
        return None
    directory = Path(base) / "omarchy-remote"
    try:
        directory.mkdir(mode=0o700, exist_ok=True)
        status = directory.stat()
        if status.st_uid != os.getuid() or status.st_mode & 0o077:
            return None
        files = [Path(__file__), args.model_dir / "kokoro-v1.0.onnx", args.model_dir / "voices-v1.0.bin"]
        identity = [str(args.model_dir.absolute()), args.threads] + [
            [str(f), f.stat().st_mtime_ns, f.stat().st_size] for f in files
        ]
    except OSError:
        return None
    key = hashlib.sha256(json.dumps(identity).encode()).hexdigest()[:16]
    return directory / f"kokoro-{key}.sock"


def connect(path):
    connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        connection.connect(str(path))
        return connection
    except OSError:
        connection.close()
        return None


def receive(connection, size):
    data = bytearray()
    while len(data) < size:
        chunk = connection.recv(size - len(data))
        if not chunk:
            return None
        data.extend(chunk)
    return bytes(data)


def through_worker(args, request, sink):
    """Speaks through the worker; False means it was unavailable before any audio arrived."""
    path = socket_path(args)
    if path is None:
        return False
    connection = connect(path)
    if connection is None:
        subprocess.Popen(
            [sys.executable, __file__, "--serve", "--model-dir", str(args.model_dir),
             "--threads", str(args.threads)],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        deadline = time.monotonic() + 5
        while connection is None and time.monotonic() < deadline:
            time.sleep(0.05)
            connection = connect(path)
        if connection is None:
            return False
    with connection:
        try:
            connection.sendall(json.dumps(request, ensure_ascii=False).encode() + b"\n")
        except OSError:
            return False
        received = False
        while True:
            header = receive(connection, 4)
            if header is None:
                if not received:
                    return False
                raise SystemExit("Kokoro worker stopped before the speech finished")
            size, = FRAME.unpack(header)
            if size == FAILED:
                message = connection.recv(4096).decode("utf-8", "replace")
                raise SystemExit(f"Kokoro: {message}")
            payload = receive(connection, size) if size else b""
            if payload is None:
                raise SystemExit("Kokoro worker stopped before the speech finished")
            received = True
            sink.write(header + payload)
            if not size:
                return True


def valid(request):
    return (
        isinstance(request.get("text"), str)
        and 0 < len(request["text"].encode()) <= MAX_TEXT
        and isinstance(request.get("voice"), str)
        and isinstance(request.get("language"), str)
        and isinstance(request.get("speed"), (int, float))
        and 0.5 <= request["speed"] <= 2.0
        and isinstance(request.get("blend_ratio"), (int, float))
        and 0.0 <= request["blend_ratio"] <= 1.0
    )


def serve(args):
    path = socket_path(args)
    if path is None:
        return
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    # Bind before loading so clients can queue while the model loads.
    try:
        listener.bind(str(path))
    except OSError:
        if connect(path):
            return  # Another worker won the race.
        path.unlink(missing_ok=True)
        listener.bind(str(path))
    os.chmod(path, 0o600)
    owned = path.stat().st_ino
    listener.listen(8)
    listener.settimeout(int(os.environ.get("OMARCHY_KOKORO_WORKER_IDLE", "600")))
    try:
        kokoro = load(args.model_dir, args.threads)
        while True:
            try:
                connection, _ = listener.accept()
            except socket.timeout:
                break
            with connection:
                connection.settimeout(None)
                try:
                    request = json.loads(connection.makefile("rb").readline(4 * MAX_TEXT))
                    if not valid(request):
                        raise ValueError("invalid speech request")
                    asyncio.run(generate(kokoro, request, connection.sendall))
                except OSError:
                    pass  # The client went away; its process was stopped.
                except Exception as error:
                    try:
                        connection.sendall(FRAME.pack(FAILED) + str(error).encode()[:4000])
                    except OSError:
                        pass
    finally:
        try:
            if path.stat().st_ino == owned:
                path.unlink()
        except OSError:
            pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--text-file", type=Path)
    parser.add_argument("--wav-file", type=Path)
    parser.add_argument("--format", choices=["wav", "pcm-stream"], default="wav")
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
    parser.add_argument("--no-server", action="store_true",
                        help="Load the model in this process instead of the background worker")
    parser.add_argument("--serve", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if not 0.5 <= args.speed <= 2.0 or not 1 <= args.threads <= 32:
        parser.error("speed must be 0.5–2.0 and threads must be 1–32")
    if not 0.0 <= args.blend_ratio <= 1.0:
        parser.error("blend ratio must be between 0 and 1")
    if args.serve:
        serve(args)
        return
    if not args.text_file or not args.wav_file:
        parser.error("--text-file and --wav-file are required")
    # Bound standalone use too; Herdr already enforces this input limit.
    with args.text_file.open("rb") as source:
        text = source.read(MAX_TEXT + 1)
    if not text.strip() or len(text) > MAX_TEXT:
        parser.error("text must be nonempty and at most 64 KiB")
    # Audio frames keep the real stdout. Everything else written there, including by
    # native libraries, goes to stderr so it cannot corrupt the stream.
    frames = os.fdopen(os.dup(1), "wb")
    os.dup2(2, 1)
    request = {
        "text": text.decode("utf-8"),
        "voice": args.voice,
        "blend_voice": args.blend_voice,
        "blend_ratio": args.blend_ratio,
        "speed": args.speed,
        "language": args.language,
    }
    sink = Sink(args, frames)
    if not args.no_server and through_worker(args, request, sink):
        return
    asyncio.run(generate(load(args.model_dir, args.threads), request, sink.write))


if __name__ == "__main__":
    main()
