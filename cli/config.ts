// Which Firebase project this install talks to. ~/.drydock/config.json.
//
// THERE IS NO DEFAULT, AND THAT IS THE POINT. `drydock-cli` is a public package; a fallback to
// whichever project the author happened to build against means a stranger's CLI quietly writes
// into someone else's database, and they would never see an error telling them so. Unconfigured
// FAILS, naming the command to run.
//
// EVERYTHING DERIVES FROM THE PROJECT ID. The function URL is computed, not stored, so it cannot
// drift out of step with the project it is supposed to belong to -- a second constant is a
// second thing to forget. The web API key is the one value that cannot be computed (it is issued
// by Firebase, not derived), so `drydock init` FETCHES it from the named project and stores it
// alongside. That is still deriving it from the project id; it is just a lookup rather than
// arithmetic.
//
// The web API key is public by design: it identifies a project and authorises nothing. Storing
// it in a config file is correct, which is why this file is 0644 while credentials.json is 0600.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const configPath = (home = os.homedir()): string =>
  path.join(home, '.drydock', 'config.json');

export interface DrydockConfig {
  project_id: string;
  /** Public web config. Identifies the project; authorises nothing. */
  api_key: string;
  /** Where the functions live. Only ever non-default if someone deploys elsewhere. */
  region: string;
}

export class NotConfigured extends Error {
  constructor(detail: string) {
    super(
      `${detail}\n\n` +
        '  Run:  drydock init --project <firebase-project-id>\n' +
        '  Or:   DRYDOCK_PROJECT=<id> drydock ...\n\n' +
        'There is no default project: drydock-cli is a public package, and silently\n' +
        'writing into whichever project it was built against would be worse than failing.',
    );
    this.name = 'NotConfigured';
  }
}

/** The write function's URL, DERIVED. Never stored, so it cannot disagree with project_id. */
export const writeUrl = (cfg: Pick<DrydockConfig, 'project_id' | 'region'>): string =>
  `https://${cfg.region}-${cfg.project_id}.cloudfunctions.net/write`;

/** The hosted board, also derived. */
export const boardUrl = (cfg: Pick<DrydockConfig, 'project_id'>): string =>
  `https://${cfg.project_id}.web.app`;

export async function loadConfig(home = os.homedir()): Promise<DrydockConfig> {
  // The env override wins, for CI and for anyone running against two projects at once. It still
  // needs an api_key, which comes from the stored config when present.
  const override = process.env.DRYDOCK_PROJECT;
  let stored: Partial<DrydockConfig> = {};
  try {
    stored = JSON.parse(await fs.readFile(configPath(home), 'utf8')) as Partial<DrydockConfig>;
  } catch {
    if (!override) throw new NotConfigured('drydock is not configured.');
  }

  const project_id = override ?? stored.project_id;
  if (!project_id) throw new NotConfigured('No project id in ~/.drydock/config.json.');

  const api_key = process.env.DRYDOCK_API_KEY ?? stored.api_key;
  if (!api_key) {
    throw new NotConfigured(
      `No web API key for "${project_id}". It is public config, not a secret, but it cannot be derived.`,
    );
  }
  // Warn-free but honest: if the override names a different project than the stored key belongs
  // to, the caller has said which project they mean and the key is theirs to get right.
  return { project_id, api_key, region: stored.region ?? 'us-central1' };
}

export async function saveConfig(cfg: DrydockConfig, home = os.homedir()): Promise<string> {
  const dir = path.dirname(configPath(home));
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = configPath(home);
  // 0644, not 0600: nothing here is secret, and pretending otherwise teaches the wrong lesson
  // about which file in this directory actually matters.
  await fs.writeFile(file, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o644 });
  return file;
}

/**
 * Look the web API key up FROM the project id, WITHOUT ANY CREDENTIALS.
 *
 * `drydock init` runs BEFORE `drydock login`, by definition -- it records which project to talk
 * to, which is the thing login needs in order to know where to sign in. So it cannot require a
 * credential, and the first version did: it called the Firebase Management API through
 * Application Default Credentials, which every developer on this machine happens to have and no
 * stranger does. It died with "Could not load the default credentials" and wrote no config.
 *
 * Firebase Hosting serves the web config at a RESERVED, PUBLIC url on every project that has
 * hosting: `/__/firebase/init.json`. That is genuinely deriving the key from the project id --
 * no token, no SDK, one GET.
 *
 * If a project has no hosting, there is nothing public to read and `--api-key` is required. That
 * is stated in the error rather than left for the user to infer.
 */
export async function fetchApiKey(
  project_id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  // Both hosting domains, because a project may have one and not the other.
  const urls = [
    `https://${project_id}.web.app/__/firebase/init.json`,
    `https://${project_id}.firebaseapp.com/__/firebase/init.json`,
  ];
  const tried: string[] = [];
  for (const url of urls) {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) { tried.push(`${url} -> HTTP ${res.status}`); continue; }
      const body = (await res.json()) as { apiKey?: string; projectId?: string };
      // Not "it did not throw": a 200 with no key would store an empty string and fail much
      // later, at sign-in, looking like an auth problem rather than a setup one.
      if (!body.apiKey) { tried.push(`${url} -> no apiKey in the response`); continue; }
      // And the config must belong to the project that was ASKED for. A hosting domain that
      // redirects elsewhere would otherwise silently configure the wrong project.
      if (body.projectId && body.projectId !== project_id) {
        tried.push(`${url} -> config is for "${body.projectId}", not "${project_id}"`);
        continue;
      }
      return body.apiKey;
    } catch (err) {
      tried.push(`${url} -> ${(err as Error).name}`);
    }
  }
  throw new Error(
    `Could not read the public web config for "${project_id}".\n` +
      tried.map((t) => `    ${t}`).join('\n') +
      '\n\n  Pass it explicitly:\n' +
      `    drydock init --project ${project_id} --api-key <key>\n\n` +
      '  The key is on the Firebase console under Project settings > General > Web API Key.\n' +
      '  It is public configuration, not a secret.',
  );
}
