"""Probe: what does api.github.com actually CHARGE?

My G3/G4 instrumentation reported REST CHARGED = 0 for every operation while my
own counter said 7 sent for readSnapshot. Those are two different claims about
the same operation and I will not publish either until I know which is right --
the same reply-vs-durable-state discipline, turned on my own instrument.

Three questions, each answered by moving the live counter:
  1. does /rate_limit itself charge? (if it does, my -1 correction was right;
     if not, my correction was hiding a real charge of exactly 1)
  2. what does an unconditional matching-refs call charge?
  3. what does a conditional call that returns 304 charge?
"""

import subprocess
import urllib.request
import urllib.error

REPO = "Sibhimanyu/inventory-tracker-github"
TOKEN = subprocess.run(["gh", "auth", "token"], capture_output=True, text=True).stdout.strip()
BASE_HEADERS = {
    "Authorization": "Bearer " + TOKEN,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
}


def get(url, extra=None):
    headers = dict(BASE_HEADERS)
    if extra:
        headers.update(extra)
    req = urllib.request.Request(url, headers=headers)
    try:
        res = urllib.request.urlopen(req)
        return res.status, res.headers, res.read()
    except urllib.error.HTTPError as err:
        return err.code, err.headers, err.read()


def remaining():
    # Read the JSON body rather than a header. `dict(res.headers)` preserves
    # original casing, so a lookup by lowercase name silently KeyErrors -- and
    # the body carries the same number as a named field.
    import json
    _, _headers, body = get("https://api.github.com/rate_limit")
    return int(json.loads(body)["resources"]["core"]["remaining"])


print("1. does /rate_limit itself charge?")
a, b, c = remaining(), remaining(), remaining()
print("   three consecutive reads:", a, b, c, "-> charged", a - c, "over 2 intervening reads")
print()

print("2. cost of 10 UNCONDITIONAL matching-refs calls")
before = remaining()
for _ in range(10):
    get("https://api.github.com/repos/" + REPO + "/git/matching-refs/heads/")
after = remaining()
print("   remaining", before, "->", after, "= charged", before - after, "for 10 calls")
print()

print("3. cost of 10 CONDITIONAL calls that return 304")
_, headers, _b = get("https://api.github.com/repos/" + REPO + "/git/matching-refs/heads/")
etag = headers.get("ETag") or headers.get("etag")
before = remaining()
codes = []
for _ in range(10):
    status, _h, _b2 = get(
        "https://api.github.com/repos/" + REPO + "/git/matching-refs/heads/",
        {"If-None-Match": etag},
    )
    codes.append(status)
after = remaining()
print("   statuses", sorted(set(codes)), "remaining", before, "->", after,
      "= charged", before - after, "for 10 calls")
print()

print("4. cost of 10 git/commits reads (the object path readSnapshot uses)")
before = remaining()
for _ in range(10):
    get("https://api.github.com/repos/" + REPO + "/commits/main")
after = remaining()
print("   remaining", before, "->", after, "= charged", before - after, "for 10 calls")
