# Dictation

In an open Herdr pane, tap the microphone or press **Command+Control+X** to record;
press again to transcribe. Escape discards the recording. The transcript appends
to that pane's saved draft, preserving edits made while waiting. It never sends
terminal input automatically. Settings shows the connected host's provider status.

## Host setup

Install `voxtype` and `ffmpeg`, then download and select a model with Voxtype's
setup tools. Test `voxtype --quiet transcribe recording.wav` on the host first.
Omarchy Remote uses the host user's Voxtype configuration. The executable is
looked up on PATH, `~/.local/bin`, and `~/.cargo/bin`. The API's Ready status checks
executable availability; a missing model or runtime error is reported on use.

The built-in adapter invokes `voxtype --quiet transcribe <audio.wav>` and removes
its diagnostic preamble. Voxtype 1.1.0 is the reference CLI format. It does not
start the desktop recording daemon or type into a desktop window.

## Another transcription command

Set this in the host's private `~/.config/omarchy-remote/backend.env`, then restart
`omarchy-remote.service` (which ends backend-owned terminal shells):

```sh
OMARCHY_DICTATION_COMMAND='["my-transcriber","--file","{audio}"]'
```

This is a JSON array of executable and arguments, **not a shell command**. The
literal `{audio}` argument is replaced by a private temporary WAV file: 16 kHz,
mono, signed 16-bit PCM. Use an absolute executable path if needed; `~` is not
expanded. Your program must print only UTF-8 transcript text to stdout, put
diagnostics on stderr, and exit nonzero on failure. Empty text means no speech.
The setting is host-only and cannot be changed by an API request. Remove it to
return to Voxtype. Secrets and provider credentials stay on the host.

For xhisperflow builds supporting file transcription:

```sh
OMARCHY_DICTATION_COMMAND='["xhisperflow","--transcribe-file","{audio}"]'
```

That adapter uses xhisperflow's existing configuration, Groq credentials, and
optional cleanup. Audio is sent to Groq in this configuration; local Voxtype
models keep it on the host.

## Recording and limits

The client requires HTTPS (or localhost), microphone permission and MediaRecorder.
The iOS/iPadOS app requires build 40 or newer. It requests permission only for the
trusted shell's microphone; embedded websites do not inherit that grant. Android
and desktop wrappers need their own microphone permission support if unavailable.

Audio uploads use the existing authenticated backend proxy. There is one active
transcription per host, a 12 MiB upload limit, a two-minute recording limit and a
three-minute transcription deadline. Temporary recordings are removed after a
request finishes or fails; transcript text is stored through Herdr's existing
per-thread draft storage. Custom tools can have their own logging policies.
Failed transcription retains audio in client memory for Retry until dismissed or
the view closes. Backgrounding cancels recording. Dictation requires a connection
to the host and does not replace Apple's keyboard microphone globally.

## Voice conversations

Hold the microphone for 550 ms to enable **Voice mode** while still pressing (release does not trigger another action), then tap the headphones button in the bottom bar to turn it off and stop recording or playback. Keyboard users can focus the microphone and press **Shift+Enter**. Voice mode enables a conversation loop using the same microphone:
record, press again to transcribe, send, and listen to the assistant’s initial reply, progress updates, and completed answer.
The host generates one WAV per whole text message; playback stays in order and never interrupts the previous message. **Read** works without
Voice mode; **Stop** stops playback or suppresses an in-flight generation. Starting
a recording also stops playback. If the device blocks automatic audio, **Play
answer** starts the ready recording explicitly.

Voice mode starts from the current conversation position and speaks new assistant text only. It skips existing messages when enabled, reads progress while the agent works, and reads the final answer when the turn completes. Read still replays the latest completed answer. Pending progress belongs to the current turn and is discarded when a new turn or thread replaces it.
Voice mode belongs to the Herdr view, not individual threads. Switching threads (including through the pane list) or changing the underlying agent session keeps Voice enabled but stops playback and leaves automatic readback silent. Read can replay the latest completed answer; sending a new voice message resumes automatic readback for new text. Unsupported threads pause voice with an explanation; selecting a supported thread resumes it. Switching cancels recording and pending transcription without inserting or sending them to either thread. Existing
drafts and edits during transcription leave the transcript in the
composer for manual sending. Busy agents accept voice messages through the same input path as normal Send and manage their own queue; voice does not stop at a busy-agent draft dialog. A failed or uncertain send keeps the draft and is
never automatically retried. Voice mode is opt-in for the current view, not a saved
preference. Normal dictation still never sends automatically.

