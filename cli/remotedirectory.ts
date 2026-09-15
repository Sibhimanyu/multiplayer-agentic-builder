// createProject through the deployed write function, carrying the USER'S token.
//
// Not the Admin SDK. `drydock new` is the first real command a stranger runs, and the Admin SDK
// needs a service-account key that only the project's owner has -- so the previous version died
// with "Could not load the default credentials" on step one, for everyone except the person who
// built it. Every test before the stranger test had that key in the environment.
//
// Project creation still needs the LOCAL half -- detecting the repo, writing .agentic/, and
// generating role packs all need the working tree -- so it stays in the CLI. Only the WRITE
// crosses to the server, where authorization lives.

import type { CreateProjectInput, ProjectRecord } from '../shared/store/directory.ts';
import { ProjectExistsError } from '../shared/store/directory.ts';
import type { WriteClient } from './writeclient.ts';

/**
 * Just enough of ProjectDirectory for newProject.
 *
 * Deliberately not the whole interface: the browser lists and reads, the CLI creates, and
 * neither needs all seven operations. Implementing five methods that throw would suggest they
 * exist.
 */
export class RemoteDirectory {
  private readonly client: WriteClient;
  // A plain field, not a parameter property: the build runs with erasableSyntaxOnly, which
  // rejects `constructor(private readonly x)` because erasing the type would change behaviour.
  constructor(client: WriteClient) {
    this.client = client;
  }

  async createProject(input: CreateProjectInput): Promise<ProjectRecord> {
    const r = await this.client.write(input.project_id, 'create_project', {
      project_name: input.project_name,
      repo_url: input.repo_url,
      owner_label: input.owner_label,
      // owner_uid is deliberately NOT sent. The server takes it from the verified token, so a
      // caller cannot create a project owned by somebody else. Sending it would imply it matters.
    });

    if (r.status === 409) throw new ProjectExistsError(input.project_id);
    if (!r.ok) {
      throw new Error(
        `could not create the project (HTTP ${r.status}): ${String(r.body.error ?? 'unknown')}`,
      );
    }
    // Not "it did not throw": a 200 without a project record means the server did something
    // other than what was asked, and the scaffold that follows would be for nothing.
    const rec = r.body.project as ProjectRecord | undefined;
    if (!rec?.project_id) {
      throw new Error('the write API returned no project record; refusing to scaffold');
    }
    return rec;
  }
}
