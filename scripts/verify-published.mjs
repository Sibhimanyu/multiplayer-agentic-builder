// Assert that the PUBLISHED install path actually works. Run after every hosting deploy.
//
// WHY A STATUS CODE IS NOT ENOUGH, and why this script exists at all:
// hosting's catch-all rewrite (`**` -> /index.html) answers every missing path with HTTP 200 and
// an HTML body. So `curl -o /dev/null -w '%{http_code}' .../install.sh` printed 200 for a full day
// while the file did not exist and `curl ... | sh` died on `<!DOCTYPE html>`. The status code was
// a true signal about the wrong subject.
//
// Everything here checks BYTES, not status.

const BASE = process.env.FLOTILLA_BASE ?? 'https://multiplayer-agents-eec02.web.app';
const VERSION = JSON.parse(
  await (await import('node:fs/promises')).readFile(
    new URL('../packaging/package.json', import.meta.url), 'utf8',
  ),
).version;

const checks = [
  {
    path: '/install.sh',
    what: 'the curl installer',
    verify: (buf, ct) => {
      const head = buf.subarray(0, 64).toString('utf8');
      if (/text\/html/.test(ct)) return `content-type is ${ct} — the SPA rewrite served index.html`;
      if (!head.startsWith('#!')) return `body starts with ${JSON.stringify(head.slice(0, 24))}, not a shebang`;
      return null;
    },
  },
  {
    path: `/flotilla-cli-${VERSION}.tgz`,
    what: 'the CLI tarball',
    verify: (buf, ct) => {
      if (/text\/html/.test(ct)) return `content-type is ${ct} — the SPA rewrite served index.html`;
      // gzip magic. An HTML body starts with '<' (0x3c), which is exactly the case that hid.
      if (!(buf[0] === 0x1f && buf[1] === 0x8b)) {
        return `body starts with 0x${buf[0]?.toString(16)} 0x${buf[1]?.toString(16)}, not gzip (1f 8b)`;
      }
      return null;
    },
  },
];

let failed = 0;
for (const c of checks) {
  const url = `${BASE}${c.path}`;
  let line;
  try {
    const res = await fetch(url, { cache: 'no-store' });
    const buf = Buffer.from(await res.arrayBuffer());
    const ct = res.headers.get('content-type') ?? '';
    const problem = c.verify(buf, ct);
    line = problem
      ? `FAIL  ${c.path} — ${c.what}: ${problem}`
      : `PASS  ${c.path} — ${c.what}, ${buf.length} bytes, ${ct.split(';')[0]}`;
    if (problem) failed += 1;
  } catch (err) {
    line = `FAIL  ${c.path} — ${c.what}: ${err.message}`;
    failed += 1;
  }
  console.log(`  ${line}`);
}

if (failed > 0) {
  console.error(`\nverify-published: ${failed} of ${checks.length} published artifacts are broken.`);
  console.error('The README\'s curl one-liner does not work right now. Run: node scripts/build-cli.mjs && firebase deploy --only hosting');
  process.exit(1);
}
console.log(`\nverify-published: the published install path works (${BASE}).`);
