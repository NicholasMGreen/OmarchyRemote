"""Optional real-model checks; run with the Kokoro virtual environment's Python."""

import importlib.util
import os
from pathlib import Path
import subprocess
import struct
import sys
import tempfile
import time
import unittest
import wave

WORKER_ENVIRONMENT = ["OMARCHY_KOKORO_SOCKET_DIR", "OMARCHY_KOKORO_WORKER_IDLE"]


def adapter():
    """The adapter script as a module, for its pure helpers."""
    spec = importlib.util.spec_from_file_location(
        "kokoro_speech", Path(__file__).with_name("kokoro-speech.py")
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@unittest.skipUnless(importlib.util.find_spec("numpy"), "numpy is not installed")
class LoudnessTests(unittest.TestCase):
    def test_gain_raises_speech_and_limits_peaks_without_clipping(self):
        import numpy as np

        louder = adapter().louder
        quiet = np.array([0.0, 0.1, -0.2, 0.4], dtype=np.float32)
        np.testing.assert_allclose(louder(quiet.copy(), 2.0), quiet * 2, rtol=1e-6)
        loud = louder(np.array([0.6, -0.9, 1.0], dtype=np.float32), 2.0)
        self.assertTrue(np.all(np.abs(loud) <= 1.0))
        self.assertTrue(np.all(np.abs(loud) > 0.9))
        self.assertEqual(list(np.sign(loud)), [1.0, -1.0, 1.0])


@unittest.skipUnless(importlib.util.find_spec("kokoro_onnx"), "Kokoro is not installed")
class KokoroSpeechTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Workers started here use their own socket folder and exit soon after the tests.
        cls.sockets = tempfile.TemporaryDirectory()
        cls.environment = {key: os.environ.get(key) for key in WORKER_ENVIRONMENT}
        os.environ["OMARCHY_KOKORO_SOCKET_DIR"] = cls.sockets.name
        os.environ["OMARCHY_KOKORO_WORKER_IDLE"] = "3"

    @classmethod
    def tearDownClass(cls):
        for key, value in cls.environment.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        cls.sockets.cleanup()

    def worker_sockets(self):
        return list((Path(self.sockets.name) / "omarchy-remote").glob("kokoro-*.sock"))

    def speak(self, folder, *options):
        source = Path(folder) / "input.txt"
        output = Path(folder) / "output.wav"
        source.write_text("A short sentence to speak.", encoding="utf-8")
        command = [
            sys.executable, str(Path(__file__).with_name("kokoro-speech.py")),
            "--text-file", str(source), "--wav-file", str(output), *options,
        ]
        return subprocess.run(command, capture_output=True, timeout=180), output

    def test_worker_keeps_the_model_loaded_between_requests(self):
        with tempfile.TemporaryDirectory() as folder:
            started = time.monotonic()
            result, output = self.speak(folder)
            cold = time.monotonic() - started
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            self.assertTrue(output.exists())
            [worker] = self.worker_sockets()
            identity = worker.stat().st_ino
            output.unlink()
            started = time.monotonic()
            result, output = self.speak(folder)
            warm = time.monotonic() - started
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            with wave.open(str(output)) as wav:
                self.assertEqual(wav.getframerate(), 24000)
                self.assertGreater(wav.getnframes(), 0)
            # The same worker answered, without loading the model again.
            self.assertEqual(worker.stat().st_ino, identity)
            self.assertLess(warm, cold)

    def test_worker_reports_errors_and_exits_when_idle(self):
        with tempfile.TemporaryDirectory() as folder:
            result, output = self.speak(folder, "--voice", "no_such_voice")
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(b"Kokoro:", result.stderr)
            self.assertFalse(output.exists())
            self.assertTrue(self.worker_sockets())
            deadline = time.monotonic() + 15
            while self.worker_sockets() and time.monotonic() < deadline:
                time.sleep(0.2)
            self.assertEqual(self.worker_sockets(), [])

    def test_stream_starts_before_generation_finishes(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "input.txt"
            output = Path(folder) / "unused.wav"
            source.write_text(
                "The first paragraph should play while later paragraphs are still being generated. "
                "We are testing clear speech, natural pauses, and complete delivery.\n\n" * 15,
                encoding="utf-8",
            )
            command = [
                sys.executable, str(Path(__file__).with_name("kokoro-speech.py")),
                "--text-file", str(source), "--wav-file", str(output),
                "--format", "pcm-stream", "--voice", "bm_fable",
                "--language", "en-gb", "--speed", "1.2",
            ]
            with subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0) as child:
                try:
                    first = child.stdout.read(4)
                    self.assertEqual(len(first), 4)
                    self.assertIsNone(child.poll(), "Adapter waited until all speech was generated")
                    rest, stderr = child.communicate(timeout=180)
                finally:
                    if child.poll() is None:
                        child.kill()
                self.assertEqual(child.returncode, 0, stderr.decode())
            stream = first + rest
            offset = 0
            samples = 0
            frames = 0
            while offset < len(stream):
                size, = struct.unpack_from("<I", stream, offset)
                offset += 4
                if size == 0:
                    break
                self.assertEqual(size % 2, 0)
                self.assertLessEqual(size, 16384)
                self.assertLessEqual(offset + size, len(stream))
                samples += size // 2
                frames += 1
                offset += size
            self.assertEqual(size, 0, "Missing successful end marker")
            self.assertEqual(offset, len(stream))
            self.assertGreater(samples / 24000, 60)
            self.assertGreater(frames, 10)
            self.assertFalse(output.exists())

    def test_stray_stdout_output_cannot_corrupt_the_stream(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "input.txt"
            source.write_text("A short sentence to speak.", encoding="utf-8")
            script = str(Path(__file__).with_name("kokoro-speech.py"))
            arguments = [
                "--text-file", str(source), "--wav-file", str(Path(folder) / "unused.wav"),
                "--format", "pcm-stream", "--no-server",
            ]
            # Writes to stdout once the adapter has loaded, as a noisy library would.
            noisy = (
                "import asyncio, os, runpy, sys\n"
                "real = asyncio.run\n"
                "def run(work):\n"
                "    os.write(1, b'native noise\\n')\n"
                "    print('python noise', flush=True)\n"
                "    return real(work)\n"
                "asyncio.run = run\n"
                f"sys.argv = [{script!r}] + {arguments!r}\n"
                f"runpy.run_path({script!r}, run_name='__main__')\n"
            )
            result = subprocess.run([sys.executable, "-c", noisy], capture_output=True, timeout=180)
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            self.assertIn(b"native noise", result.stderr)
            self.assertIn(b"python noise", result.stderr)
            stream, offset, size = result.stdout, 0, None
            while offset < len(stream):
                size, = struct.unpack_from("<I", stream, offset)
                offset += 4 + size
                self.assertEqual(size % 2, 0)
                if size == 0:
                    break
            self.assertEqual(size, 0, "Missing successful end marker")
            self.assertEqual(offset, len(stream))

    def test_blend_generates_audio_and_validates_ratios(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "input.txt"
            output = Path(folder) / "output.wav"
            source.write_text(
                "Take a moment to listen to the pacing and tone of this voice.",
                encoding="utf-8",
            )
            command = [
                sys.executable, str(Path(__file__).with_name("kokoro-speech.py")),
                "--text-file", str(source), "--wav-file", str(output),
                "--language", "en-gb",
            ]

            def render(*options):
                subprocess.run(command + list(options), check=True,
                               capture_output=True, timeout=180)
                with wave.open(str(output)) as wav:
                    self.assertEqual(wav.getframerate(), 24000)
                    self.assertEqual(wav.getnchannels(), 1)
                    self.assertEqual(wav.getsampwidth(), 2)
                    self.assertGreater(wav.getnframes() / wav.getframerate(), 2)
                    return wav.readframes(wav.getnframes())

            blend = ["--voice", "bm_fable", "--blend-voice", "bm_george"]
            # Synthesis varies even for repeated pure-voice requests; check
            # valid audio at both endpoints and the midpoint, not PCM equality.
            for ratio in ["1", "0", "0.5"]:
                self.assertTrue(any(render(*blend, "--blend-ratio", ratio)))
            output.unlink()
            for ratio in ["-1", "1.5", "nan"]:
                result = subprocess.run(command + blend + ["--blend-ratio", ratio],
                                        capture_output=True, timeout=10)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(output.exists())

    def test_adapter_produces_complete_pcm_audio(self):
        with tempfile.TemporaryDirectory() as folder:
            text = Path(folder) / "text.txt"
            audio = Path(folder) / "audio.wav"
            # Long enough to exercise multiple model context windows.
            text.write_text(
                "This is a local speech test. The weather is clear today, and the "
                "project is ready for another careful review. We are checking that "
                "every paragraph makes it into the recording.\n\n" * 5,
                encoding="utf-8",
            )
            command = [
                sys.executable, str(Path(__file__).with_name("kokoro-speech.py")),
                "--text-file", str(text), "--wav-file", str(audio),
            ]
            subprocess.run(command, check=True, capture_output=True, timeout=180)
            with wave.open(str(audio)) as wav:
                self.assertEqual(wav.getframerate(), 24000)
                self.assertEqual(wav.getnchannels(), 1)
                self.assertEqual(wav.getsampwidth(), 2)
                self.assertGreater(wav.getnframes() / wav.getframerate(), 35)
            audio.unlink()
            text.write_text("", encoding="utf-8")
            result = subprocess.run(command, capture_output=True, timeout=10)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(audio.exists())


if __name__ == "__main__":
    unittest.main()
