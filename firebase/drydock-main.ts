// The `drydock` binary's entry point. Order 0048.
//
// This is the COMPOSITION ROOT: the one place allowed to import a backend SDK and hand the
// resulting ports to code that only knows the interfaces. cli/index.ts routes `new`, `ls` and
// `members` through registerProjectCommands and never learns what is behind them, which is the
// same boundary firebase/bridge-run.ts holds for the bridge.
//
// Built to plain JS by drydock/build.mjs. An installed user has no TypeScript loader, so the
// shipped artifact is a bundle -- shared/** and cli/** are compiled in, and firebase-admin stays
// external because it is a real dependency with native pieces.

import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

import { main, registerProjectCommands } from '../cli/index.ts';
import { newProject } from '../cli/newproject.ts';
import { createFirestoreDirectory } from './directory.ts';
import { ProjectExistsError } from '../shared/store/directory.ts';
import { consoleLogger } from '../shared/log.ts';

const FB_PROJECT = process.env.FB_PROJECT_ID ?? 'multiplayer-agents-eec02';
const uid = () => process.env.DRYDOCK_UID ?? `uid_${process.env.USER ?? 'local'}`;

function connect() {
  const app = initializeApp({ projectId: FB_PROJECT }, `drydock-${Date.now()}`);
  const directory = createFirestoreDirectory({ db: getFirestore(app), log: consoleLogger });
  return { directory, close: () => deleteApp(app) };
}

registerProjectCommands({
  async new(root, name, repo) {
    const { directory, close } = connect();
    try {
      const r = await newProject({
        root, name, directory, owner_uid: uid(), owner_label: process.env.USER ?? 'owner',
        repo_url: repo, log: consoleLogger,
      });
      console.log(`\ncreated ${r.project_id}`);
      console.log(`  name       ${r.project_name}`);
      console.log(`  repo       ${r.repo_url}`);
      console.log(`  scaffold   ${r.agentic_dir}/project.json`);
      console.log(`  role packs ${r.role_packs.length}`);
      console.log(`\nopen it at /p/${r.project_id}`);
      return 0;
    } catch (err) {
      // Two clones of one repo are ONE project, so a collision is information rather than a
      // crash -- it tells the second person what to ask for.
      if (err instanceof ProjectExistsError) {
        console.error(`\n${err.project_id} already exists.`);
        console.error(`Two clones of the same repo are one project. Ask an owner to add you:`);
        console.error(`  drydock members ${err.project_id}`);
      } else {
        console.error(`\n${err instanceof Error ? err.message : String(err)}`);
      }
      return 1;
    } finally {
      await close();
    }
  },

  async ls() {
    const { directory, close } = connect();
    try {
      const projects = await directory.listProjects(uid());
      if (projects.length === 0) {
        console.log(`no projects for ${uid()}. Run \`drydock new <name>\` in your repo.`);
      } else {
        console.log(`projects for ${uid()}:\n`);
        for (const p of projects) {
          console.log(`  ${p.role.padEnd(9)} ${p.project_id.padEnd(28)} ${p.repo_url}`);
        }
      }
      return 0;
    } finally {
      await close();
    }
  },

  async members(project_id) {
    const { directory, close } = connect();
    try {
      const members = await directory.listMembers(project_id);
      if (members.length === 0) console.log(`no members, or ${project_id} does not exist.`);
      for (const m of members) {
        console.log(`  ${m.role.padEnd(9)} ${m.uid.padEnd(24)} ${m.label}${m.revoked ? '  (revoked)' : ''}`);
      }
      return 0;
    } finally {
      await close();
    }
  },
});

process.exitCode = await main(process.argv.slice(2));
