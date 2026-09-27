/* Shared audio capture; host adapters return text, never terminal keystrokes. */
(() => {
  const { node, button } = HyprlandUtil;
  let active = null;
  class Dictation {
    constructor(input, getTarget, statusRoot) {
      this.input = input;
      this.getTarget = getTarget;
      this.state = 'idle';
      this.generation = 0;
      this.button = button('', () => this.toggle(), 'keycap herdr-attach dictation-button');
      this.button.innerHTML =
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/></svg>';
      this.button.onpointerdown = e => e.preventDefault();
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
      this.audio = null;
      const generation = ++this.generation;
      this.paint('starting', 'Opening microphone…');
      try {
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
        if (data.text.trim()) this.input.insertDictation(this.target, data.text.trim());
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
