# server.py
import asyncio
import json
import sys
from pathlib import Path
from typing import List
from uuid import uuid4

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File, HTTPException, Request
from contextlib import asynccontextmanager
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
import uvicorn

from engine import MidiEngine
import sys

# ============================================================
# PyInstaller-safe path handling
# ============================================================

def get_exe_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent

def get_bundle_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys._MEIPASS)
    return Path(__file__).resolve().parent

EXE_DIR = get_exe_dir()        # persistent (config, uploads, playlist)
BUNDLE_DIR = get_bundle_dir() # read-only bundled assets (static)

# ============================================================
# Persistent data layout (next to EXE)
# ============================================================

CONFIG_PATH = EXE_DIR / "config.json"

UPLOAD_DIR = EXE_DIR / "uploads"
BACKUP_DIR = EXE_DIR / "uploads_backup"
PLAYLIST_STORE = EXE_DIR / "playlist.json"

UPLOAD_DIR.mkdir(exist_ok=True)
BACKUP_DIR.mkdir(exist_ok=True)

ALLOWED_EXTENSIONS = {".mid", ".midi"}

# ============================================================
# Static assets (bundled via PyInstaller)
# ============================================================

STATIC_DIR = BUNDLE_DIR / "static"

# ============================================================
# Configuration
# ============================================================

DEFAULT_CONFIG = {
    "host": "0.0.0.0",
    "port": 56107,
    "api_key": None,
    "max_upload_mb": 5,
    "midi_output": None
}

def load_or_create_config() -> dict:
    if not CONFIG_PATH.exists():
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(DEFAULT_CONFIG, f, indent=2)
        print(f"[CONFIG] Created default config at {CONFIG_PATH}")
        return DEFAULT_CONFIG.copy()

    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        print(f"[CONFIG] Failed to load config, using defaults: {e}")
        return DEFAULT_CONFIG.copy()

    merged = DEFAULT_CONFIG.copy()
    for k, v in data.items():
        if v is not None:
            merged[k] = v
    return merged

CONFIG = load_or_create_config()

HOST = CONFIG["host"]
PORT = int(CONFIG["port"])
API_KEY = CONFIG.get("api_key")
MAX_UPLOAD_BYTES = int(CONFIG.get("max_upload_mb", 5)) * 1024 * 1024

# ============================================================
# Engine
# ============================================================

def _early_cli_mode() -> None:
    argv = [a.strip() for a in sys.argv[1:]]

    # Debug: verify args are actually arriving
    if "--print-argv" in argv:
        print("ARGV:", sys.argv)
        raise SystemExit(0)

    # List MIDI outputs and exit
    if "--list-midi" in argv:
        try:
            import mido
            outs = mido.get_output_names()
            print("Available MIDI output devices:")
            if not outs:
                print(" (none found)")
            else:
                for name in outs:
                    print(f" - {name}")
        except Exception as e:
            print(f"Failed to list MIDI outputs: {e}")
        raise SystemExit(0)

_early_cli_mode()


ENGINE = MidiEngine(output_name=CONFIG.get("midi_output"))
ENGINE.set_playlist_store(str(PLAYLIST_STORE))

# ============================================================
# FastAPI lifecycle
# ============================================================

@asynccontextmanager
async def lifespan(app: FastAPI):
    tasks = []

    async def preload():
        def _load():
            ENGINE.load_playlist()
            loaded = 0
            for p in sorted(UPLOAD_DIR.glob("*")):
                if p.is_file() and p.suffix.lower() in ALLOWED_EXTENSIONS:
                    ENGINE.add_to_playlist(str(p))
                    loaded += 1
            if loaded:
                ENGINE.append_event("SYSTEM", f"preloaded {loaded} file(s) from uploads/")
        await asyncio.to_thread(_load)

    tasks.append(asyncio.create_task(preload()))
    tasks.append(asyncio.create_task(broadcast_loop()))

    yield

    for t in tasks:
        t.cancel()

# ============================================================
# FastAPI app
# ============================================================

