import fcntl
import codecs
import hashlib
import json
import os
from pathlib import Path
import subprocess
import stat
import signal
import sys
import tempfile
import time
import uuid


SUPERVISOR = r'''
import json, os, selectors, signal, subprocess, sys, time
from pathlib import Path

directory = Path(sys.argv[1])
request = json.loads((directory / "request.json").read_text())
state = {"status": "running", "createdAt": time.time(), "startedAt": time.time(), "logTruncated": False}
def save():
    temporary = directory / "state.tmp"
    temporary.write_text(json.dumps(state))
    temporary.replace(directory / "state.json")

def stop(signum, frame):
    (directory / "cancel").touch()

signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
process = None
try:
    process = subprocess.Popen(["/bin/bash", "-lc", request["command"]], cwd=request["cwd"],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
    try:
        identity = Path(f"/proc/{process.pid}/stat").read_text().rsplit(")", 1)[1].split()[19]
    except FileNotFoundError:
        identity = None
    (directory / "child.json").write_text(json.dumps({"pid": process.pid, "identity": identity}))
    save()
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    size = 0
    stopped = None
    stopping = None
    started = time.monotonic()
    with (directory / "output.log").open("ab", buffering=0) as output:
        while True:
            elapsed = time.monotonic() - started
            if stopping is None and ((directory / "cancel").exists() or elapsed >= request["timeoutSeconds"]):
                stopped = "cancelled" if (directory / "cancel").exists() else "timed_out"
                stopping = time.monotonic()
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
            if stopping is not None and time.monotonic() - stopping >= 3:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            for key, _ in selector.select(0.1):
                chunk = os.read(key.fileobj.fileno(), 65536)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                remaining = max(0, 16 * 1024 * 1024 - size)
                output.write(chunk[:remaining])
                size += min(remaining, len(chunk))
                state["logTruncated"] |= len(chunk) > remaining
            if process.poll() is not None:
                # The tracked command owns its process group, including background children.
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                drain_until = time.monotonic() + 1
                while selector.get_map() and time.monotonic() < drain_until:
                    events = selector.select(0.1)
                    if not events:
                        break
                    for key, _ in events:
                        chunk = os.read(key.fileobj.fileno(), 65536)
                        if not chunk:
                            selector.unregister(key.fileobj)
                            continue
                        remaining = max(0, 16 * 1024 * 1024 - size)
                        output.write(chunk[:remaining])
                        size += min(remaining, len(chunk))
                        state["logTruncated"] |= len(chunk) > remaining
                break
    state.update(status=stopped or ("completed" if process.returncode == 0 else "failed"),
        exitCode=process.returncode, finishedAt=time.time())
except Exception:
    if process is not None:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()
    state.update(status="failed", error="REMOTE_COMMAND_FAILED", finishedAt=time.time())
save()
'''


def atomic_json(path, data):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(data))
    temporary.replace(path)


def process_identity(pid):
    try:
        text = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        return None if text[0] == "Z" else text[19]
    except (FileNotFoundError, ProcessLookupError):
        return None


def job_state(directory):
    state = json.loads((directory / "state.json").read_text())
    if state["status"] in ("starting", "running"):
        launch = directory / "launch.json"
        if launch.exists():
            info = json.loads(launch.read_text())
            if process_identity(info["pid"]) != info["identity"] or info["identity"] is None:
                state.update(status="interrupted")
        elif time.time() - state.get("createdAt", state.get("startedAt", 0)) > 10:
            state.update(status="interrupted")
    return {"id": directory.name, **state}


