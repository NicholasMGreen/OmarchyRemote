"""Optional real-model checks; run with the Kokoro virtual environment's Python."""

import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import wave


@unittest.skipUnless(importlib.util.find_spec("kokoro_onnx"), "Kokoro is not installed")
class KokoroSpeechTests(unittest.TestCase):
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
