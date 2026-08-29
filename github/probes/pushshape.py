"""Which push SHAPE wedges?

Right now, on this machine, in this minute:
  - a one-ref push with one lease:  1.77-1.97 s, rc=0, every time (pushtime.py)
  - A5's pushes:                    wedge until the 45 s deadline kills them

A5's push is not the same shape. It sends TWO refs with TWO create-if-absent
leases under --atomic, and one of those refs has a 64-hex name. So rather than
conclude "the network is bad" -- which the control above already contradicts --
this varies the shape one axis at a time.

Each variant is timed with a hard deadline, so a wedge is reported rather than
waited on.
"""

import subprocess
import tempfile
import time

REPO = "https://github.com/Sibhimanyu/inventory-tracker-github.git"
NS = "refs/agentic/pushshape"
TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
DEADLINE = 30

d = tempfile.mkdtemp(prefix="pushshape-")


def run(args, timeout=None):
    return subprocess.run(args, cwd=d, capture_output=True, text=True, timeout=timeout)


run(["git", "init", "--quiet"])
run(["git", "config", "user.email", "p@example.invalid"])
run(["git", "config", "user.name", "p"])
run(["git", "remote", "add", "origin", REPO])


def obj(msg):
    return run(["git", "commit-tree", TREE, "-m", msg]).stdout.strip()


def attempt(label, args):
    t0 = time.time()
    try:
        r = run(["git", "push", "--porcelain", *args], timeout=DEADLINE)
        ms = round((time.time() - t0) * 1000)
        print("  %-46s %6d ms  rc=%s" % (label, ms, r.returncode))
        return True
    except subprocess.TimeoutExpired:
        print("  %-46s  WEDGED (killed at %ds)" % (label, DEADLINE))
        return False


LONG = "0df78f2271a8125da7438ab7481d4d05050a44d847f73d31d899099986d1643a"

print("varying one axis at a time, 3 samples each:\n")

for i in range(3):
    a = obj("shape a %d" % i)
    b = obj("shape b %d" % i)
    n = str(i)

    print("round", i)
    # 1. one ref, one lease, atomic -- the control that is known healthy
    r1 = NS + "/one" + n
    attempt("1 ref  + 1 lease  + --atomic", [
        "--atomic", "--force-with-lease=" + r1 + ":", "origin", a + ":" + r1])

    # 2. two refs, two leases, atomic -- EXACTLY A5's shape
    r2a = NS + "/ev" + n
    r2b = NS + "/dedupe" + n + LONG
    attempt("2 refs + 2 leases + --atomic  (A5's shape)", [
        "--atomic",
        "--force-with-lease=" + r2a + ":",
        "--force-with-lease=" + r2b + ":",
        "origin", a + ":" + r2a, b + ":" + r2b])

    # 3. two refs, two leases, NO --atomic -- isolates --atomic
    r3a = NS + "/na" + n
    r3b = NS + "/nb" + n
    attempt("2 refs + 2 leases + no --atomic", [
        "--force-with-lease=" + r3a + ":",
        "--force-with-lease=" + r3b + ":",
        "origin", a + ":" + r3a, b + ":" + r3b])

    # 4. two refs, NO leases, atomic -- isolates the leases
    r4a = NS + "/la" + n
    r4b = NS + "/lb" + n
    attempt("2 refs + 0 leases + --atomic", [
        "--atomic", "origin", a + ":" + r4a, b + ":" + r4b])

    # 5. one ref with the LONG name -- isolates ref-name length
    r5 = NS + "/long" + n + LONG
    attempt("1 ref  + 1 lease  + --atomic (64-hex name)", [
        "--atomic", "--force-with-lease=" + r5 + ":", "origin", a + ":" + r5])
    print()

print("cleanup:")
out = run(["git", "ls-remote", "origin", NS + "/*"]).stdout
refs = [":" + line.split("\t")[1] for line in out.splitlines() if line]
for i in range(0, len(refs), 40):
    run(["git", "push", "--quiet", "origin", *refs[i:i + 40]], timeout=60)
print("  deleted", len(refs), "refs")
