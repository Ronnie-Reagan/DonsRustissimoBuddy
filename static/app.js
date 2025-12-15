/**
 * MIDI Engine Pro - Main Application JavaScript (rewritten)
 *
 * - Connects to real backend via WebSocket (/ws)
 * - Handles uploads with POST /upload
 * - Receives "state" and "events" messages and updates UI
 * - Sends actions (play, pause, stop, skip, playlist_add, playlist_remove, set_velocity_multiplier, etc.)
 *
 */

class MIDIEngine {
  constructor() {
    // WebSocket state
    this.ws = null;
    this.wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelayBase = 500; // ms

    // App state mirrors engine.snapshot()
    this.state = {
      playlist: [],
      currentIndex: -1,
      playing: false,
      velocity_multiplier: 1.0,
      glissando: false,
      channel_gains: {},
      recent_events: [],
      // local-only
      playbackMode: 'single',
      masterVolume: 0.8,
      current_elapsed: 0,
      current_duration: 0
    };

    // Progress simulation
    this.progressInterval = null;
    this.simulatedProgress = 0;
    this.simulatedDuration = 180;

    // UI options
    this.autoScrollLog = true;
    this.lastEventTs = 0;
    this.pendingMessages = [];
    this.heartbeatTimer = null;

    // Confirm modal callback
    this.pendingConfirmAction = null;

    // Initialize
    this.initializeUI();
    this.attachEventListeners();
    this.initializeChannelMixer();
    this.connect();
  }

  /* -----------------------
     Initialization & UI
     ----------------------- */

  initializeUI() {
    const savedTheme = localStorage.getItem('midi-theme') || 'dark';
    this.setTheme(savedTheme);
    this.updateConnectionStatus('disconnected');
    this.updatePlaybackControls();
    this.updateVelocitySlider();
    this.updateMasterVolume();
    this.addLogEntry('SYSTEM', 'Application started');
  }

