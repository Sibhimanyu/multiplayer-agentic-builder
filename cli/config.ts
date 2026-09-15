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
 * Look the web API key up FROM the project, so the caller supplies one identifier rather than two.
 *
 * Uses the Firebase Management API, which needs credentials the project owner has and a stranger
 * does not -- so `--api-key` stays available for anyone configuring a project they do not
 * administer. Both paths end at the same stored value.
 */
export async function fetchApiKey(
  project_id: string,
  access_token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const res = await fetchImpl(
    `https://firebase.googleapis.com/v1beta1/projects/${project_id}/webApps/-/config`,
    { headers: { Authorization: `Bearer ${access_token}` } },
  );
  if (!res.ok) {
    throw new Error(
      `could not read the web config for "${project_id}" (HTTP ${res.status}). ` +
        'Pass --api-key instead; it is on the Firebase console under Project settings.',
    );
  }
  const body = (await res.json()) as { apiKey?: string };
  // Not "it did not throw": a 200 with no key would store an empty string and fail much later,
  // at sign-in, looking like an auth problem.
  if (!body.apiKey) throw new Error(`the web config for "${project_id}" contained no apiKey`);
  return body.apiKey;
}
