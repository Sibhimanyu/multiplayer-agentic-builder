"""Delete every refs/agentic/* ref left on the demo repo by an aborted run.

A killed test never reaches its `purge`, so its namespace survives. Standing
rule: delete what I created and nothing else -- this only touches
refs/agentic/*, which is entirely mine.
"""

import subprocess
import sys

REPO = "https://github.com/Sibhimanyu/inventory-tracker-github.git"
KEEP = sys.argv[1] if len(sys.argv) > 1 else ""

out = subprocess.run(
    ["git", "ls-remote", REPO, "refs/agentic/*"],
    capture_output=True, text=True, check=True,
).stdout.strip()

refs = [line.split("\t")[1] for line in out.splitlines() if line]
if KEEP:
    refs = [r for r in refs if "/" + KEEP + "/" not in r]

print("refs to delete:", len(refs))
for i in range(0, len(refs), 40):
    batch = [":" + r for r in refs[i:i + 40]]
    subprocess.run(["git", "push", "--quiet", REPO, *batch], check=False)
    print("  deleted", min(i + 40, len(refs)), "/", len(refs))

after = subprocess.run(
    ["git", "ls-remote", REPO, "refs/agentic/*"],
    capture_output=True, text=True, check=True,
).stdout.strip()
print("remaining refs/agentic/*:", len([l for l in after.splitlines() if l]))
