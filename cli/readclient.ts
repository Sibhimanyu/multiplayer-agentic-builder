// Reads, as the signed-in user, through the security rules.
//
// `ls` and `members` used the ADMIN SDK, so on a stranger's machine they fell through to
// Application Default Credentials and died with "Could not load the default credentials" -- a
// message about Google's auth library, printed to someone who simply had not run `flotilla login`.
// `new` already took the user's identity; these now take the same path.
//
// WRITES go through the deployed function, because authorization must live where the user cannot
// edit it. READS do not need that: firestore.rules already answers "may this uid see this
// project", and it answers it server-side for exactly the same reason. So reads go straight to
// Firestore over REST carrying the user's ID token, and the rules do the work they were written
// for. The browser does the same thing with the client SDK.
//
// REST rather than adding `firebase` to the package: the client SDK is a large dependency for two
// queries, and the REST surface is stable and needs no bundling.

import { loadCredential, mintIdToken, type StoredCredential } from './auth.ts';
import { NotLoggedIn } from './writeclient.ts';
import type { RoleSlug } from '../shared/store/directory.ts';

/** Firestore REST wraps every scalar in a type tag. Unwrap the handful we read. */
function plain(fields: Record<string, Record<string, unknown>> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields ?? {})) {
    if ('stringValue' in v) out[k] = v.stringValue;
    else if ('booleanValue' in v) out[k] = v.booleanValue;
    else if ('integerValue' in v) out[k] = Number(v.integerValue);
    else if ('nullValue' in v) out[k] = null;
    // Arrays and maps are not read by either command; leaving them undefined is better than
    // half-decoding a shape nothing here consumes.
  }
  return out;
}

export interface ReadClientOptions {
  project_id: string;
  api_key: string;
  home?: string;
  fetchImpl?: typeof fetch;
}

export class ReadClient {
  private readonly opts: ReadClientOptions;
  private cred: StoredCredential | null = null;
  private token: { value: string; expires_at: number } | null = null;

  constructor(opts: ReadClientOptions) {
    this.opts = opts;
  }

  /** Mints from the stored refresh token. Throws NotLoggedIn, which is the message a user needs. */
  private async idToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expires_at - 60_000) return this.token.value;
    this.cred ??= await loadCredential(this.opts.home);
    if (!this.cred) throw new NotLoggedIn();
    const { id_token, expires_in } = await mintIdToken(this.cred, this.opts.api_key, this.opts.fetchImpl);
    this.token = { value: id_token, expires_at: Date.now() + expires_in * 1000 };
    return id_token;
  }

  private base(): string {
    return `https://firestore.googleapis.com/v1/projects/${this.opts.project_id}/databases/(default)/documents`;
  }

  private async call(url: string, init: RequestInit = {}): Promise<unknown> {
    const doFetch = this.opts.fetchImpl ?? fetch;
    const res = await doFetch(url, {
      ...init,
      headers: { ...(init.headers ?? {}), authorization: `Bearer ${await this.idToken()}`, 'content-type': 'application/json' },
    });
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      // Never String() a transport response and call it a result.
      throw new Error(`Firestore returned a non-JSON body (HTTP ${res.status})`);
    }
    if (res.status === 403) {
      throw new Error(
        'Firestore refused the read. You are signed in but not a member of that project.\n' +
          '  Ask an owner to add you.',
      );
    }
    if (!res.ok) {
      const msg = (body as { error?: { message?: string } })?.error?.message ?? `HTTP ${res.status}`;
      throw new Error(`Firestore read failed: ${msg}`);
    }
    return body;
  }

  /** Projects this user belongs to, via the collection-group query the rules permit. */
  async listProjects(): Promise<{ project_id: string; project_name: string; repo_url: string; role: RoleSlug }[]> {
    const cred = this.cred ?? (await loadCredential(this.opts.home));
    if (!cred) throw new NotLoggedIn();

    const rows = (await this.call(`${this.base()}:runQuery`, {
      method: 'POST',
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: 'members', allDescendants: true }],
          where: {
            fieldFilter: { field: { fieldPath: 'uid' }, op: 'EQUAL', value: { stringValue: cred.uid } },
          },
        },
      }),
    })) as { document?: { name: string; fields?: Record<string, Record<string, unknown>> } }[];

    const out: { project_id: string; project_name: string; repo_url: string; role: RoleSlug }[] = [];
    for (const row of rows) {
      if (!row.document) continue; // runQuery emits a readTime-only row when there are no results
      const m = plain(row.document.fields);
      // Revoked filtered HERE, not in the query: a second `where` makes it composite, and
      // composite collection-group queries need an index deployed before the product works.
      if (m.revoked === true) continue;

      // .../documents/projects/{pid}/members/{uid} -> the project id
      const pid = row.document.name.split('/documents/projects/')[1]?.split('/')[0];
      if (!pid) continue;

      const proj = (await this.call(`${this.base()}/projects/${pid}`)) as {
        fields?: Record<string, Record<string, unknown>>;
      };
      const p = plain(proj.fields);
      out.push({
        project_id: pid,
        project_name: String(p.project_name ?? pid),
        repo_url: String(p.repo_url ?? ''),
        role: (m.role as RoleSlug) ?? 'user',
      });
    }
    return out.sort((a, b) => a.project_id.localeCompare(b.project_id));
  }

  async listMembers(project_id: string): Promise<{ uid: string; role: RoleSlug; label: string; revoked: boolean }[]> {
    const body = (await this.call(`${this.base()}/projects/${project_id}/members`)) as {
      documents?: { name: string; fields?: Record<string, Record<string, unknown>> }[];
    };
    return (body.documents ?? [])
      .map((d) => {
        const m = plain(d.fields);
        const id = d.name.split('/').pop() ?? '';
        return {
          uid: String(m.uid ?? id),
          role: (m.role as RoleSlug) ?? 'user',
          label: String(m.label ?? id),
          revoked: m.revoked === true,
        };
      })
      .sort((a, b) => a.uid.localeCompare(b.uid));
  }
}
