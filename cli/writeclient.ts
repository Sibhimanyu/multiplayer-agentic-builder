// How a teammate's CLI writes: through the function, carrying their own token.
//
// NOT the Admin SDK. A teammate's machine must not hold a service-account key -- that key
// bypasses firestore.rules AND the role gates, so shipping one to every laptop would make the
// permission model decorative. The bridge keeps admin access for what genuinely needs it
// (creating a project is a local act that touches the repo on disk); everything an agent or a
// member does goes through here.
//
// The ID token is minted per call from the stored refresh token and never written to disk.

import { loadCredential, mintIdToken, type StoredCredential } from './auth.ts';
import type { Logger } from '../shared/log.ts';

export class NotLoggedIn extends Error {
  constructor() {
    super('not signed in. Run `drydock login`.');
    this.name = 'NotLoggedIn';
  }
}

export interface WriteClientOptions {
  /** Base URL of the deployed write function. */
  api_url: string;
  /** Public web API key, for the token endpoint. */
  api_key: string;
  log: Logger;
  home?: string;
  fetchImpl?: typeof fetch;
}

export class WriteClient {
  private readonly opts: WriteClientOptions;
  private cred: StoredCredential | null = null;
  /** Cached in memory only, with its expiry. Never persisted. */
  private token: { value: string; expires_at: number } | null = null;

  constructor(opts: WriteClientOptions) {
    this.opts = opts;
  }

  private async idToken(): Promise<string> {
    // 60s of slack: a token that expires in transit produces a 401 that looks like a permissions
    // bug rather than a clock problem.
    if (this.token && Date.now() < this.token.expires_at - 60_000) return this.token.value;

    this.cred ??= await loadCredential(this.opts.home);
    if (!this.cred) throw new NotLoggedIn();

    const { id_token, expires_in } = await mintIdToken(this.cred, this.opts.api_key, this.opts.fetchImpl);
    this.token = { value: id_token, expires_at: Date.now() + expires_in * 1000 };
    return id_token;
  }

  /**
   * One write. Returns the function's decision as data rather than throwing on 403.
   *
   * A role refusal is a NORMAL outcome that the caller must be able to show the user -- the same
   * reason a lost claim is a value rather than an error. Only transport failures throw.
   */
  async write(
    project_id: string,
    op: string,
    body: Record<string, unknown>,
  ): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
    const doFetch = this.opts.fetchImpl ?? fetch;
    const res = await doFetch(this.opts.api_url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${await this.idToken()}`,
      },
      body: JSON.stringify({ project_id, op, body }),
    });

    let parsed: Record<string, unknown>;
    try {
      parsed = (await res.json()) as Record<string, unknown>;
    } catch {
      // Never String() an SDK or transport response and call it a result: a non-JSON body from a
      // proxy or a cold start is a transport failure, not a decision.
      throw new Error(`write API returned a non-JSON body (HTTP ${res.status})`);
    }

    if (res.status === 401) {
      // The refresh token is dead or revoked. Drop the cached ID token so the next call re-mints
      // rather than replaying a token that is already refused.
      this.token = null;
    }
    if (res.status === 403) {
      this.opts.log.warn('cli.write_refused', 'the write was refused by role policy', {
        project_id, op, error: String(parsed.error ?? ''),
      });
    }
    return { ok: res.status >= 200 && res.status < 300, status: res.status, body: parsed };
  }
}
