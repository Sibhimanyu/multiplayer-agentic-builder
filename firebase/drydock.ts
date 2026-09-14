// `drydock` — the runnable CLI entry point. Owns the SDK import so cli/ does not have to.
//
//   node firebase/drydock.ts new <name> [--repo owner/repo]   create a project here
//   node firebase/drydock.ts ls [--uid <uid>]                 projects you are a member of
//   node firebase/drydock.ts members <project_id>             the roster
//
// Same split as firebase/bridge-run.ts: constructing the directory means importing
// firebase-admin, and that is exactly what cli/ must not do. The module graph enforces it --
// firebase-admin does not resolve from cli/ at all.

import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

import { createFirestoreDirectory } from './directory.ts';
import { newProject } from '../cli/newproject.ts';
import { ProjectExistsError } from '../shared/store/directory.ts';
import { consoleLogger } from '../shared/log.ts';

const FB_PROJECT = process.env.FB_PROJECT_ID ?? 'multiplayer-agents-eec02';
const ROOT = process.env.BUILDER_ROOT ?? process.cwd();

const USAGE = `drydock — the project tier

  drydock new <name> [--repo owner/repo]   create a project in this repo
  drydock ls [--uid <uid>]                 projects you are a member of
  drydock members <project_id>             the roster

The CLI creates projects and the browser lists them: creating one connects a repo, writes
.agentic/ and generates role packs, none of which a browser can do.
`;

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

const connect = () => {
  const app = initializeApp({ projectId: FB_PROJECT }, `drydock-${Date.now()}`);
  const directory = createFirestoreDirectory({ db: getFirestore(app), log: consoleLogger });
  return { directory, close: () => deleteApp(app) };
};

const [cmd, arg] = process.argv.slice(2);

if (cmd === 'new') {
  if (!arg) {
    console.error('usage: drydock new <name> [--repo owner/repo]');
    process.exit(1);
  }
  const { directory, close } = connect();
  try {
    const r = await newProject({
      root: ROOT,
      name: arg,
      directory,
      // The owner uid. In the browser this is the anonymous uid; from the CLI it is whoever is
      // running it, which is the machine's user until the connect flow exists.
      owner_uid: flag('uid') ?? process.env.DRYDOCK_UID ?? `uid_${process.env.USER ?? 'local'}`,
      owner_label: process.env.USER ?? 'owner',
      repo_url: flag('repo'),
      log: consoleLogger,
    });
    console.log(`\ncreated ${r.project_id}`);
    console.log(`  name       ${r.project_name}`);
    console.log(`  repo       ${r.repo_url}`);
    console.log(`  scaffold   ${r.agentic_dir}/project.json`);
    console.log(`  role packs ${r.role_packs.length}: ${r.role_packs.map((p) => p.split('/').pop()).join(', ')}`);
    console.log(`\nopen it at /p/${r.project_id}`);
  } catch (err) {
    if (err instanceof ProjectExistsError) {
      // The intended outcome for two clones of one repo, so it reads as information not a crash.
      console.error(`\n${err.project_id} already exists.`);
      console.error('Two clones of the same repo are one project — ask an owner to add you:');
      console.error(`  drydock members ${err.project_id}`);
    } else {
      console.error(`\n${String(err instanceof Error ? err.message : err)}`);
    }
    await close();
    process.exit(1);
  }
  await close();
} else if (cmd === 'ls') {
  const { directory, close } = connect();
  const uid = flag('uid') ?? process.env.DRYDOCK_UID ?? `uid_${process.env.USER ?? 'local'}`;
  const projects = await directory.listProjects(uid);
  if (projects.length === 0) {
    console.log(`no projects for ${uid}. Run \`drydock new <name>\` in your repo.`);
  } else {
    console.log(`projects for ${uid}:\n`);
    for (const p of projects) console.log(`  ${p.role.padEnd(9)} ${p.project_id.padEnd(28)} ${p.repo_url}`);
  }
  await close();
} else if (cmd === 'members') {
  if (!arg) {
    console.error('usage: drydock members <project_id>');
    process.exit(1);
  }
  const { directory, close } = connect();
  const members = await directory.listMembers(arg);
  if (members.length === 0) console.log(`no members, or ${arg} does not exist.`);
  for (const m of members) {
    console.log(`  ${m.role.padEnd(9)} ${m.uid.padEnd(24)} ${m.label}${m.revoked ? '  (revoked)' : ''}`);
  }
  await close();
} else {
  console.log(USAGE);
  process.exit(cmd ? 1 : 0);
}
