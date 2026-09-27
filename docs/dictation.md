# Dictation

In an open Herdr pane, tap the microphone or press **Command+Control+X** to record;
press again to transcribe. Cancel discards the recording. The transcript appends
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
