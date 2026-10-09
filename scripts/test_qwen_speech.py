"""Qwen adapter checks; real inference is opt-in on a configured GPU host."""

import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import wave

spec = importlib.util.spec_from_file_location(
    "qwen_speech", Path(__file__).with_name("qwen-speech.py")
)
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


class QwenSpeechTests(unittest.TestCase):
    def test_chunking_preserves_words_and_sentence_boundaries(self):
        sentence = "A complete sentence stays together for natural speech."
        text = (sentence + " ") * 30 + "\n\nThe final paragraph must remain intact."
        chunks = list(adapter.paragraphs(text))
        self.assertEqual(" ".join(chunks), " ".join(text.split()))
        self.assertTrue(all(len(chunk) <= 500 for chunk in chunks))
        self.assertTrue(all(chunk.endswith(".") for chunk in chunks))
        self.assertEqual(chunks[-1], "The final paragraph must remain intact.")
        long_word = "x" * 1500
        self.assertEqual("".join(adapter.paragraphs(long_word)), long_word)

    def test_empty_input_does_not_load_model_or_create_audio(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "input.txt"
            output = Path(folder) / "output.wav"
            source.write_text("", encoding="utf-8")
            result = subprocess.run([
                sys.executable, str(Path(__file__).with_name("qwen-speech.py")),
                "--text-file", str(source), "--wav-file", str(output),
            ], capture_output=True, timeout=10)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(b"text must be nonempty", result.stderr)
            self.assertFalse(output.exists())

    @unittest.skipUnless(os.environ.get("OMARCHY_TEST_QWEN") == "1", "GPU inference is opt-in")
    def test_real_model_generates_pcm(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "input.txt"
            output = Path(folder) / "output.wav"
            source.write_text(
                "The changes are ready. Take a moment to listen to the pacing and tone.",
                encoding="utf-8",
            )
            subprocess.run([
                sys.executable, str(Path(__file__).with_name("qwen-speech.py")),
                "--text-file", str(source), "--wav-file", str(output),
            ], check=True, capture_output=True, timeout=180)
            with wave.open(str(output)) as wav:
                self.assertEqual(wav.getframerate(), 24000)
                self.assertEqual(wav.getnchannels(), 1)
                self.assertEqual(wav.getsampwidth(), 2)
                self.assertGreater(wav.getnframes() / wav.getframerate(), 2)


if __name__ == "__main__":
    unittest.main()