def execute(root, args):
    directory = root / str(uuid.UUID(args["id"]))
    with (root / "launch.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if directory.exists():
            previous = json.loads((directory / "request.json").read_text())
            if previous != args:
                raise ValueError("REMOTE_ID_CONFLICT")
            return job_state(directory)
        directory.mkdir(mode=0o700)
        atomic_json(directory / "request.json", args)
        atomic_json(directory / "state.json", {"status": "starting", "createdAt": time.time()})
        process = subprocess.Popen([sys.executable, "-c", SUPERVISOR, str(directory)],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True, close_fds=True)
        atomic_json(directory / "launch.json", {"pid": process.pid, "identity": process_identity(process.pid)})
        return job_state(directory)


def file_read(args):
    path = Path(args["path"])
    if not path.is_absolute():
        raise ValueError("REMOTE_PATH_INVALID")
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NONBLOCK), "rb") as file:
        if not stat.S_ISREG(os.fstat(file.fileno()).st_mode):
            raise ValueError("REMOTE_FILE_INVALID")
        if os.fstat(file.fileno()).st_size > 16 * 1024 * 1024:
            raise ValueError("REMOTE_FILE_TOO_LARGE")
        content = file.read(16 * 1024 * 1024 + 1)
    if len(content) > 16 * 1024 * 1024:
        raise ValueError("REMOTE_FILE_TOO_LARGE")
    text = content.decode("utf-8")
    offset = args.get("offset", 0)
    chunk = text[offset:offset + 16000]
    end = offset + len(chunk)
    return {"path": str(path), "content": chunk, "hash": hashlib.sha256(content).hexdigest(),
        "nextOffset": end if end < len(text) else None}


def file_write(root, args):
    path = Path(args["path"])
    if not path.is_absolute() or path.is_symlink():
        raise ValueError("REMOTE_PATH_INVALID")
    with (root / "files.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        actual = file_read({"path": str(path)})["hash"] if path.exists() else None
        if actual != args["expectedHash"]:
            raise ValueError("REMOTE_FILE_CHANGED")
        content = args["content"].encode("utf-8")
        mode = path.stat().st_mode & 0o777 if path.exists() else 0o600
        fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=".agents-")
        try:
            with os.fdopen(fd, "wb") as output:
                output.write(content)
                output.flush()
                os.fsync(output.fileno())
                os.fchmod(output.fileno(), mode)
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        return {"path": str(path), "hash": hashlib.sha256(content).hexdigest(), "bytes": len(content)}


def main(payload):
    namespace = payload["namespace"]
    if len(namespace) != 64 or any(char not in "0123456789abcdef" for char in namespace):
        raise ValueError("REMOTE_NAMESPACE_INVALID")
    root = Path.home() / ".local/state/agents-remote" / namespace
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    operation, args = payload["operation"], payload["args"]
    if operation == "status":
        return {"connected": True, "home": str(Path.home()), "workspace": "/workspace"}
    if operation == "exec":
        return execute(root, args)
    if operation == "jobs":
        directories = sorted((path for path in root.iterdir() if path.is_dir()),
            key=lambda path: path.stat().st_mtime, reverse=True)
        return {"jobs": [job_state(path) for path in directories[:50]], "truncated": len(directories) > 50}
    if operation in ("job", "cancel"):
        directory = root / str(uuid.UUID(args["id"]))
        if operation == "cancel":
            state = job_state(directory)
            child = directory / "child.json"
            if state["status"] == "interrupted" and child.exists():
                info = json.loads(child.read_text())
                if info["identity"] is not None and process_identity(info["pid"]) == info["identity"]:
                    try:
                        os.killpg(info["pid"], signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    return {**state, "cancelRequested": True, "orphanStopped": True}
            if state["status"] in ("starting", "running"):
                (directory / "cancel").touch()
                return {**state, "cancelRequested": True}
            return {**state, "cancelRequested": False}
        offset = args.get("offset", 0)
        log = directory / "output.log"
        chunk = b""
        total = 0
        if log.exists():
            with log.open("rb") as stream:
                total = os.fstat(stream.fileno()).st_size
                stream.seek(offset)
                chunk = stream.read(16000)
        state = job_state(directory)
        decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        terminal = state["status"] not in ("starting", "running")
        output = decoder.decode(chunk, final=terminal and offset + len(chunk) >= total)
        consumed = len(chunk) - len(decoder.getstate()[0])
        return {**state, "output": output, "offset": offset, "nextOffset": offset + consumed,
            "hasMore": offset + consumed < total}
    if operation == "read":
        return file_read(args)
    if operation == "write":
        return file_write(root, args)
    raise ValueError("REMOTE_OPERATION_INVALID")


try:
    result = main(json.loads(sys.stdin.buffer.read(256001)))
    print(json.dumps({"ok": True, "result": result}, ensure_ascii=False))
except Exception as error:
    known = isinstance(error, ValueError) and str(error).startswith("REMOTE_")
    code = str(error) if known else "REMOTE_OPERATION_FAILED"
    print(json.dumps({"ok": False, "error": code}))
