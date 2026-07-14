from __future__ import annotations

import json
import ctypes
import hashlib
import os
import shutil
import sys
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

import serial
from serial.tools import list_ports
import webview
from webview.window import FixPoint


ROOT = Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else Path(__file__).resolve().parent
RESOURCE_ROOT = Path(getattr(sys, "_MEIPASS", ROOT))
ICON_FILE = RESOURCE_ROOT / ("icon.ico" if sys.platform == "win32" else "icon.png")
DATA_DIR = ROOT / "data" / "PortWaver"
SETTINGS_FILE = DATA_DIR / "serial.settings"
LANGUAGE_FILE = DATA_DIR / "language.json"
THEME_FILE = DATA_DIR / "theme.json"
WINDOW_STATE_FILE = DATA_DIR / "window_state.settings"
DEVICE_IDS_FILE = DATA_DIR / "device_ids.config"
PREFERENCES_FILE = DATA_DIR / "preferences.settings"
LOG_DIR = DATA_DIR / "logs"
PORT_LOCK_DIR = DATA_DIR / "port_locks"
PROFILE_DIR = DATA_DIR / "profiles"
PACKAGED_DATA_DIR = RESOURCE_ROOT / "data" / "PortWaver"


def atomic_write_json(path: Path, value: dict[str, Any]) -> None:
    """Replace a JSON file atomically so concurrent instances cannot corrupt it."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
    try:
        temporary.write_text(json.dumps(value, indent=2), encoding="utf-8")
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def load_json_file(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def parse_window_size(value: Any, default: tuple[int, int] = (1440, 810)) -> tuple[int, int]:
    if not isinstance(value, str):
        return default
    try:
        width_text, height_text = value.lower().replace(" ", "").split("x", 1)
        width, height = int(width_text), int(height_text)
        if width < 1 or height < 1:
            raise ValueError
        return width, height
    except (TypeError, ValueError):
        return default


def primary_display_size() -> tuple[int, int]:
    if sys.platform == "win32":
        user32 = ctypes.windll.user32
        return int(user32.GetSystemMetrics(0)), int(user32.GetSystemMetrics(1))
    return 1920, 1080


def resolve_window_options() -> tuple[int, int, bool]:
    theme = load_json_file(THEME_FILE)
    configured_width, configured_height = parse_window_size(theme.get("window_size"))
    resizable = theme.get("window_resizable", True)
    if not isinstance(resizable, bool):
        resizable = True

    if WINDOW_STATE_FILE.exists():
        return configured_width, configured_height, resizable

    display_width, display_height = primary_display_size()
    width = max(1, round(display_width * 0.75))
    height = max(1, round(display_height * 0.75))
    WINDOW_STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_json(WINDOW_STATE_FILE, {"first_window_size_calculated": True})
    return width, height, resizable


def prepare_data_directory() -> None:
    legacy_data_dir = ROOT / "data" / "SerialConsole"
    if legacy_data_dir.exists() and legacy_data_dir != DATA_DIR:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        for legacy_item in legacy_data_dir.iterdir():
            target = DATA_DIR / legacy_item.name
            if not target.exists():
                shutil.move(str(legacy_item), str(target))
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if PACKAGED_DATA_DIR != DATA_DIR and PACKAGED_DATA_DIR.exists():
        for packaged_file in PACKAGED_DATA_DIR.iterdir():
            if packaged_file.is_file():
                target = DATA_DIR / packaged_file.name
                if not target.exists():
                    shutil.copy2(packaged_file, target)
    for legacy in (ROOT / "data").glob("*.json"):
        target = DATA_DIR / legacy.name
        if not target.exists():
            shutil.move(str(legacy), str(target))
    migrations = {
        DATA_DIR / "settings.json": SETTINGS_FILE,
        DATA_DIR / "window_state.json": WINDOW_STATE_FILE,
        DATA_DIR / "device_ids.json": DEVICE_IDS_FILE,
        DATA_DIR / "preferences.json": PREFERENCES_FILE,
    }
    for source, target in migrations.items():
        if source.exists() and not target.exists():
            shutil.move(str(source), str(target))
    PROFILE_DIR.mkdir(exist_ok=True)


class SerialApi:
    def __init__(self, resizable: bool = True) -> None:
        self.connection: serial.Serial | None = None
        self.reader: threading.Thread | None = None
        self.running = False
        self.connecting = False
        self.started_at = 0.0
        self.messages: list[dict[str, Any]] = []
        self.lock = threading.Lock()
        self.state_lock = threading.RLock()
        self.is_maximized = False
        self.resizable = resizable
        self.log_file: Any = None
        self.log_path = ""
        self.log_error = ""
        self.connection_mode = "physical"
        self.encoding = "utf-8"
        self.rx_conversion = "none"
        self.emulated_inputs = {"cts": False, "dsr": False, "dcd": False, "ri": False}
        self.instance_id = f"{os.getpid()}-{uuid.uuid4().hex[:8]}"
        self.port_lock_path: Path | None = None
        prepare_data_directory()

    @staticmethod
    def _port_lock_name(port: str) -> str:
        safe = "".join(character if character.isalnum() else "_" for character in port.upper())
        digest = hashlib.sha256(port.upper().encode("utf-8")).hexdigest()[:10]
        return f"{safe[:60] or 'UNKNOWN'}_{digest}"

    def _claim_port(self, port: str) -> bool:
        """Reserve a port among this application's concurrently running instances."""
        PORT_LOCK_DIR.mkdir(parents=True, exist_ok=True)
        lock_path = PORT_LOCK_DIR / f"{self._port_lock_name(port)}.lock"
        for attempt in range(2):
            try:
                descriptor = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                with os.fdopen(descriptor, "w", encoding="utf-8") as lock_file:
                    lock_file.write(json.dumps({"pid": os.getpid(), "instance": self.instance_id, "port": port}))
                self.port_lock_path = lock_path
                return True
            except FileExistsError:
                if attempt or not self._remove_stale_port_lock(lock_path):
                    return False
        return False

    @staticmethod
    def _remove_stale_port_lock(lock_path: Path) -> bool:
        try:
            owner = json.loads(lock_path.read_text(encoding="utf-8"))
            pid = int(owner.get("pid", 0))
            if pid > 0 and sys.platform == "win32":
                process = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)
                if process:
                    ctypes.windll.kernel32.CloseHandle(process)
                    return False
            elif pid > 0:
                os.kill(pid, 0)
                return False
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            pass
        try:
            lock_path.unlink()
            return True
        except OSError:
            return False

    def _release_port(self) -> None:
        lock_path, self.port_lock_path = self.port_lock_path, None
        if lock_path:
            try:
                lock_path.unlink()
            except FileNotFoundError:
                pass

    def _load_json(self, path: Path) -> dict[str, Any]:
        return load_json_file(path)

    def load_resources(self) -> dict[str, Any]:
        return {
            "language": self._load_json(LANGUAGE_FILE),
            "theme": self._load_json(THEME_FILE),
            "paths": {"default_log_dir": str(LOG_DIR)},
        }

    def list_serial_ports(self) -> list[dict[str, Any]]:
        identifiers = self._load_json(DEVICE_IDS_FILE).get("vendors", [])
        ports = []
        for port in list_ports.comports():
            identity = self._identify_device(port.vid, port.pid, identifiers)
            ports.append({
                "device": port.device,
                "description": port.description or "Serial port",
                "vid": f"{port.vid:04X}" if port.vid is not None else None,
                "pid": f"{port.pid:04X}" if port.pid is not None else None,
                "family": identity,
            })
        return ports

    @staticmethod
    def _identify_device(vid: int | None, pid: int | None, vendors: list[dict[str, Any]]) -> str:
        if vid is None:
            return "Generic serial device"
        vid_hex = f"{vid:04X}"
        pid_hex = f"{pid:04X}" if pid is not None else ""
        for vendor in vendors:
            if vendor.get("vid", "").upper() != vid_hex:
                continue
            for product in vendor.get("products", []):
                if product.get("pid", "").upper() == pid_hex:
                    return product.get("name", vendor.get("name", "USB serial device"))
            return vendor.get("name", "USB serial device")
        return "Generic USB serial device"

    def connect_serial(self, config: dict[str, Any]) -> dict[str, Any]:
        with self.state_lock:
            if self.connecting or (self.connection and self.connection.is_open):
                return {"ok": False, "message": "Disconnect the current port before connecting another one"}
            self.connecting = True
        try:
            label = str(config.get("port", "loop://"))
            if not self._claim_port(label):
                return {"ok": False, "message": f"{label} is already being used by another PortWaver instance"}
            parameters = {
                "baudrate": int(config.get("baudrate", 115200)),
                "bytesize": int(config.get("bytesize", 8)),
                "parity": str(config.get("parity", "N")),
                "stopbits": float(config.get("stopbits", 1)),
                "xonxoff": config.get("flowControl") == "xonxoff",
                "rtscts": config.get("flowControl") == "rtscts",
                "dsrdtr": config.get("flowControl") == "dsrdtr",
                "timeout": 0.1,
            }
            if config.get("mode") == "emulate":
                connection = serial.serial_for_url("loop://", **parameters)
            else:
                connection = serial.Serial(port=str(config["port"]), **parameters)
            with self.state_lock:
                self.connection = connection
                self.connection_mode = str(config.get("mode", "physical"))
                self.emulated_inputs = {
                    name: bool(config.get(name, False)) for name in ("cts", "dsr", "dcd", "ri")
                }
                connection.rts = bool(config.get("rts", True))
                connection.dtr = bool(config.get("dtr", True))
                self.running = True
                self.started_at = time.monotonic()
                self.reader = threading.Thread(target=self._read_loop, args=(connection, self.started_at), daemon=True)
                self.reader.start()
            label = str(config.get("port", connection.port))
            return {"ok": True, "message": f"Connected to {label}"}
        except (KeyError, ValueError, OSError, serial.SerialException) as exc:
            with self.state_lock:
                self.connection = None
            return {"ok": False, "message": str(exc)}
        finally:
            with self.state_lock:
                self.connecting = False
            if not self.connection:
                self._release_port()

    def disconnect_serial(self) -> dict[str, Any]:
        with self.state_lock:
            self.running = False
            connection, self.connection = self.connection, None
            reader, self.reader = self.reader, None
        if connection and connection.is_open:
            try:
                connection.close()
            except serial.SerialException:
                pass
        if reader and reader is not threading.current_thread():
            reader.join(timeout=0.5)
        self._release_port()
        return {"ok": True, "message": "Port disconnected"}

    def send_serial(
        self,
        text: str,
        append_newline: bool = True,
        encoding: str = "utf-8",
        line_ending: str | None = None,
    ) -> dict[str, Any]:
        connection = self.connection
        if not connection or not connection.is_open:
            return {"ok": False, "message": "No serial port is connected"}
        endings = {"none": "", "lf": "\n", "cr": "\r", "crlf": "\r\n"}
        suffix = "\n" if append_newline else ""
        if line_ending is not None:
            suffix = endings.get(str(line_ending).lower(), suffix)
        payload = text + suffix
        try:
            encoded = payload.encode(encoding if encoding in ("ascii", "utf-8") else "utf-8", errors="replace")
            connection.write(encoded)
            return {"ok": True, "bytes": len(encoded)}
        except (LookupError, OSError, serial.SerialException) as exc:
            return {"ok": False, "message": str(exc)}

    def set_transport_options(self, encoding: str, rx_conversion: str) -> dict[str, Any]:
        self.encoding = encoding if encoding in ("ascii", "utf-8") else "utf-8"
        self.rx_conversion = rx_conversion if rx_conversion in ("none", "lf_to_crlf", "cr_to_crlf") else "none"
        return {"ok": True}

    def set_signal_state(self, name: str, value: bool) -> dict[str, Any]:
        connection = self.connection
        if not connection or not connection.is_open:
            return {"ok": False, "message": "No serial port is connected"}
        name = name.lower()
        try:
            if name in ("rts", "dtr"):
                setattr(connection, name, bool(value))
            elif self.connection_mode == "emulate" and name in self.emulated_inputs:
                self.emulated_inputs[name] = bool(value)
            else:
                return {"ok": False, "message": f"{name.upper()} is an input signal and cannot be edited"}
            return {"ok": True, "signals": self._signal_status(connection)}
        except (OSError, ValueError, serial.SerialException) as exc:
            return {"ok": False, "message": str(exc)}

    def send_break(self, duration: float = 0.25) -> dict[str, Any]:
        connection = self.connection
        if not connection or not connection.is_open:
            return {"ok": False, "message": "No serial port is connected"}
        try:
            connection.send_break(max(0.05, min(float(duration), 2.0)))
            return {"ok": True, "message": "BREAK signal sent"}
        except (OSError, ValueError, serial.SerialException) as exc:
            return {"ok": False, "message": str(exc)}

    def _signal_status(self, connection: serial.Serial | None = None) -> dict[str, bool]:
        connection = connection or self.connection
        if not connection or not connection.is_open:
            return {name: False for name in ("rts", "dtr", "cts", "dsr", "dcd", "ri")}
        status = {"rts": bool(connection.rts), "dtr": bool(connection.dtr)}
        if self.connection_mode == "emulate":
            status.update(self.emulated_inputs)
            return status
        for name, attribute in (("cts", "cts"), ("dsr", "dsr"), ("dcd", "cd"), ("ri", "ri")):
            try:
                status[name] = bool(getattr(connection, attribute))
            except (OSError, ValueError, serial.SerialException):
                status[name] = False
        return status

    def poll_serial(self) -> dict[str, Any]:
        with self.lock:
            messages, self.messages = self.messages, []
            logging = self.log_file is not None
            log_error, self.log_error = self.log_error, ""
        connection = self.connection
        connected = bool(connection and connection.is_open)
        elapsed = int((time.monotonic() - self.started_at) * 1000) if connected else 0
        return {"connected": connected, "elapsed_ms": elapsed, "messages": messages, "logging": logging, "log_error": log_error, "signals": self._signal_status(connection)}

    def _read_loop(self, connection: serial.Serial, started_at: float) -> None:
        buffer = bytearray()
        pending_cr = False
        last_data_at = time.monotonic()
        while self.running and self.connection is connection:
            try:
                chunk = connection.read(connection.in_waiting or 1)
                if not chunk:
                    if (buffer or pending_cr) and time.monotonic() - last_data_at >= 0.05:
                        self._queue_message(bytes(buffer), started_at, "cr" if pending_cr else "")
                        buffer.clear()
                        pending_cr = False
                    continue
                last_data_at = time.monotonic()
                for byte in chunk:
                    if pending_cr:
                        if byte == 10:
                            self._queue_message(bytes(buffer), started_at, "crlf")
                            buffer.clear()
                            pending_cr = False
                            continue
                        self._queue_message(bytes(buffer), started_at, "cr")
                        buffer.clear()
                        pending_cr = False
                    if byte == 13:
                        pending_cr = True
                    elif byte == 10:
                        self._queue_message(bytes(buffer), started_at, "lf")
                        buffer.clear()
                    else:
                        buffer.append(byte)
            except (OSError, serial.SerialException) as exc:
                if self.running and self.connection is connection:
                    self._queue_message(f"[SERIAL ERROR] {exc}".encode(), started_at)
                    with self.state_lock:
                        self.running = False
                        self.connection = None
                    try:
                        connection.close()
                    except (OSError, serial.SerialException):
                        pass
                    self._release_port()
        if (buffer or pending_cr) and self.connection is connection:
            self._queue_message(bytes(buffer), started_at, "cr" if pending_cr else "")

    def _queue_message(self, raw: bytes, started_at: float | None = None, ending: str = "") -> None:
        if not raw and ending:
            return
        if self.rx_conversion == "lf_to_crlf" and ending == "lf":
            ending = "crlf"
        elif self.rx_conversion == "cr_to_crlf" and ending == "cr":
            ending = "crlf"
        message = {
            "text": raw.decode(self.encoding, errors="replace"),
            "elapsed_ms": int((time.monotonic() - (started_at or self.started_at)) * 1000),
            "ending": ending,
        }
        with self.lock:
            self.messages.append(message)
            if len(self.messages) > 10000:
                del self.messages[:-10000]
            if self.log_file:
                try:
                    suffix = {"lf": "\n", "cr": "\r", "crlf": "\r\n"}.get(message["ending"], "")
                    self.log_file.write(f"[{message['elapsed_ms']:08d} ms] {message['text']}{suffix}")
                    self.log_file.flush()
                except (OSError, ValueError):
                    self.log_file = None
                    self.log_path = ""
                    self.log_error = "Reception logging stopped because the file could not be written"

    def set_logging(self, enabled: bool, directory: str = "", filename: str = "") -> dict[str, Any]:
        with self.lock:
            if self.log_file:
                self.log_file.close()
                self.log_file = None
        if not enabled:
            path, self.log_path = self.log_path, ""
            return {"ok": True, "enabled": False, "path": path, "message": "Reception logging stopped"}
        try:
            now = datetime.now()
            target_dir = Path(directory).expanduser() if directory else LOG_DIR
            target_dir.mkdir(parents=True, exist_ok=True)
            file_pattern = filename.strip() or "serial_{date}_{time}.txt"
            file_name = file_pattern.replace("{date}", now.strftime("%Y%m%d")).replace("{time}", now.strftime("%H%M%S"))
            if not file_name.lower().endswith(".txt"):
                file_name += ".txt"
            target = target_dir / Path(file_name).name
            if target.exists():
                target = target.with_name(f"{target.stem}_{self.instance_id}{target.suffix}")
            log_file = target.open("a", encoding="utf-8", newline="")
            with self.lock:
                self.log_file = log_file
                self.log_path = str(target)
            return {"ok": True, "enabled": True, "path": self.log_path, "message": "Reception logging started"}
        except OSError as exc:
            return {"ok": False, "enabled": False, "path": "", "message": str(exc)}

    def load_settings(self) -> dict[str, Any]:
        return self._load_json(SETTINGS_FILE)

    def save_settings(self, settings: dict[str, Any]) -> dict[str, Any]:
        atomic_write_json(SETTINGS_FILE, settings)
        return {"ok": True, "message": "Settings saved"}

    @staticmethod
    def _profile_filename(name: str) -> str:
        safe = "".join(character for character in name.strip() if character.isalnum() or character in " -_").strip()
        if not safe:
            raise ValueError("Profile name is required")
        return f"{safe[:80]}.UserVSP"

    def list_profiles(self) -> list[dict[str, Any]]:
        PROFILE_DIR.mkdir(parents=True, exist_ok=True)
        profiles = []
        for path in sorted(PROFILE_DIR.glob("*.UserVSP"), key=lambda item: item.stat().st_mtime, reverse=True):
            data = self._load_json(path)
            profiles.append({
                "name": data.get("profileName", path.stem),
                "file": path.name,
                "modified": datetime.fromtimestamp(path.stat().st_mtime).strftime("%Y-%m-%d %H:%M"),
            })
        return profiles

    def save_profile(self, name: str, settings: dict[str, Any]) -> dict[str, Any]:
        try:
            filename = self._profile_filename(name)
            payload = {
                "format": "PortWaver Serial Profile",
                "version": 1,
                "profileName": name.strip(),
                "savedAt": datetime.now().isoformat(timespec="seconds"),
                "settings": settings,
            }
            atomic_write_json(PROFILE_DIR / filename, payload)
            return {"ok": True, "message": f"Profile {name.strip()} saved", "file": filename}
        except (OSError, ValueError) as exc:
            return {"ok": False, "message": str(exc)}

    def load_profile(self, filename: str) -> dict[str, Any]:
        path = PROFILE_DIR / Path(filename).name
        if path.suffix.lower() != ".uservsp" or not path.exists():
            return {"ok": False, "message": "Profile not found"}
        payload = self._load_json(path)
        settings = payload.get("settings")
        if not isinstance(settings, dict):
            return {"ok": False, "message": "Invalid profile"}
        return {"ok": True, "name": payload.get("profileName", path.stem), "settings": settings}

    def delete_profile(self, filename: str) -> dict[str, Any]:
        path = PROFILE_DIR / Path(filename).name
        if path.suffix.lower() != ".uservsp":
            return {"ok": False, "message": "Invalid profile file"}
        try:
            path.unlink()
            return {"ok": True, "message": "Profile deleted"}
        except FileNotFoundError:
            return {"ok": False, "message": "Profile not found"}
        except OSError as exc:
            return {"ok": False, "message": str(exc)}

    def choose_text_file(self) -> dict[str, Any]:
        paths = webview.windows[0].create_file_dialog(
            webview.FileDialog.OPEN,
            file_types=("Text files (*.txt)", "All files (*.*)"),
        )
        if not paths:
            return {"ok": False, "cancelled": True}
        path = Path(paths[0])
        try:
            if path.stat().st_size > 10 * 1024 * 1024:
                return {"ok": False, "message": "The file exceeds the 10 MB limit"}
            lines = path.read_text(encoding=self.encoding, errors="replace").splitlines()
            return {"ok": True, "path": str(path), "name": path.name, "lines": lines}
        except OSError as exc:
            return {"ok": False, "message": str(exc)}

    def window_action(self, action: str) -> None:
        window = webview.windows[0]
        if action == "minimize":
            window.minimize()
        elif action == "maximize":
            window.restore() if self.is_maximized else window.maximize()
            self.is_maximized = not self.is_maximized
        elif action == "fullscreen":
            window.toggle_fullscreen()
        elif action == "close":
            self.disconnect_serial()
            self.set_logging(False)
            window.destroy()

    def resize_window(self, width: int, height: int, edge: str) -> dict[str, Any]:
        if not self.resizable or self.is_maximized:
            return {"ok": False}
        width = max(1100, int(width))
        height = max(700, int(height))
        horizontal = FixPoint.EAST if "w" in edge else FixPoint.WEST
        vertical = FixPoint.SOUTH if "n" in edge else FixPoint.NORTH
        webview.windows[0].resize(width, height, horizontal | vertical)
        return {"ok": True, "width": width, "height": height}


def main() -> None:
    prepare_data_directory()
    width, height, resizable = resolve_window_options()
    webview.create_window(
        "PortWaver Serial Terminal",
        url=str(RESOURCE_ROOT / "GUI" / "index.html"),
        js_api=SerialApi(resizable=resizable),
        width=width,
        height=height,
        min_size=(min(width, 1100), min(height, 700)),
        resizable=resizable,
        background_color="#24272a",
        frameless=True,
        easy_drag=False,
    )
    webview.start(debug=False, icon=str(ICON_FILE))


if __name__ == "__main__":
    main()
