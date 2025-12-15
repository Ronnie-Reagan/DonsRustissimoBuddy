# engine.py
import os
import time
import threading
from typing import Dict, List, Optional, Any

import mido
from mido import MidiFile, Message


def select_midi_output(preferred: Optional[str] = None) -> str:
    ports = mido.get_output_names()
    if not ports:
        raise RuntimeError("No MIDI output devices found")

    if preferred and preferred in ports:
        return preferred

    # deterministic fallback (EXE-safe)
    return ports[0]


class MidiEngine:
    def __init__(self, output_name: Optional[str] = None):
        self.output_name = output_name
        self.output = None  # lazy init

        # state
        self.playlist: List[Dict[str, Any]] = []
        self.current_index = 0
        self.current_mid: Optional[MidiFile] = None
        self.current_elapsed = 0.0
        self.current_duration = 0.0
        self._playlist_store: Optional[str] = None

        # threading
        self._play_thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()
        self._pause_event = threading.Event()
        self._lock = threading.Lock()

        # transforms
        self.velocity_multiplier = 1.0
        self.glissando = False
        self.channel_gains: Dict[int, float] = {}

        # logs
        self._recent_events: List[dict] = []
        self._new_events: List[dict] = []

    # ============================================================
    # MIDI init (EXE-safe)
    # ============================================================

    def _ensure_output(self):
        if self.output is not None:
            return

        try:
            name = select_midi_output(self.output_name)
            self.output = mido.open_output(name)
            self.output_name = name
            self._log_event({"type": "info", "msg": f"MIDI output opened: {name}"})
        except Exception as e:
            self._log_event({"type": "error", "msg": f"MIDI output unavailable: {e}"})
            raise

    # ============================================================
    # Public API
    # ============================================================

    def snapshot(self) -> dict:
        with self._lock:
            return {
                "playlist": list(self.playlist),
                "current_index": self.current_index,
                "playing": self.is_playing(),
                "velocity_multiplier": self.velocity_multiplier,
                "glissando": self.glissando,
                "channel_gains": dict(self.channel_gains),
                "recent_events": list(self._recent_events[-200:]),
                "current_elapsed": self.current_elapsed,
                "current_duration": self.current_duration,
                "paused": self._pause_event.is_set(),
            }

    def add_to_playlist(self, path: str):
        item = self._build_track_entry(path)
        if item:
            self.playlist.append(item)

    def remove_from_playlist(self, idx: int):
        if 0 <= idx < len(self.playlist):
            self.playlist.pop(idx)
            if self.current_index >= len(self.playlist):
                self.current_index = max(0, len(self.playlist) - 1)

    def clear_playlist(self):
        with self._lock:
            self.playlist.clear()
            self.current_index = 0
            self.current_mid = None
        self._log_event({"type": "info", "msg": "playlist cleared"})

    def move_playlist_item(self, src: int, dst: int):
        with self._lock:
            if not (0 <= src < len(self.playlist)) or not (0 <= dst < len(self.playlist)):
                self._log_event({"type": "warning", "msg": f"move failed: {src}->{dst} out of range"})
                return
            item = self.playlist.pop(src)
            self.playlist.insert(dst, item)

    def play_index(self, idx: int):
        if 0 <= idx < len(self.playlist):
            try:
                self._ensure_output()
            except Exception:
                return  # fail soft

            self.current_index = idx
            self.stop()

            self.current_mid = MidiFile(self.playlist[idx]["path"])
            self._stop_event.clear()
            self._pause_event.clear()

            self._play_thread = threading.Thread(
                target=self._play_loop, daemon=True
            )
            self._play_thread.start()

    def pause(self):
        self._pause_event.set()

    def resume(self):
        self._pause_event.clear()

    def stop(self):
        self._stop_event.set()
        if self._play_thread and self._play_thread.is_alive():
            self._play_thread.join(timeout=1)
        self._play_thread = None

    def skip(self):
        if self.current_index + 1 < len(self.playlist):
            self.play_index(self.current_index + 1)

    def set_velocity_multiplier(self, value: float):
        with self._lock:
            self.velocity_multiplier = value

    def set_glissando(self, value: bool):
        with self._lock:
            self.glissando = value

    def set_channel_gain(self, ch: int, gain: float):
        with self._lock:
            self.channel_gains[ch] = gain

    def reset_mixer(self):
        with self._lock:
            self.channel_gains.clear()

    # ============================================================
    # Persistence
    # ============================================================

    def set_playlist_store(self, path: str):
        self._playlist_store = path

    def save_playlist(self):
        if not self._playlist_store:
            return
        try:
            with self._lock:
                paths = [t["path"] for t in self.playlist]
            import json
            with open(self._playlist_store, "w", encoding="utf-8") as f:
                json.dump(paths, f)
        except Exception:
            pass

    def load_playlist(self):
        if not self._playlist_store or not os.path.isfile(self._playlist_store):
            return
        try:
            import json
            with open(self._playlist_store, "r", encoding="utf-8") as f:
                paths = json.load(f)
            for p in paths:
                self.add_to_playlist(p)
        except Exception:
            pass

    # ============================================================
    # Internals
    # ============================================================
    def pop_new_events(self) -> List[dict]:
        with self._lock:
            events = list(self._new_events)
            self._new_events.clear()
            return events

    def is_playing(self) -> bool:
        return (
            self._play_thread is not None
            and self._play_thread.is_alive()
            and not self._pause_event.is_set()
        )

    def _log_event(self, ev: dict):
        entry = {"t": time.time(), **ev}
        self._recent_events.append(entry)
        self._new_events.append(entry)
        self._recent_events[:] = self._recent_events[-1000:]
        self._new_events[:] = self._new_events[-1000:]

    def _build_track_entry(self, path: str) -> Optional[Dict[str, Any]]:
        if not os.path.isfile(path):
            return None
        fname = os.path.basename(path)
        if "_" in fname and len(fname.split("_", 1)[0]) == 32:
            name = fname.split("_", 1)[1]
        else:
            name = fname
        try:
            duration = MidiFile(path).length or 0.0
        except Exception:
            duration = 0.0
        return {"path": path, "name": name, "duration": duration}

    def _transform_note(self, msg: Message) -> List[Message]:
        with self._lock:
            vel_mul = self.velocity_multiplier
            gliss = self.glissando
            gains = dict(self.channel_gains)

        out: List[Message] = []

        if msg.type in ("note_off",) or (msg.type == "note_on" and msg.velocity == 0):
            out.append(Message("note_off", note=msg.note, velocity=0, channel=msg.channel))
            return out

        vel = int(max(1, min(127, msg.velocity * vel_mul * gains.get(msg.channel, 1.0))))

        if not gliss:
            out.append(Message("note_on", note=msg.note, velocity=vel, channel=msg.channel))
            return out

        for n in range(max(0, msg.note - 4), msg.note + 1):
            out.append(Message("note_on", note=n, velocity=vel, channel=msg.channel))
            out.append(Message("note_off", note=n, velocity=0, channel=msg.channel))
        return out

    def _play_loop(self):
        while 0 <= self.current_index < len(self.playlist):
            try:
                mid = self.current_mid
                self.current_duration = mid.length or 0.0
                self.current_elapsed = 0.0

                for msg in mid.play():
                    if self._stop_event.is_set():
                        return
                    while self._pause_event.is_set():
                        time.sleep(0.01)

                    self.current_elapsed += getattr(msg, "time", 0.0) or 0.0

                    if msg.type in ("note_on", "note_off"):
                        for om in self._transform_note(msg):
                            self.output.send(om)
                    else:
                        self.output.send(msg)

            except Exception:
                pass

            self.current_index += 1
            self.current_mid = None
            self.current_elapsed = 0.0
            self.current_duration = 0.0
