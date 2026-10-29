"""Runs generated tests inside a Modal Sandbox with the network blocked. Never executes code locally.
Auth: Modal reads MODAL_TOKEN_ID and MODAL_TOKEN_SECRET from the environment."""
import re

class SandboxUnavailable(Exception):
    pass

_image = None

def is_esm(code: str) -> bool:
    return bool(re.search(r"^\s*(import\s.+from|export\s)", code, re.M))

def _get_image(modal):
    global _image
    if _image is None:  # built once by Modal (first run is slow), then cached
        _image = modal.Image.from_registry("node:22-slim", add_python="3.12").pip_install("pytest")
    return _image

def _write(sb, path, content):
    p = sb.exec("sh", "-c", f"mkdir -p /work && cat > {path}")
    p.stdin.write(content)
    p.stdin.write_eof()
    p.wait()

def run(language: str, code: str, tests: str) -> dict:
    try:
        import modal
    except ImportError as e:
        raise SandboxUnavailable("Sandbox SDK not installed") from e
    if language == "python":
        files = {"subject.py": code, "test_subject.py": tests}
        cmd = "timeout 40 python -m pytest -q -rA --tb=short -p no:cacheprovider test_subject.py 2>&1"
    else:
        ext = "mjs" if is_esm(code) else "js"
        files = {f"subject.{ext}": code, f"test_subject.{ext}": tests}
        cmd = f"timeout 40 node --test --test-reporter=tap test_subject.{ext} 2>&1"
    sb = None
    try:
        app = modal.App.lookup("persona-pulse-ai", create_if_missing=True)
        sb = modal.Sandbox.create("sleep", "180", app=app, image=_get_image(modal),
                                  timeout=180, block_network=True, cpu=1.0, memory=1024)
        for name, content in files.items():
            _write(sb, f"/work/{name}", content)
        p = sb.exec("sh", "-c", f"cd /work && {cmd}", timeout=60)
        out = p.stdout.read()
        p.wait()
        return {"exit_code": p.returncode, "output": out}
    except Exception as e:
        raise SandboxUnavailable(str(e)) from e
    finally:
        if sb is not None:
            try: sb.terminate()
            except Exception: pass
