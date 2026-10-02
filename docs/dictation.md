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

Hold the microphone to enable **Voice mode**, then tap the headphones button in the bottom bar to turn it off and stop recording or playback. Keyboard users can focus the microphone and press **Shift+Enter**. Voice mode enables a conversation loop using the same microphone:
record, press again to transcribe, send, wait for the completed answer, and listen.
The host generates one WAV for the whole response. **Read** works without
Voice mode; **Stop** stops playback or suppresses an in-flight generation. Starting
a recording also stops playback. If the device blocks automatic audio, **Play
answer** starts the ready recording explicitly.

Voice mode starts from the current answer and speaks new completed answers only.
Switching threads or changing the underlying agent session turns it off. Existing
drafts, edits during transcription, and busy agents leave the transcript in the
composer for manual sending. A failed or uncertain send keeps the draft and is
never automatically retried. Voice mode is opt-in for the current view, not a saved
preference. Normal dictation still never sends automatically.

Completed answers come from local Codex and Claude conversation logs, not terminal
screens. Session identity comes from Herdr when available, otherwise the foreground
Codex process's unique CLI rollout or Claude's PID/session record. Ambiguous or
unsupported sessions report an error rather than reading another thread. Worker
responses, tools, and reasoning are excluded. Code fences are announced as omitted;
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