Progress and completed answers come from local Codex and Claude conversation logs, not terminal
screens. Session identity comes from Herdr when available, otherwise the foreground
Codex process's unique CLI rollout or Claude's PID/session record. For daemon-backed Codex terminals without an open rollout, Voice reads the local session database in read-only mode and requires a unique exact match between the terminal's conversation name and process working directory, then verifies the log's identity. It never picks a conversation merely because it is the newest in a folder. Ambiguous or
unsupported sessions report an error rather than reading another thread. Worker
responses, tool calls/results, and reasoning are excluded. Codex commentary messages and Claude’s persisted assistant text blocks are eligible progress; partial streaming text is excluded. Code fences are announced as omitted;
Markdown links are spoken as their labels. Log formats are agent-version dependent.

The default speech provider is [Piper](https://github.com/OHF-Voice/piper1-gpl):

```sh
uv tool install --python 3.12 piper-tts
# Use the Python in the installed Piper environment:
~/.local/share/uv/tools/piper-tts/bin/python -m piper.download_voices \
  --data-dir ~/.local/share/omarchy-remote/voices en_US-lessac-medium
```

Choose another model with `OMARCHY_SPEECH_MODEL=/absolute/path/voice.onnx`, or set
this host-only override in the backend service environment:

```sh
OMARCHY_SPEECH_COMMAND='["my-speech-adapter","--text-file","{text}","--wav-file","{audio}"]'
```

The JSON array runs directly without a shell. `{text}` is a private UTF-8 file;
`{audio}` is the required output WAV path. Both must be separate arguments.
Credentials and configuration stay on the host. A cloud adapter may send response
text to its provider; Piper runs locally. Restart the backend after changing it.
The adapter has three minutes, one generation runs at a time, and each response is
limited to 64 KiB of speech text and 32 MiB of audio. Temporary files are removed;
up to 64 MiB of generated audio is cached in server memory for Replay and cleared
on restart. Audio is served through the authenticated host API, not a public URL.

This first version runs while the app is foregrounded. It does not promise a
screen-locked conversation loop or background microphone capture.

### Local Kokoro speech

Kokoro is an optional CPU speech provider using the same adapter contract. It
does not change Voxtype dictation or require a new native build. Install its
Python dependencies and model outside the checkout (run from the repository root):

```sh
kokoro_dir="$HOME/.local/share/omarchy-remote/kokoro"
uv venv --python 3.12 "$kokoro_dir/venv"
uv pip install --python "$kokoro_dir/venv/bin/python" \
  'kokoro-onnx==0.6.1' 'soundfile==0.13.1'
mkdir -p "$kokoro_dir/models"
curl -fL --retry 2 -o "$kokoro_dir/models/kokoro-v1.0.onnx" \
  https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/kokoro-v1.0.onnx
curl -fL --retry 2 -o "$kokoro_dir/models/voices-v1.0.bin" \
  https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/voices-v1.0.bin
```

Set `OMARCHY_SPEECH_COMMAND` in the host's private backend environment to a JSON
argument array containing these entries, replacing the two example paths with
absolute paths on your host (environment-variable expansion is not performed):

```sh
OMARCHY_SPEECH_COMMAND='["/absolute/path/to/kokoro/venv/bin/python","/absolute/path/to/OmarchyRemote/scripts/kokoro-speech.py","--text-file","{text}","--wav-file","{audio}","--voice","af_heart"]'
```

Restart `omarchy-remote.service` after updating its environment. This ends its
backend-owned terminal shells. Settings reports **Custom command** for this
adapter; **Read** and Voice mode now use Kokoro. Remove just this override and
restart to return to Piper; leave your dictation configuration unchanged.

The adapter defaults to the American English `af_heart` voice at speed `1.0`.
Use `--voice`, `--speed` (0.5–2.0), and `--language` to customize it. Voices must
match the chosen language; see the [Kokoro voice catalog](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md).
`--model-dir` changes the model location and `--threads` controls CPU inference
(four threads by default). Downloads happen only during setup; generation is
local and produces 24 kHz PCM WAV audio. Each uncached request loads the model
in its own process, so there is no persistent model service or idle memory use.
The backend's existing audio cache avoids regenerating identical readbacks.
