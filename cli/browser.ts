// Opening the user's browser. Order 0060.
//
// This lived as three inline lines in firebase/flotilla-main.ts, which meant the only thing any
// test could observe was "a process was spawned". THE BUG THIS GUARDS AGAINST IS NOT "no browser
// opened" -- it is "the user ended up on a different page than the one we serve". A test that
// checks spawn was called would pass while the CLI handed it the hosted URL, which is the page
// Safari's ITP breaks. So the URL is the thing worth isolating and asserting.
//
// Windows was never handled: the old code chose between `open` and `xdg-open` and gave a win32
// user xdg-open, which does not exist there.
//
// Launch failure was swallowed outright (`.on('error', () => {})`). A user whose launcher is
// missing then watches a terminal that looks like it is waiting on them, with no hint that the
// browser was supposed to appear. It is reported now, and the URL is always printed either way.

import { spawn } from 'node:child_process';

export interface LaunchOutcome {
  /** Did the OS actually start the launcher? */
  ok: boolean;
  /** What was run, for the message shown when it did not work. */
  command: string;
  /** The URL handed to the launcher, verbatim. */
  url: string;
  error?: string;
}

/**
 * How to ask each platform to open a URL.
 *
 * Separated from the spawning so all three can be asserted on a machine that is only one of them.
 *
 * win32 goes through `cmd /c start`, and the empty `""` argument is not a typo: `start` treats a
 * lone quoted argument as the WINDOW TITLE, so without a placeholder a quoted URL is swallowed as
 * a title and nothing opens.
 */
export function browserCommand(platform: NodeJS.Platform, url: string): { command: string; args: string[] } {
  if (platform === 'darwin') return { command: 'open', args: [url] };
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '""', url] };
  return { command: 'xdg-open', args: [url] };
}

/**
 * Open `url` in whatever the user considers their browser.
 *
 * DETACHED and unref'd: the launcher outlives this command, and on some platforms it is a
 * long-lived process. Holding a handle to it would keep node alive after the login finished.
 *
 * Resolves once the OS has told us whether the spawn worked, so the caller can say so. It never
 * rejects and never throws -- a browser that will not start is a worse login, not a failed one,
 * and the printed URL is the fallback.
 */
export function openBrowser(
  url: string,
  opts: { platform?: NodeJS.Platform; spawnImpl?: typeof spawn } = {},
): Promise<LaunchOutcome> {
  const platform = opts.platform ?? process.platform;
  const { command, args } = browserCommand(platform, url);
  const spawnFn = opts.spawnImpl ?? spawn;

  return new Promise((resolve) => {
    let settled = false;
    const done = (outcome: LaunchOutcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    try {
      const child = spawnFn(command, args, { stdio: 'ignore', detached: true });
      child.on('error', (err: Error) => done({ ok: false, command, url, error: err.message }));
      // 'spawn' fires only once the process has actually been started by the OS.
      child.on('spawn', () => {
        child.unref();
        done({ ok: true, command, url });
      });
      // A launcher that neither starts nor errors must not hang the login behind it.
      setTimeout(() => done({ ok: true, command, url }), 2_000).unref?.();
    } catch (err) {
      done({ ok: false, command, url, error: (err as Error).message });
    }
  });
}
