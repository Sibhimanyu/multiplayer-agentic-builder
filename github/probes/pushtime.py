"""Time a bare `git push` and `git ls-remote` against the demo repo, right now.

A4 is taking ~100 s per append when it took ~3 s earlier today, and the quota is
barely touched -- so the time is not in REST and not in read-looping. Before
theorising further, measure the primitive: is github.com simply slow right now?

Compares against probe G's earlier figures on the same operations:
  git push (create a ref)  p50 ~2,165 ms
  git ls-remote            p50 ~1,340 ms
"""

import os
import subprocess
import tempfile
import time

REPO = "https://github.com/Sibhimanyu/inventory-tracker-github.git"
NS = "refs/agentic/pushtime"


def run(args, cwd):
    return subprocess.run(args, cwd=cwd, capture_output=True, text=True)


d = tempfile.mkdtemp(prefix="pushtime-")
run(["git", "init", "--quiet"], d)
run(["git", "config", "user.email", "p@example.invalid"], d)
run(["git", "config", "user.name", "p"], d)
run(["git", "remote", "add", "origin", REPO], d)

tree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

print("git ls-remote, 3 samples:")
for i in range(3):
    t0 = time.time()
    r = run(["git", "ls-remote", "origin"], d)
    print("  ", round((time.time() - t0) * 1000), "ms  rc=", r.returncode)

print()
print("git push (create one ref), 5 samples:")
for i in range(5):
    obj = run(["git", "commit-tree", tree, "-m", "pushtime " + str(i)], d).stdout.strip()
    ref = NS + "/" + str(i)
    t0 = time.time()
    r = run(["git", "push", "--porcelain", "--atomic",
             "--force-with-lease=" + ref + ":", "origin", obj + ":" + ref], d)
    print("  ", round((time.time() - t0) * 1000), "ms  rc=", r.returncode)

print()
print("cleanup:")
refs = [":" + NS + "/" + str(i) for i in range(5)]
r = run(["git", "push", "--quiet", "origin", *refs], d)
print("  deleted, rc=", r.returncode)