  attachEventListeners() {
    // Theme buttons

    document.querySelectorAll('.theme-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const theme = e.currentTarget.dataset.theme;
        if (theme) this.setTheme(theme);
      });
    });

    // File upload area + input
    const fileInput = document.getElementById('file-input');
    const fileUploadArea = document.getElementById('file-upload');
    const uploadBtn = document.querySelector('.upload-btn');

    if (uploadBtn) uploadBtn.addEventListener('click', () => fileInput?.click());
    if (fileUploadArea) {
      fileUploadArea.addEventListener('click', (e) => {
        if (!e.target.closest('.upload-btn')) fileInput?.click();
      });

      fileUploadArea.addEventListener('dragover', (e) => {
        e.preventDefault();
        fileUploadArea.classList.add('dragover');
      });
      fileUploadArea.addEventListener('dragleave', (e) => {
        e.preventDefault();
        fileUploadArea.classList.remove('dragover');
      });
      fileUploadArea.addEventListener('drop', (e) => {
        e.preventDefault();
        fileUploadArea.classList.remove('dragover');
        if (e.dataTransfer?.files?.length) this.handleFileSelect(e.dataTransfer.files);
      });
    }

    if (fileInput) {
      fileInput.addEventListener('change', (e) => {
        if (e.target.files && e.target.files.length) {
          this.handleFileSelect(e.target.files);
          e.target.value = '';
        }
      });
    }

    // Transport controls
    this.$('play-pause-btn')?.addEventListener('click', () => this.togglePlayPause());
    this.$('stop-btn')?.addEventListener('click', () => this.stop());
    this.$('prev-btn')?.addEventListener('click', () => this.previousTrack());
    this.$('next-btn')?.addEventListener('click', () => this.nextTrack());
    this.$('skip-btn')?.addEventListener('click', () => this.skip());

    // Sliders & toggles
    this.$('velocity-slider')?.addEventListener('input', (e) => this.setVelocityMultiplier(parseFloat(e.target.value)));
    this.$('gliss-toggle')?.addEventListener('change', (e) => this.toggleGlissando(e.target.checked));
    this.$('playback-mode')?.addEventListener('change', (e) => {
      this.state.playbackMode = e.target.value;
      this.addLogEntry('SYSTEM', `Playback mode: ${e.target.value}`);
    });
    this.$('master-volume')?.addEventListener('input', (e) => {
      this.state.masterVolume = parseFloat(e.target.value);
      this.updateMasterVolume();
    });

    // Panel controls
    this.$('clear-playlist')?.addEventListener('click', () => {
      this.showConfirmDialog('Clear Playlist', 'Remove all tracks?', () => this.clearPlaylist());
    });
    this.$('clear-log')?.addEventListener('click', () => this.clearEventLog());
    this.$('toggle-auto-scroll')?.addEventListener('click', () => this.toggleAutoScroll());
    this.$('reset-mixer')?.addEventListener('click', () => this.resetChannelMixer());

    // Playlist click delegation (play/select/remove)
    document.getElementById('playlist')?.addEventListener('click', (e) => {
      const item = e.target.closest('.playlist-item');
      if (!item) return;
      const index = parseInt(item.dataset.index);
      if (e.target.closest('.track-action-btn')) {
        // Decide which action based on data-action if present
        const action = e.target.dataset.action;
        if (action === 'remove') this.removeFromPlaylist(index);
        else this.playTrack(index);
      } else {
        this.selectTrack(index);
      }
    });

    // Context menu
    document.addEventListener('click', () => this.hideContextMenu());
    document.addEventListener('contextmenu', (e) => {
      const playlistItem = e.target.closest('.playlist-item');
      if (playlistItem) {
        e.preventDefault();
        this.showContextMenu(e.pageX, e.pageY, playlistItem);
      }
    });

    // Modal
    this.$('modal-cancel')?.addEventListener('click', () => this.hideModal());
    this.$('modal-confirm')?.addEventListener('click', () => this.confirmModalAction());
    document.querySelectorAll('.modal-backdrop').forEach(b => b.addEventListener('click', () => this.hideModal()));

    // Keyboard
    document.addEventListener('keydown', (e) => this.handleKeyboardShortcuts(e));

    // Toast container exists
    if (!document.getElementById('toast-container')) {
      const tc = document.createElement('div');
      tc.id = 'toast-container';
      document.body.appendChild(tc);
    }
  }
  setTheme(theme) {
    // Remove any existing theme attribute
    document.documentElement.removeAttribute('data-theme');
    // Force reflow
    document.documentElement.offsetHeight;
    // Set new theme
    document.documentElement.setAttribute('data-theme', theme);

    // Update active button
    document.querySelectorAll('.theme-btn').forEach(btn => {
      btn.classList.remove('active');
      if (btn.dataset.theme === theme) btn.classList.add('active');
    });

    localStorage.setItem('midi-theme', theme);
    this.addLogEntry('SYSTEM', `Theme changed to: ${theme}`);
    this.showToast(`Theme switched to ${theme} mode`, 'info');
  }
  updateConnectionStatus(status) {
    const statusElement = document.getElementById('connection-status');
    if (statusElement) {
      const dot = statusElement.querySelector('.status-dot');
      const text = statusElement.querySelector('span');
      if (dot) dot.className = `status-dot ${status}`;
      if (text) text.textContent = status.charAt(0).toUpperCase() + status.slice(1);
    }
    const online = status === 'connected';
    this.setControlsEnabled(online);
  }
  /* -----------------------
     WebSocket connection
     ----------------------- */

  connect() {
    this.updateConnectionStatus('connecting');
    this.addLogEntry('SYSTEM', `Connecting to ${this.wsUrl}...`);

    try {
      this.ws = new WebSocket(this.wsUrl);
    } catch (err) {
      this.scheduleReconnect();
      return;
    }

    this.ws.addEventListener('open', () => {
      this.isConnected = true;
      this.reconnectAttempts = 0;
      this.updateConnectionStatus('connected');
      this.addLogEntry('WEBSOCKET', 'WebSocket connected');
      this.startHeartbeat();
      this.flushPending();
      // request initial state by waiting for server to send it (server sends on connect)
    });

    this.ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        this.handleIncomingMessage(msg);
      } catch (err) {
        this.addLogEntry('ERROR', `Malformed WS message: ${err}`);
      }
    });

    this.ws.addEventListener('close', () => {
      this.isConnected = false;
      this.updateConnectionStatus('disconnected');
      this.addLogEntry('WEBSOCKET', 'WebSocket closed');
       this.stopHeartbeat();
      this.scheduleReconnect();
    });

    this.ws.addEventListener('error', (err) => {
      this.addLogEntry('ERROR', `WebSocket error`);
      // close triggers reconnect
    });
  }

  scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.addLogEntry('WEBSOCKET', 'Max reconnect attempts reached');
      return;
    }
    this.reconnectAttempts++;
    const delay = this.reconnectDelayBase * Math.pow(1.5, this.reconnectAttempts - 1);
    this.updateConnectionStatus('connecting');
    this.addLogEntry('WEBSOCKET', `Reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts})`);
    setTimeout(() => this.connect(), delay);
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.sendMessage('noop', {});
    }, 10000);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  flushPending() {
    const queued = [...this.pendingMessages];
    this.pendingMessages = [];
    queued.forEach(({ type, payload }) => this.sendMessage(type, payload));
  }

  setControlsEnabled(enabled) {
    const selectors = [
      '#play-pause-btn', '#stop-btn', '#prev-btn', '#next-btn', '#skip-btn',
      '#velocity-slider', '#gliss-toggle', '#playback-mode',
      '#master-volume', '#clear-playlist', '#reset-mixer',
      '#file-input', '.upload-btn', '#file-upload'
    ];
    selectors.forEach(sel => {
      document.querySelectorAll(sel).forEach(el => {
        el.disabled = !enabled;
        if (!enabled) el.classList.add('disabled');
        else el.classList.remove('disabled');
      });
    });
  }

  sendMessage(type, payload = {}) {
    const msg = { type, payload };
    if (this.isConnected && this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(msg));
        if (type !== 'noop') this.addLogEntry('WEBSOCKET', `Sent: ${type}`);
      } catch (err) {
        this.addLogEntry('ERROR', `Failed to send ${type}: ${err}`);
      }
    } else {
      // queue for retry on reconnect (bounded)
      if (this.pendingMessages.length > 50) this.pendingMessages.shift();
      this.pendingMessages.push(msg);
      if (type !== 'noop') this.addLogEntry('WEBSOCKET', `Queued: ${type} (offline)`);
    }
  }

  handleIncomingMessage(msg) {
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case 'state':
        // payload is engine.snapshot()
        this.applyState(msg.payload);
        break;
      case 'events':
        this.appendEvents(msg.payload || []);
        break;
      case 'error':
        this.addLogEntry('ERROR', msg.payload || 'Unknown error');
        this.showToast(msg.payload || 'Error', 'error');
        break;
      default:
        this.addLogEntry('WEBSOCKET', `Unknown message type: ${msg.type}`);
    }
  }

  /* -----------------------
     State handling & UI updates
     ----------------------- */

  applyState(payload = {}) {
    try {
      // Merge important fields into local state
      this.state.playlist = Array.isArray(payload.playlist)
        ? payload.playlist.map((p, i) => ({
            name: String(p?.name ?? 'Unknown'),
            duration: Number(p?.duration) || 0,
            index: i,
            path: String(p?.path ?? '')
          }))
        : [];
        
    } catch (err) {
      console.error("applyState playlist parse error", err, payload.playlist);
      this.state.playlist = [];
    }

    this.state.currentIndex = typeof payload.current_index === 'number' ? payload.current_index : this.state.currentIndex;
    this.state.playing = Boolean(payload.playing ?? this.state.playing);
    this.state.velocity_multiplier = payload.velocity_multiplier ?? this.state.velocity_multiplier;
    this.state.glissando = payload.glissando ?? this.state.glissando;
    this.state.channel_gains = payload.channel_gains ?? this.state.channel_gains;
    this.state.recent_events = payload.recent_events ?? this.state.recent_events;
    this.state.current_elapsed = payload.current_elapsed ?? 0;
    this.state.current_duration = payload.current_duration ?? 0;

    // Update UI
    this.renderPlaylist();
    this.updatePlaybackControls();
    this.updateVelocitySlider();
    this.updateCurrentTrackInfo();
    this.syncChannelMixer();
    this.updateActiveChannels();
    // Keep progress UI in sync with server play state
    this.simulatedProgress = this.state.current_elapsed || 0;
    this.simulatedDuration = this.state.current_duration || this.simulatedDuration;
    this.updateProgress();
  }

  appendEvents(events = []) {
    if (!Array.isArray(events)) return;
    events.forEach(ev => {
      const ts = Number(ev.t || Date.now());
      if (ts <= this.lastEventTs) return;
      this.lastEventTs = ts;
      const type = (ev.type || 'event').toUpperCase();
      const msg = ev.msg || ev.payload || JSON.stringify(ev);
      this.addLogEntry(type, msg);
    });
  }

  /* -----------------------
     Playlist UI & actions
     ----------------------- */

  handleFileSelect(files) {
    const valid = [];
    const invalid = [];
    Array.from(files).forEach(f => {
      if (f.name.match(/\.(mid|midi)$/i)) valid.push(f);
      else invalid.push(f.name);
    });

    if (invalid.length) this.showToast(`Skipped ${invalid.length} non-MIDI files`, 'warning');

    if (valid.length) {
      // Upload to server
      this.uploadFiles(valid);
    } else {
      this.addLogEntry('SYSTEM', 'No valid MIDI files to upload');
    }
  }

  async uploadFiles(files) {
    const fd = new FormData();
    files.forEach(f => fd.append('files', f, f.name));

    try {
      this.showToast('Uploading...', 'info');
      const res = await fetch('/upload', { method: 'POST', body: fd });
      if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
      const data = await res.json();
      this.addLogEntry('UPLOAD', `Uploaded: ${data.added?.length ?? 0}`);
      // Server will broadcast an updated state; but to be responsive, request sync
      this.sendMessage('noop', {}); // optional ping — server will ignore unknown types but still useful
      this.showToast(`Added ${data.added?.length ?? 0} files`, 'success');
    } catch (err) {
      this.addLogEntry('ERROR', `Upload error: ${err}`);
      this.showToast('Upload failed', 'error');
    }
  }

  renderPlaylist() {
    const playlistEl = document.getElementById('playlist');
    const empty = document.getElementById('empty-state');
    if (!playlistEl) return;

    if (!this.state.playlist.length) {
      empty?.classList.remove('hidden');
      playlistEl.innerHTML = '';
      return;
    }
    empty?.classList.add('hidden');

    playlistEl.innerHTML = this.state.playlist.map((track, idx) => {
      const active = idx === this.state.currentIndex;
      const playing = this.state.playing && active;
      return `
        <div class="playlist-item ${active ? 'active' : ''} ${playing ? 'playing' : ''}" data-index="${idx}">
          <div class="track-number">${idx + 1}</div>
          <div class="track-info">
            <div class="track-name">${this.escapeHtml(track.name || 'Unknown')}</div>
            <div class="track-duration">${this.formatTime(track.duration || 0)}</div>
          </div>
          <div class="track-actions">
            <button class="track-action-btn" data-action="play" title="Play">▶️</button>
            <button class="track-action-btn" data-action="remove" title="Remove">🗑️</button>
          </div>
        </div>
      `;
    }).join('');

    // wire action buttons (delegation covers clicks)
  }

  selectTrack(index) {
    index = parseInt(index);
    if (isNaN(index)) return;
    if (index < 0 || index >= this.state.playlist.length) return;
    this.state.currentIndex = index;
    this.renderPlaylist();
    this.updateCurrentTrackInfo();
    this.addLogEntry('PLAYLIST', `Selected ${this.state.playlist[index].name}`);
  }

  playTrack(index) {
    this.selectTrack(index);
    this.play();
  }

  removeFromPlaylist(index) {
    index = parseInt(index);
    if (isNaN(index)) return;
    const track = this.state.playlist[index];
    if (!track) return;
    this.showConfirmDialog('Remove Track', `Remove "${track.name}"?`, () => {
      this.sendMessage('playlist_remove', { index });
      // UI will be updated when server broadcasts new state; we can also optimistically remove:
      this.state.playlist.splice(index, 1);
      if (this.state.currentIndex === index) {
        this.state.currentIndex = -1;
        this.stop();
      } else if (index < this.state.currentIndex) {
        this.state.currentIndex--;
      }
      this.renderPlaylist();
      this.updateCurrentTrackInfo();
      this.addLogEntry('PLAYLIST', `Removed ${track.name}`);
      this.showToast(`Removed ${track.name}`, 'info');
    });
  }

  clearPlaylist() {
    this.showToast('Clearing playlist...', 'info');
    this.sendMessage('playlist_clear', {});
    this.state.playlist = [];
    this.state.currentIndex = -1;
    this.stop();
    this.renderPlaylist();
    this.updateCurrentTrackInfo();
    this.addLogEntry('PLAYLIST', 'Playlist cleared');
  }

  /* -----------------------
     Playback controls
     ----------------------- */

  togglePlayPause() {
    if (this.state.playing) this.pause();
    else this.play();
  }

  play() {
    if (!this.state.playlist.length) {
      this.showToast('Playlist is empty', 'warning');
      return;
    }
    if (this.state.currentIndex === -1) this.state.currentIndex = 0;

    this.state.playing = true;
    this.simulatedProgress = 0;
    this.simulatedDuration = this.state.playlist?.[this.state.currentIndex]?.duration || this.simulatedDuration;
    this.updatePlaybackControls();
    this.renderPlaylist();
    this.updateCurrentTrackInfo();

    const idx = this.state.currentIndex;
    this.addLogEntry('PLAYBACK', `Playing: ${this.state.playlist[idx].name}`);
    this.sendMessage('play', { index: idx });
  }

  pause() {
    this.state.playing = false;
    this.updatePlaybackControls();
    this.renderPlaylist();
    this.stopProgressSimulation();
    this.addLogEntry('PLAYBACK', 'Paused');
    this.sendMessage('pause', {});
  }

  stop() {
    this.state.playing = false;
    this.simulatedProgress = 0;
    this.updatePlaybackControls();
    this.renderPlaylist();
    this.updateProgress();
    this.addLogEntry('PLAYBACK', 'Stopped');
    this.sendMessage('stop', {});
  }

  skip() {
    this.addLogEntry('PLAYBACK', 'Skip requested');
    this.sendMessage('skip', {});
    this.nextTrack();
  }

  previousTrack() {
    if (this.state.currentIndex > 0) {
      this.selectTrack(this.state.currentIndex - 1);
      if (this.state.playing) this.play();
    }
  }

  nextTrack() {
    if (this.state.currentIndex < this.state.playlist.length - 1) {
      this.selectTrack(this.state.currentIndex + 1);
      if (this.state.playing) this.play();
    } else if (this.state.playbackMode === 'repeat-all') {
      this.selectTrack(0);
      if (this.state.playing) this.play();
    } else {
      this.stop();
    }
  }

  /* -----------------------
     Progress simulation
     ----------------------- */

  startProgressSimulation() {
    // No interval; progress is driven by server-reported elapsed/duration
    this.stopProgressSimulation();
    this.updateProgress();
  }

  stopProgressSimulation() {
    if (this.progressInterval) {
      clearInterval(this.progressInterval);
      this.progressInterval = null;
    }
  }

  updateProgress() {
    const fill = document.getElementById('progress-fill');
    const cur = document.getElementById('current-time');
    const tot = document.getElementById('total-time');
    if (!fill || !cur || !tot) return;
    const percent = (this.simulatedProgress / Math.max(1, this.simulatedDuration)) * 100;
    fill.style.width = `${Math.min(percent, 100)}%`;
    cur.textContent = this.formatTime(this.simulatedProgress);
    tot.textContent = this.formatTime(this.simulatedDuration);
  }

  updatePlaybackControls() {
    const btn = document.getElementById('play-pause-btn');
    const stateEl = document.getElementById('system-state');
    if (btn) {
      btn.textContent = this.state.playing ? '⏸️' : '▶️';
      btn.title = this.state.playing ? 'Pause' : 'Play';
    }
    if (stateEl) stateEl.textContent = this.state.playing ? 'Playing' : 'Stopped';
  }

  updateCurrentTrackInfo() {
    const title = document.getElementById('current-track');
    const meta = document.getElementById('track-meta');
    if (!title || !meta) return;
    if (this.state.currentIndex >= 0 && this.state.playlist[this.state.currentIndex]) {
      const t = this.state.playlist[this.state.currentIndex];
      title.textContent = t.name;
      meta.textContent = `Track ${this.state.currentIndex + 1} of ${this.state.playlist.length}`;
      // sync simulated duration
      this.simulatedDuration = t.duration || this.simulatedDuration;
    } else {
      title.textContent = 'No track selected';
      meta.textContent = 'Select a track to play';
    }
  }

  /* -----------------------
     Audio / mixer controls
     ----------------------- */

  setVelocityMultiplier(value) {
    this.state.velocity_multiplier = value;
    this.updateVelocitySlider();
    this.addLogEntry('AUDIO', `Velocity set to ${value}`);
    this.sendMessage('set_velocity_multiplier', { value });
  }

  updateVelocitySlider() {
    const slider = this.$('velocity-slider');
    const display = this.$('velocity-value');
    if (slider) slider.value = this.state.velocity_multiplier;
    if (display) display.textContent = Number(this.state.velocity_multiplier).toFixed(1);
  }

  toggleGlissando(enabled) {
    this.state.glissando = enabled;
    this.addLogEntry('AUDIO', `Glissando ${enabled ? 'on' : 'off'}`);
    this.sendMessage('toggle_gliss', { value: !!enabled });
  }

  updateMasterVolume() {
    const s = this.$('master-volume');
    const v = this.$('master-volume-value');
    if (s) s.value = this.state.masterVolume;
    if (v) v.textContent = Number(this.state.masterVolume).toFixed(2);
  }

  initializeChannelMixer() {
    const grid = document.getElementById('channels-grid');
    if (!grid) return;
    grid.innerHTML = '';
    for (let i = 0; i < 16; i++) {
        this.state.channel_gains[i] = this.state.channel_gains[i] ?? 1.0;
        const div = document.createElement('div');
        div.className = 'channel-control';
        div.innerHTML = `
        <div class="channel-label">CH${i + 1}</div>
        <input type="range" class="channel-slider" min="0" max="2" step="0.05" value="${this.state.channel_gains[i]}" data-channel="${i}">
        <div class="channel-value">${Number(this.state.channel_gains[i]).toFixed(1)}</div>
      `;
      // wire slider
      const slider = div.querySelector('.channel-slider');
      const value = div.querySelector('.channel-value');
      slider.addEventListener('input', (e) => {
        const ch = parseInt(e.target.dataset.channel);
        const gain = parseFloat(e.target.value);
        this.setChannelGain(ch, gain);
        value.textContent = Number(gain).toFixed(1);
      });
      grid.appendChild(div);
    }
    this.updateActiveChannels();
  }

  syncChannelMixer() {
    document.querySelectorAll('.channel-slider').forEach((s) => {
      const ch = parseInt(s.dataset.channel);
      const gain = this.state.channel_gains?.[ch] ?? 1.0;
      s.value = gain;
      const val = s.parentElement.querySelector('.channel-value');
      if (val) val.textContent = Number(gain).toFixed(1);
    });
  }

  setChannelGain(channel, gain) {
    this.state.channel_gains[channel] = gain;
    this.addLogEntry('MIXER', `Channel ${channel + 1} -> ${gain.toFixed(2)}`);
    this.sendMessage('set_channel_gain', { channel, gain });
    this.updateActiveChannels();
  }

  resetChannelMixer() {
    for (let i = 0; i < 16; i++) {
      this.state.channel_gains[i] = 1.0;
    }
    document.querySelectorAll('.channel-slider').forEach((s, idx) => {
      s.value = 1.0;
      const val = s.parentElement.querySelector('.channel-value');
      if (val) val.textContent = '1.0';
    });
    this.addLogEntry('MIXER', 'Mixer reset');
    this.showToast('Mixer reset', 'info');
    this.sendMessage('reset_mixer', {});
    this.updateActiveChannels();
  }

  updateActiveChannels() {
    const active = Object.values(this.state.channel_gains).filter(g => g > 0).length;
    const el = document.getElementById('active-channels');
    if (el) el.textContent = active;
  }

  /* -----------------------
     Events, logs, UI helpers
     ----------------------- */

  addLogEntry(type, message) {
    const log = document.getElementById('event-log');
    if (!log) return;
    const ts = new Date().toLocaleTimeString();
    const item = document.createElement('div');
    item.className = 'event-item';
    item.innerHTML = `
      <span class="event-time">${ts}</span>
      <span class="event-type ${type.toLowerCase()}">[${this.escapeHtml(type)}]</span>
      <span class="event-message">${this.escapeHtml(typeof message === 'string' ? message : JSON.stringify(message))}</span>
    `;
    log.appendChild(item);
    // limit
    while (log.children.length > 200) log.removeChild(log.firstChild);
    if (this.autoScrollLog) log.scrollTop = log.scrollHeight;
  }

  clearEventLog() {
    const log = document.getElementById('event-log');
    if (log) log.innerHTML = '';
    this.lastEventTs = Date.now();
    this.addLogEntry('SYSTEM', 'Cleared log');
  }

  toggleAutoScroll() {
    this.autoScrollLog = !this.autoScrollLog;
    const text = document.getElementById('auto-scroll-text');
    if (text) text.textContent = `Auto-scroll: ${this.autoScrollLog ? 'ON' : 'OFF'}`;
    this.addLogEntry('SYSTEM', `Auto-scroll ${this.autoScrollLog ? 'enabled' : 'disabled'}`);
  }

  showToast(message, type = 'info', ms = 3000) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => { toast.remove(); }, ms);
  }

  showContextMenu(x, y, playlistItem) {
    const menu = document.getElementById('context-menu');
    if (!menu) return;
    const index = parseInt(playlistItem.dataset.index);
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    menu.classList.remove('hidden');
    menu.dataset.targetIndex = index;
    menu.querySelectorAll('.context-item').forEach(ci => {
      ci.onclick = (e) => {
        const action = e.currentTarget.dataset.action;
        this.handleContextAction(action, index);
        this.hideContextMenu();
      };
    });
  }

  hideContextMenu() {
    const menu = document.getElementById('context-menu');
    if (menu) menu.classList.add('hidden');
  }

  handleContextAction(action, index) {
    switch (action) {
      case 'play': this.playTrack(index); break;
      case 'remove': this.removeFromPlaylist(index); break;
      case 'move-up': if (index > 0) this.moveTrack(index, index - 1); break;
      case 'move-down': if (index < this.state.playlist.length - 1) this.moveTrack(index, index + 1); break;
    }
  }

  moveTrack(from, to) {
    const t = this.state.playlist.splice(from, 1)[0];
    this.state.playlist.splice(to, 0, t);
    if (from === this.state.currentIndex) this.state.currentIndex = to;
    else if (from < this.state.currentIndex && to >= this.state.currentIndex) this.state.currentIndex--;
    else if (from > this.state.currentIndex && to <= this.state.currentIndex) this.state.currentIndex++;
    this.renderPlaylist();
    this.addLogEntry('PLAYLIST', `Moved ${t.name} to ${to + 1}`);
    // Optionally inform backend
    this.sendMessage('playlist_move', { from, to });
  }

  showConfirmDialog(title, message, onConfirm) {
    const modal = document.getElementById('confirm-modal');
    if (!modal) return;
    this.$('modal-title').textContent = title;
    this.$('modal-message').textContent = message;
    modal.classList.remove('hidden');
    this.pendingConfirmAction = onConfirm;
  }

  hideModal() {
    const modal = document.getElementById('confirm-modal');
    if (!modal) return;
    modal.classList.add('hidden');
    this.pendingConfirmAction = null;
  }

  confirmModalAction() {
    if (typeof this.pendingConfirmAction === 'function') this.pendingConfirmAction();
    this.hideModal();
  }

  handleKeyboardShortcuts(e) {
    if (e.target.matches('input, textarea, select')) return;
    switch (e.code) {
      case 'Space': e.preventDefault(); this.togglePlayPause(); break;
      case 'ArrowLeft': e.preventDefault(); this.previousTrack(); break;
      case 'ArrowRight': e.preventDefault(); this.nextTrack(); break;
      case 'Escape': this.hideContextMenu(); this.hideModal(); break;
    }
  }

  /* -----------------------
     Utilities
     ----------------------- */

  $(id) { return document.getElementById(id); }

  escapeHtml(s) {
    if (typeof s !== 'string') return s;
    return s.replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }

  formatTime(seconds = 0) {
    seconds = Math.floor(seconds);
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  getRandomDuration() {
    const mins = Math.floor(Math.random() * 4) + 1;
    const secs = Math.floor(Math.random() * 60);
    return mins * 60 + secs;
  }

}

/* Initialize app on DOM ready */
let app = null;
document.addEventListener('DOMContentLoaded', () => {
  app = new MIDIEngine();
  window.app = {
    playTrack: (i) => app?.playTrack(i),
    removeFromPlaylist: (i) => app?.removeFromPlaylist(i)
  };
});
