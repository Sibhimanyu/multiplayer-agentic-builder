"""Is GIT_ASKPASS=echo what wedges the adapter's pushes?

The adapter spawns git with GIT_ASKPASS='echo' and GIT_TERMINAL_PROMPT='0',
intending "never prompt, fail fast instead". But `echo` EXITS 0 and prints the
prompt text, and git treats an askpass that exits 0 as having SUPPLIED a
credential. So instead of failing fast, git tries to authenticate with garbage.

That fits the evidence exactly:
  - identical pushes from a plain environment: 1.86-2.06 s, every time
  - the adapter's pushes, same host, same minute: wedged
  - and it worked for hundreds of pushes earlier today, which is what a
    credential-helper cache expiring would look like

This varies ONLY the env, one variable at a time, against the same remote.
"""

import os
import subprocess
import tempfile
import time

REPO = "https://github.com/Sibhimanyu/inventory-tracker-github.git"
NS = "refs/agentic/askpass"
TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
DEADLINE = 25

d = tempfile.mkdtemp(prefix="askpass-")
subprocess.run(["git", "init", "--quiet"], cwd=d, check=True)
subprocess.run(["git", "config", "user.email", "p@e.invalid"], cwd=d, check=True)
subprocess.run(["git", "config", "user.name", "p"], cwd=d, check=True)
subprocess.run(["git", "remote", "add", "origin", REPO], cwd=d, check=True)


def obj(msg):
    return subprocess.run(["git", "commit-tree", TREE, "-m", msg],
                          cwd=d, capture_output=True, text=True).stdout.strip()


def attempt(label, extra_env):
    env = dict(os.environ)
    env.update(extra_env)
    ref = NS + "/" + str(int(time.time() * 1000))
    o = obj(label)
    t0 = time.time()
    try:
        r = subprocess.run(
            ["git", "push", "--porcelain", "--atomic",
             "--force-with-lease=" + ref + ":", "origin", o + ":" + ref],
            cwd=d, capture_output=True, text=True, env=env, timeout=DEADLINE)
        ms = round((time.time() - t0) * 1000)
        print("  %-52s %6d ms  rc=%s" % (label, ms, r.returncode))
        if r.returncode != 0:
            print("        stderr:", r.stderr.strip().replace("\n", " | ")[:160])
        return ref if r.returncode == 0 else None
    except subprocess.TimeoutExpired:
        print("  %-52s  WEDGED (killed at %ds)" % (label, DEADLINE))
        return None


print("same remote, same shape, varying ONLY the environment:\n")
created = []
for i in range(3):
    print("round", i)
    # 1. plain inherited environment -- what every probe of mine has used
    created.append(attempt("plain env (no overrides)", {}))
    # 2. EXACTLY what the adapter sets today
    created.append(attempt("GIT_TERMINAL_PROMPT=0 + GIT_ASKPASS=echo", {
        "GIT_TERMINAL_PROMPT": "0", "GIT_ASKPASS": "echo"}))
    # 3. the prompt guard WITHOUT the echo askpass
    created.append(attempt("GIT_TERMINAL_PROMPT=0 only", {
        "GIT_TERMINAL_PROMPT": "0"}))
    # 4. an askpass that FAILS, which is what fail-fast actually needs
    created.append(attempt("GIT_TERMINAL_PROMPT=0 + GIT_ASKPASS=/usr/bin/false", {
        "GIT_TERMINAL_PROMPT": "0", "GIT_ASKPASS": "/usr/bin/false"}))
    print()

refs = [":" + r for r in created if r]
if refs:
    subprocess.run(["git", "push", "--quiet", "origin", *refs], cwd=d, check=False, timeout=120)
print("cleanup: deleted", len(refs), "refs")
