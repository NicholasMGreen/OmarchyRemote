/* Shared audio capture; host adapters return text, never terminal keystrokes. */
(() => {
  const { node, button } = HyprlandUtil;
  let active = null;
  class Voice {
    constructor(dictation, root) {
      this.dictation = dictation;
      this.epoch = 0;
      this.player = new Audio();
      this.player.preload = 'auto';
      this.row = node('div', 'herdr-voice-controls');
      this.toggleButton = button('Voice', () => this.toggle(), 'keycap small');
      this.toggleButton.setAttribute('aria-label', 'Voice mode');
      this.toggleButton.setAttribute('aria-pressed', 'false');
      this.replay = button('Read last', () => this.readLast(), 'keycap small');
      this.stop = button('Stop', () => this.stopPlayback(), 'keycap small');
      this.stop.setAttribute('aria-label', 'Stop speaking');
      this.stop.hidden = true;
      this.message = node('span', 'remote-status');
      this.message.setAttribute('role', 'status');
      this.row.append(this.toggleButton, this.replay, this.stop, this.message);
      root.append(this.row);
      this.player.onended = () => {
        this.stop.hidden = true;
        this.message.textContent = this.enabled ? 'Ready to talk' : '';
      };
      this.player.onerror = () => {
        this.stop.hidden = true;
        this.message.textContent = 'Audio playback failed. Try Read last.';
      };
    }
    async request(path, options = {}) {
      const response = await fetch(path, {
        ...options,
        headers: { 'X-Hyprland-Client': '1', 'Content-Type': 'application/json' },
        signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(200000)]),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw Error(data.error || 'Voice connection failed.');
      }
      return response;
    }
    path(pane, suffix) {
      return '/api/herdr/panes/' + encodeURIComponent(pane) + '/' + suffix;
    }
    async latest(pane) {
      return (await this.request(this.path(pane, 'response'))).json();
    }
    stopPlayback() {
      ++this.playGeneration;
      this.player.pause();
      this.needsPlay = false;
      this.replay.textContent = 'Read last';
      this.stop.hidden = true;
      if (this.audioURL) URL.revokeObjectURL(this.audioURL);
      this.audioURL = null;
      this.player.removeAttribute('src');
      this.message.textContent = this.enabled ? 'Ready to talk' : '';
    }
    reset() {
      ++this.epoch;
      this.enabled = false;
      this.loading = false;
      this.speaking = false;
      clearTimeout(this.timer);
      this.abort?.abort();
      this.abort = new AbortController();
      this.playGeneration = 0;
      this.stopPlayback();
      this.toggleButton.setAttribute('aria-pressed', 'false');
      this.message.textContent = '';
      this.dictation.syncMicrophone();
    }
    // Prime this audio element during a user gesture. Platforms that still block playback
    // get an explicit Play answer button; never silently drop a completed answer.
    unlock() {
      if (this.player.src) return;
      this.player.src =
        'data:audio/wav;base64,UklGRiYAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQIAAAAAAA==';
      this.player.play().catch(() => {});
    }
    async toggle() {
      if (this.enabled || this.loading) return this.reset();
      this.reset();
      this.unlock();
      const epoch = this.epoch;
      const pane = this.dictation.getTarget();
      if (!pane) return;
      this.loading = true;
      this.message.textContent = 'Checking voice…';
      try {
        const provider = await (await this.request('/api/voice')).json();
        if (!provider.available) throw Error(provider.message);
        const value = await this.latest(pane);
        if (epoch !== this.epoch || pane !== this.dictation.getTarget()) return;
        this.pane = pane;
        this.session = value.session;
        this.seen = value.answer?.id;
        this.enabled = true;
        this.dictation.syncMicrophone();
        this.toggleButton.setAttribute('aria-pressed', 'true');
        this.message.textContent = 'Voice on · recordings send automatically';
        this.poll();
      } catch (e) {
        if (epoch === this.epoch) this.message.textContent = e.message;
      } finally {
        if (epoch === this.epoch) this.loading = false;
      }
    }
    async poll() {
      const epoch = this.epoch;
      try {
        if (!this.enabled || this.pane !== this.dictation.getTarget()) return;
        if (!document.hidden && this.dictation.state === 'idle' && !this.speaking) {
          const value = await this.latest(this.pane);
          if (epoch !== this.epoch || this.dictation.state !== 'idle' || document.hidden) return;
          if (value.session !== this.session) {
            this.reset();
            this.message.textContent = 'Conversation changed. Enable Voice again.';
            return;
          }
          if (!value.working && value.answer?.id && value.answer.id !== this.seen) {
            this.seen = value.answer.id;
            await this.speak(this.pane, value.answer.id);
          }
        }
      } catch (e) {
        if (epoch === this.epoch) this.message.textContent = e.message;
      } finally {
        if (epoch === this.epoch && this.enabled) this.timer = setTimeout(() => this.poll(), 3000);
      }
    }
    recordingStarted() {
      this.stopPlayback();
      this.dictation.input.saveDraft();
      return this.enabled
        ? { epoch: this.epoch, pane: this.pane, draft: this.dictation.input.draft }
        : null;
    }
    async transcribed(context, text, recordingGeneration) {
      const input = this.dictation.input;
      if (
        !context ||
        context.epoch !== this.epoch ||
        !this.enabled ||
        recordingGeneration !== this.dictation.generation
      )
        return;
      if (
        context.pane !== this.dictation.getTarget() ||
        context.draft.trim() ||
        input.draft !== text
      ) {
        this.message.textContent = 'Saved as a draft; review and send when ready.';
        return;
      }
      try {
        const latest = await this.latest(context.pane);
        if (
          context.epoch !== this.epoch ||
          recordingGeneration !== this.dictation.generation ||
          !this.enabled ||
          context.pane !== this.dictation.getTarget()
        )
          return;
        if (
          latest.session !== this.session ||
          latest.can_send !== true ||
          latest.working ||
          input.draft !== text
        ) {
          this.message.textContent =
            'Saved as a draft; the agent is busy or the conversation changed.';
          return;
        }
        // Explicit REST acknowledgement; never retry a send after a lost connection.
        await this.request(this.path(context.pane, 'voice-input'), {
          method: 'POST',
          body: JSON.stringify({ text, session: this.session }),
        });
        if (input.id === context.pane && input.draft === text) {
          input.draft = '';
          input.field.value = '';
          input.storeDraft(context.pane, '');
          input.dismiss();
        }
        if (context.epoch === this.epoch)
          this.message.textContent = 'Sent · waiting for the answer';
      } catch (e) {
        if (context.epoch === this.epoch)
          this.message.textContent =
            'Could not confirm sending. Draft kept; check the thread before retrying.';
      }
    }
    async readLast() {
      if (this.dictation.state !== 'idle') {
        this.message.textContent = 'Finish or cancel dictation before playing an answer.';
        return;
      }
      if (this.needsPlay && this.audioURL && this.player.paused) {
        const epoch = this.epoch;
        const generation = this.playGeneration;
        try {
          await this.player.play();
          if (epoch !== this.epoch || generation !== this.playGeneration) return;
          this.stop.hidden = false;
          this.replay.textContent = 'Read last';
          this.needsPlay = false;
        } catch {
          if (epoch !== this.epoch || generation !== this.playGeneration) return;
          this.message.textContent = 'Playback unavailable. Try again.';
        }
        return;
      }
      this.abort ||= new AbortController();
      this.unlock();
      const epoch = this.epoch;
      const pane = this.dictation.getTarget();
      try {
        const value = await this.latest(pane);
        if (
          epoch !== this.epoch ||
          pane !== this.dictation.getTarget() ||
          this.dictation.state !== 'idle'
        )
          return;
        if (!value.answer?.id) throw Error('No completed response yet.');
        await this.speak(pane, value.answer.id);
      } catch (e) {
        if (epoch === this.epoch) this.message.textContent = e.message;
      }
    }
    async speak(pane, id) {
      this.stopPlayback();
      const epoch = this.epoch;
      const generation = this.playGeneration;
      this.speaking = true;
      this.stop.hidden = false;
      this.message.textContent = 'Generating speech on host…';
      try {
        const response = await this.request(this.path(pane, 'speech'), {
          method: 'POST',
          body: JSON.stringify({ response_id: id }),
        });
        const blob = await response.blob();
        if (
          epoch !== this.epoch ||
          generation !== this.playGeneration ||
          pane !== this.dictation.getTarget()
        )
          return;
        this.audioURL = URL.createObjectURL(blob);
        this.player.src = this.audioURL;
        try {
          await this.player.play();
          if (epoch !== this.epoch || generation !== this.playGeneration) return;
          this.message.textContent = 'Speaking';
        } catch {
          if (epoch !== this.epoch || generation !== this.playGeneration) return;
          this.message.textContent = 'Answer ready · tap Play answer';
          this.replay.textContent = 'Play answer';
          this.needsPlay = true;
          this.stop.hidden = true;
        }
      } catch (e) {
        if (epoch === this.epoch && generation === this.playGeneration) {
          this.message.textContent = e.message + ' Use Read last to retry.';
          this.stop.hidden = true;
        }
      } finally {
        if (epoch === this.epoch) this.speaking = false;
      }
    }
    dispose() {
      this.reset();
      this.row.remove();
    }
  }

  class Dictation {
    constructor(input, getTarget, statusRoot, overlayRoot) {
      this.input = input;
      this.getTarget = getTarget;
      this.state = 'idle';
      this.generation = 0;
      this.button = button('', () => this.toggle(), 'keycap herdr-attach dictation-button');
      this.button.innerHTML =
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/></svg>';
      this.button.onpointerdown = e => e.preventDefault();
      this.floatingButton = button('', () => this.toggle(), 'herdr-voice-microphone');
      this.floatingIcon = node('span', 'herdr-voice-microphone-icon');
      this.floatingIcon.innerHTML = this.button.innerHTML;
      this.floatingCaption = node('span', 'herdr-voice-microphone-caption');
      this.floatingButton.append(this.floatingIcon, this.floatingCaption);
      this.floatingButton.hidden = true;
      this.floatingButton.onpointerdown = e => {
        e.preventDefault();
        e.stopPropagation();
      };
      this.floatingButton.addEventListener('click', e => e.stopPropagation());
      overlayRoot.append(this.floatingButton);
      this.notice = node('div', 'dictation-notice');
      this.label = node('span');
      this.label.setAttribute('role', 'status');
      this.cancelButton = button('Cancel', () => this.cancel(), 'keycap small');
      this.retryButton = button('Retry', () => this.transcribe(), 'keycap small');
      this.notice.append(this.label, this.retryButton, this.cancelButton);
      statusRoot.append(this.notice);
      this.background = () => {
        if (document.hidden && ['starting', 'recording'].includes(this.state)) this.cancel();
      };
      document.addEventListener('visibilitychange', this.background);
      this.voice = new Voice(this, statusRoot);
      this.voice.reset();
      this.paint('idle');
    }
    paint(state, message = '') {
      this.state = state;
      const recording = state === 'recording';
      this.button.setAttribute('aria-label', recording ? 'Stop dictation' : 'Start dictation');
      this.button.title = recording ? 'Stop dictation' : 'Dictate · ⌘⌃X';
      this.button.setAttribute('aria-pressed', String(recording));
      this.button.disabled = ['starting', 'transcribing'].includes(state);
      this.notice.hidden = state === 'idle';
      this.label.textContent = message;
      this.retryButton.hidden = state !== 'error' || !this.audio;
      this.cancelButton.textContent = state === 'error' ? 'Dismiss' : 'Cancel';
      this.syncMicrophone();
    }
    syncMicrophone() {
      const enabled = !!this.voice?.enabled;
      const recording = this.state === 'recording';
      const busy = ['starting', 'transcribing'].includes(this.state);
      this.button.hidden = enabled;
      this.floatingButton.hidden = !enabled;
      this.floatingButton.disabled = busy;
      this.floatingButton.dataset.state = this.state;
      this.floatingButton.setAttribute(
        'aria-label',
        recording ? 'Stop dictation' : 'Start dictation'
      );
      this.floatingButton.setAttribute('aria-pressed', String(recording));
      this.floatingButton.setAttribute('aria-busy', String(busy));
      this.floatingButton.title = recording ? 'Tap to finish recording and send' : 'Tap to talk';
      this.floatingCaption.textContent = recording ? 'Send' : busy ? 'Wait…' : 'Talk';
    }
    async toggle() {
      if (this.state === 'recording') {
        this.stop();
        return;
      }
      if (['starting', 'transcribing'].includes(this.state) || !this.getTarget()) return;
      if (active && active !== this) active.cancel();
      active = this;
      this.target = this.getTarget();
      this.voiceContext = this.voice.recordingStarted();
      this.audio = null;
      const generation = ++this.generation;
      this.paint('starting', 'Opening microphone…');
      try {
        if (
          window.__HYPRLAND_NATIVE_FOCUS__ &&
          window.__OMARCHY_PLATFORM__ !== 'android' &&
          !window.__OMARCHY_DICTATION_CAPTURE__
        ) {
          throw Error('Update the Apple app to build 40 or newer to enable microphone recording.');
        }
        if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder)
          throw Error('Microphone capture is unavailable. Update the native app or use HTTPS.');
        const response = await fetch('/api/dictation', { headers: { 'X-Hyprland-Client': '1' } });
        if (!response.ok) throw Error('Cannot reach host dictation.');
        const provider = await response.json();
        if (!provider.available) throw Error(provider.message);
        if (generation !== this.generation) return;
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (generation !== this.generation) {
          stream.getTracks().forEach(t => t.stop());
          return;
        }
        this.stream = stream;
        const mimeType = [
          'audio/mp4',
          'audio/webm;codecs=opus',
          'audio/webm',
          'audio/ogg;codecs=opus',
        ].find(type => MediaRecorder.isTypeSupported(type));
        this.recorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
        const chunks = [];
        let bytes = 0;
        this.recorder.ondataavailable = e => {
          if (e.data.size) chunks.push(e.data);
          bytes += e.data.size;
          if (bytes > 12 * 1024 * 1024) {
            this.cancel();
            this.paint('error', 'Recording is too large. Try a shorter recording.');
          }
        };
        this.recorder.onerror = () => {
          this.cancel();
          this.paint('error', 'Recording failed. Please try again.');
        };
        this.recorder.onstop = () => {
          if (generation !== this.generation) return;
          this.audio = new Blob(chunks, { type: this.recorder.mimeType });
          this.transcribe();
        };
        this.recorder.start(1000);
        this.paint('recording', 'Recording… Press again to transcribe.');
        // Leave room for recorder timing and container duration rounding on the host.
        this.timer = setTimeout(() => this.stop(), 119000);
      } catch (e) {
        if (generation !== this.generation) return;
        this.release();
        this.paint(
          'error',
          e.name === 'NotAllowedError'
            ? 'Microphone permission was denied. Allow it in device settings and try again.'
            : e.message
        );
      }
    }
    release() {
      clearTimeout(this.timer);
      this.stream?.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
    stop() {
      if (this.recorder?.state === 'recording') this.recorder.stop();
      this.release();
      this.paint('transcribing', 'Transcribing on host…');
    }
    async transcribe() {
      const generation = this.generation;
      this.abort = new AbortController();
      this.paint('transcribing', 'Transcribing on host…');
      try {
        const response = await fetch('/api/dictation', {
          method: 'POST',
          headers: { 'X-Hyprland-Client': '1', 'Content-Type': this.audio.type },
          body: this.audio,
          signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(220000)]),
        });
        const data = await response.json();
        if (!response.ok || typeof data.text !== 'string')
          throw Error(data.error || 'Transcription failed.');
        if (generation !== this.generation) return;
        if (data.text.trim()) {
          this.input.insertDictation(this.target, data.text.trim());
          await this.voice.transcribed(this.voiceContext, data.text.trim(), generation);
        }
        if (generation !== this.generation) return;
        this.audio = null;
        this.paint(data.text.trim() ? 'idle' : 'error', 'No speech detected.');
        if (active === this) active = null;
      } catch (e) {
        if (generation === this.generation)
          this.paint('error', e.message || 'Transcription failed. Retry or dismiss.');
      }
    }
    cancel() {
      ++this.generation;
      this.abort?.abort();
      if (this.recorder?.state === 'recording') this.recorder.stop();
      this.release();
      this.audio = null;
      this.paint('idle');
      if (active === this) active = null;
    }
    get actions() {
      return [
        {
          code: 'KeyX',
          meta: true,
          ctrl: true,
          label: 'Toggle dictation',
          group: 'Herdr',
          run: () => this.toggle(),
        },
      ];
    }
    dispose() {
      this.cancel();
      document.removeEventListener('visibilitychange', this.background);
      this.voice.dispose();
      this.floatingButton.remove();
      this.button.remove();
      this.notice.remove();
    }
  }
  Dictation.settings = host => {
    const section = node('section', 'legend');
    section.append(node('span', 'legend-title', 'dictation'));
    const status = node('p', 'theme-note', 'Checking host transcription…');
    section.append(
      status,
      node(
        'p',
        'theme-note',
        'Herdr: microphone or ⌘⌃X to start/stop. The host administrator can override Voxtype with OMARCHY_DICTATION_COMMAND.'
      )
    );
    host.append(section);
    fetch('/api/dictation', { headers: { 'X-Hyprland-Client': '1' } })
      .then(r => {
        if (!r.ok) throw Error();
        return r.json();
      })
      .then(data => {
        status.textContent = `${data.provider} · ${data.message}`;
      })
      .catch(() => {
        status.textContent = 'Host dictation unavailable.';
      });
  };
  window.HyprlandDictation = Dictation;
})();
