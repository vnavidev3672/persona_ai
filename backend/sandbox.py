"""Runs generated tests inside an E2B sandbox with internet disabled. Never executes code locally."""
import os, re

class SandboxUnavailable(Exception):
    pass

def is_esm(code: str) -> bool:
    return bool(re.search(r"^\s*(import\s.+from|export\s)", code, re.M))

def run(language: str, code: str, tests: str) -> dict:
    try:
        from e2b import Sandbox
    except ImportError as e:
        raise SandboxUnavailable("Sandbox SDK not installed") from e
    if language == "python":
        files = {"subject.py": code, "test_subject.py": tests}
        cmd = "timeout 40 python3 -m pytest -q -rA --tb=short -p no:cacheprovider test_subject.py 2>&1"
    else:
        ext = "mjs" if is_esm(code) else "js"
        files = {f"subject.{ext}": code, f"test_subject.{ext}": tests}
        cmd = f"timeout 40 node --test --test-reporter=tap test_subject.{ext} 2>&1"
    sbx = None
    try:
        # allow_internet_access=False: no network from user code. Verify the kwarg against your installed e2b version.
        sbx = Sandbox.create(template=os.environ.get("E2B_TEMPLATE") or None, timeout=120, allow_internet_access=False)
        for name, content in files.items():
            sbx.files.write(f"/home/user/w/{name}", content)
        try:
            r = sbx.commands.run(f"cd /home/user/w && ulimit -v 1500000; {cmd}", timeout=60)
            code_, out = r.exit_code, (r.stdout or "") + (r.stderr or "")
        except Exception as e:  # non-zero exit raises CommandExitException in e2b
            if hasattr(e, "exit_code"):
                code_, out = e.exit_code, (getattr(e, "stdout", "") or "") + (getattr(e, "stderr", "") or "")
            else:
                raise
        return {"exit_code": code_, "output": out}
    except Exception as e:
        raise SandboxUnavailable(str(e)) from e
    finally:
        if sbx:
            try: sbx.kill()
            except Exception: pass
