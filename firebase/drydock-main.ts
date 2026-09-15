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

import { spawn } from 'node:child_process';

import { main, registerAuthCommands, registerProjectCommands } from '../cli/index.ts';
import { newProject } from '../cli/newproject.ts';
import { boardUrl, fetchApiKey, loadConfig, saveConfig, writeUrl } from '../cli/config.ts';
import { loginUrl, loopbackReady, saveCredential, startLoopback } from '../cli/auth.ts';
import { createFirestoreDirectory } from './directory.ts';
import { ProjectExistsError } from '../shared/store/directory.ts';
import { consoleLogger } from '../shared/log.ts';

// NO BAKED-IN PROJECT ID. It used to read `?? 'multiplayer-agents-eec02'`, which compiled one
// person's Firebase project into a public package -- found by grepping the BUILT BUNDLE, not the
// source, which is the only place it was visible. drydock/packtest.mjs now asserts its absence
// there for the same reason.
const uid = () => process.env.DRYDOCK_UID ?? `uid_${process.env.USER ?? 'local'}`;

async function connect() {
  const cfg = await loadConfig();
  const app = initializeApp({ projectId: cfg.project_id }, `drydock-${Date.now()}`);
  const directory = createFirestoreDirectory({ db: getFirestore(app), log: consoleLogger });
  return { cfg, directory, close: () => deleteApp(app) };
}

registerAuthCommands({
  /**
   * `drydock init --project <id>` — the one identifier a user supplies.
   *
   * The web API key is looked up FROM that project rather than asked for, so there is no second
   * constant to get wrong. `--api-key` stays for anyone configuring a project they do not
   * administer, since the lookup needs owner credentials and the key itself is public.
   */
  async init(project_id, api_key_flag) {
    let api_key = api_key_flag;
    if (!api_key) {
      try {
        const probe = initializeApp({ projectId: project_id }, `init-${Date.now()}`);
        const token = await probe.options.credential?.getAccessToken?.();
        api_key = await fetchApiKey(project_id, token?.access_token ?? '');
        await deleteApp(probe);
      } catch (err) {
        console.error(`\n${err instanceof Error ? err.message : String(err)}`);
        return 1;
      }
    }
    const cfg = { project_id, api_key, region: 'us-central1' };
    const file = await saveConfig(cfg);
    console.log(`configured ${project_id}`);
    console.log(`  config     ${file}`);
    console.log(`  write url  ${writeUrl(cfg)}`);
    console.log(`  board      ${boardUrl(cfg)}`);
    console.log('\nNext:  drydock login');
    return 0;
  },

  /**
   * `drydock login` — the loopback flow, now with a real provider.
   *
   * GOOGLE by default; `--anonymous` keeps the disposable path working, because that is what
   * lets someone open the board, see the denied state and read their own uid off the screen
   * before anyone has admitted them. Both land in the same credential store.
   *
   * The nonce handling is unchanged and deliberately so: a bad nonce is refused, logged, and NOT
   * fatal, because aborting would let any page the user visits kill a login in progress.
   */
  async login(anonymous) {
    let cfg;
    try {
      cfg = await loadConfig();
    } catch (err) {
      console.error(`\n${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }

    const lb = startLoopback({ log: consoleLogger, timeout_ms: 300_000 });
    const port = await loopbackReady(lb);
    const url = `${loginUrl(boardUrl(cfg), port, lb.nonce)}&provider=${anonymous ? 'anonymous' : 'google'}`;

    console.log(`\nOpen this in your browser to sign in${anonymous ? ' (anonymous)' : ' with Google'}:\n`);
    console.log(`  ${url}\n`);
    // Best effort. If it fails the URL is already printed, which is the actual instruction.
    spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore' })
      .on('error', () => {});

    try {
      const cred = await lb.result;
      const file = await saveCredential({
        refresh_token: cred.refresh_token, uid: cred.uid, email: cred.email,
        project_id: cfg.project_id, obtained_at: new Date().toISOString(),
      });
      console.log(`signed in as ${cred.email ?? cred.uid}`);
      console.log(`  uid         ${cred.uid}`);
      console.log(`  credential  ${file} (0600)`);
      return 0;
    } catch (err) {
      console.error(`\n${err instanceof Error ? err.message : String(err)}`);
      return 1;
    } finally {
      lb.close();
    }
  },
});

registerProjectCommands({
  async new(root, name, repo) {
    const { directory, close } = await connect();
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
    const { directory, close } = await connect();
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
    const { directory, close } = await connect();
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
