"""Optional real-model checks; run with the Kokoro virtual environment's Python."""

import importlib.util
from pathlib import Path
import subprocess
import struct
import sys
import tempfile
import unittest
import wave


@unittest.skipUnless(importlib.util.find_spec("kokoro_onnx"), "Kokoro is not installed")
class KokoroSpeechTests(unittest.TestCase):
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
                "--format", "pcm-stream",
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
