"""Follow-up: the per-RESPONSE rate-limit headers, which are authoritative.

quota.py said every call charges 0. Probe H, earlier today, measured 10
unconditional 200s costing exactly 10 on the same endpoint. Both cannot be
right about the same token and the same bucket, so this reads the headers each
response actually carries rather than polling /rate_limit separately.

Two candidate explanations, and the headers distinguish them:
  - the calls are charged to a DIFFERENT resource than `core`, so watching
    core shows nothing
  - the token's accounting genuinely changed since probe H
"""

import json
import subprocess
import urllib.request
import urllib.error

REPO = "Sibhimanyu/inventory-tracker-github"
TOKEN = subprocess.run(["gh", "auth", "token"], capture_output=True, text=True).stdout.strip()
HEADERS = {
    "Authorization": "Bearer " + TOKEN,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
}


def call(url, extra=None):
    h = dict(HEADERS)
    if extra:
        h.update(extra)
    req = urllib.request.Request(url, headers=h)
    try:
        res = urllib.request.urlopen(req)
        return res.status, res.headers
    except urllib.error.HTTPError as err:
        return err.code, err.headers


def rl(headers):
    return (
        headers.get("X-RateLimit-Resource"),
        headers.get("X-RateLimit-Limit"),
        headers.get("X-RateLimit-Remaining"),
        headers.get("X-RateLimit-Used"),
    )


print("token prefix:", TOKEN[:4] + "..." if TOKEN else "(none)")
print()

print("per-response headers on 5 consecutive UNCONDITIONAL matching-refs calls:")
for i in range(5):
    status, headers = call(
        "https://api.github.com/repos/" + REPO + "/git/matching-refs/heads/")
    resource, limit, remaining, used = rl(headers)
    print("  call", i, "HTTP", status, "resource=", resource,
          "limit=", limit, "remaining=", remaining, "used=", used)
print()

print("per-response headers on 5 consecutive /commits calls:")
for i in range(5):
    status, headers = call("https://api.github.com/repos/" + REPO + "/commits/main")
    resource, limit, remaining, used = rl(headers)
    print("  call", i, "HTTP", status, "resource=", resource,
          "limit=", limit, "remaining=", remaining, "used=", used)
print()

print("and what /rate_limit reports for every resource whose remaining != limit:")
status, headers = call("https://api.github.com/rate_limit")
req = urllib.request.Request("https://api.github.com/rate_limit", headers=HEADERS)
body = json.loads(urllib.request.urlopen(req).read())
for name, v in sorted(body["resources"].items()):
    if v["remaining"] != v["limit"]:
        print("  ", name, v)
print("  (nothing listed above means no bucket has been drawn down at all)")
