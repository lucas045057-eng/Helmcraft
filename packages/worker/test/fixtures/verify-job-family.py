"""Finite Job Object accounting fixture. The test authorizes launch after attachment."""

from pathlib import Path
import subprocess
import sys
import time


def wait_for(path):
    deadline = time.monotonic() + 5
    while not path.exists():
        if time.monotonic() >= deadline:
            raise TimeoutError(path.name)
        time.sleep(0.025)


role, directory = sys.argv[1:]
root = Path(directory)
if role == "child":
    print("child stdout", flush=True)
    print("child stderr", file=sys.stderr, flush=True)
    (root / "child-ready").touch()
    time.sleep(8)
elif role == "parent":
    wait_for(root / "job-assigned")
    child = subprocess.Popen(
        [sys.executable, __file__, "child", directory],
        stdout=sys.stdout,
        stderr=sys.stderr,
    )
    wait_for(root / "child-ready")
    (root / "child-pid").write_text(str(child.pid), encoding="ascii")
else:
    raise ValueError("unknown verification fixture role")