app = FastAPI(lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

# ============================================================
# WebSocket manager
# ============================================================

class ConnectionManager:
    def __init__(self):
        self.active: list[WebSocket] = []

    async def connect(self, ws: WebSocket):
        await ws.accept()
        self.active.append(ws)

    def disconnect(self, ws: WebSocket):
        try:
            self.active.remove(ws)
        except ValueError:
            pass

    async def broadcast(self, data: dict):
        payload = json.dumps(data)
        dead = []
        for ws in list(self.active):
            try:
                await ws.send_text(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws)

manager = ConnectionManager()

# ============================================================
# Routes
# ============================================================

@app.get("/")
async def index():
    return FileResponse(STATIC_DIR / "index.html")

def _verify_api_key(ws: WebSocket) -> bool:
    if not API_KEY:
        return True
    supplied = ws.headers.get("x-api-key") or ws.query_params.get("api_key")
    return supplied == API_KEY

@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    if not _verify_api_key(ws):
        await ws.close(code=4401)
        return

    await manager.connect(ws)
    await ws.send_text(json.dumps({"type": "state", "payload": ENGINE.snapshot()}))

    try:
        while True:
            raw = await ws.receive_text()
            try:
                data = json.loads(raw)
            except Exception:
                await ws.send_text(json.dumps({"type": "error", "payload": "invalid json"}))
                continue
            await handle_message(data)
    except WebSocketDisconnect:
        manager.disconnect(ws)

async def handle_message(data: dict):
    t = data.get("type")
    payload = data.get("payload", {})

    try:
        if t == "play":
            ENGINE.play_index(payload.get("index", ENGINE.current_index))
        elif t == "pause":
            ENGINE.pause()
        elif t == "resume":
            ENGINE.resume()
        elif t == "stop":
            ENGINE.stop()
        elif t == "skip":
            ENGINE.skip()
        elif t == "set_velocity_multiplier":
            ENGINE.set_velocity_multiplier(float(payload.get("value", 1.0)))
        elif t == "toggle_gliss":
            ENGINE.set_glissando(bool(payload.get("value", False)))
        elif t == "playlist_add":
            ENGINE.add_to_playlist(payload.get("file", ""))
        elif t == "playlist_remove":
            ENGINE.remove_from_playlist(int(payload.get("index", 0)))
        elif t == "playlist_clear":
            ENGINE.clear_playlist()
        elif t == "playlist_move":
            ENGINE.move_playlist_item(
                int(payload.get("from", -1)),
                int(payload.get("to", -1))
            )
        elif t == "set_channel_gain":
            ENGINE.set_channel_gain(
                int(payload.get("channel", 0)),
                float(payload.get("gain", 1.0))
            )
        elif t == "reset_mixer":
            ENGINE.reset_mixer()

        ENGINE.save_playlist()
        await manager.broadcast({"type": "state", "payload": ENGINE.snapshot()})

        events = ENGINE.pop_new_events()
        if events:
            await manager.broadcast({"type": "events", "payload": events})

    except Exception as exc:
        await manager.broadcast({"type": "error", "payload": str(exc)})

# ============================================================
# Upload endpoint
# ============================================================

@app.post("/upload")
async def upload(request: Request, files: List[UploadFile] = File(...)):
    if API_KEY:
        supplied = request.headers.get("x-api-key")
        if supplied != API_KEY:
            raise HTTPException(status_code=401, detail="API key required")

    saved = []

    for f in files:
        raw = await f.read()
        ext = Path(f.filename).suffix.lower()

        if ext not in ALLOWED_EXTENSIONS:
            raise HTTPException(status_code=400, detail="Unsupported file type")

        if len(raw) > MAX_UPLOAD_BYTES:
            raise HTTPException(status_code=400, detail="File too large")

        safe_name = f"{uuid4().hex}_{Path(f.filename).name}"
        path = UPLOAD_DIR / safe_name
        path.write_bytes(raw)

        try:
            (BACKUP_DIR / safe_name).write_bytes(raw)
        except Exception:
            pass

        ENGINE.add_to_playlist(str(path))
        saved.append(safe_name)

    ENGINE.save_playlist()
    ENGINE.append_event("UPLOAD", f"added {len(saved)} file(s)")

    await manager.broadcast({"type": "state", "payload": ENGINE.snapshot()})
    events = ENGINE.pop_new_events()
    if events:
        await manager.broadcast({"type": "events", "payload": events})

    return {"added": saved}

# ============================================================
# Background broadcaster
# ============================================================

async def broadcast_loop():
    while True:
        await asyncio.sleep(1.0)
        events = ENGINE.pop_new_events()
        if events:
            await manager.broadcast({"type": "events", "payload": events})
        await manager.broadcast({"type": "state", "payload": ENGINE.snapshot()})

# ============================================================
# Entrypoint
# ============================================================

if __name__ == "__main__":
    print(f"[SERVER] Starting on {HOST}:{PORT}")
    uvicorn.run(app, host=HOST, port=PORT)
