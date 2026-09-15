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

import { spawn } from 'node:child_process';

import { main, registerAuthCommands, registerProjectCommands } from '../cli/index.ts';
import { newProject } from '../cli/newproject.ts';
import { boardUrl, fetchApiKey, loadConfig, saveConfig, writeUrl } from '../cli/config.ts';
import { loginUrl, loopbackReady, saveCredential, startLoopback } from '../cli/auth.ts';
import { WriteClient } from '../cli/writeclient.ts';
import { RemoteDirectory } from '../cli/remotedirectory.ts';
import { ReadClient } from '../cli/readclient.ts';
import { ProjectExistsError } from '../shared/store/directory.ts';
import { consoleLogger } from '../shared/log.ts';

// NO BAKED-IN PROJECT ID. It used to read `?? 'multiplayer-agents-eec02'`, which compiled one
// person's Firebase project into a public package -- found by grepping the BUILT BUNDLE, not the
// source, which is the only place it was visible. drydock/packtest.mjs now asserts its absence
// there for the same reason.
const uid = () => process.env.DRYDOCK_UID ?? `uid_${process.env.USER ?? 'local'}`;

// NO ADMIN SDK PATH REMAINS IN THIS BINARY.
//
// There used to be a `connect()` helper here that built an admin Firestore client. Making its
// import lazy stopped `init` and `login` from reaching for Application Default Credentials, but
// `ls` and `members` still called it -- so on a stranger's machine they printed "Could not load
// the default credentials", a message about Google's auth library shown to someone whose actual
// problem was that they had not run `drydock login`.
//
// Deleting it rather than fixing its callers is deliberate: while the helper existed, the next
// command added would reach for it too, and the bug would come back wearing a different name.
// Every command now takes the user's identity -- writes through the deployed function, reads
// through firestore.rules -- and there is no third path to fall into.

registerAuthCommands({
  /**
   * `drydock init --project <id>` — the one identifier a user supplies.
   *
   * The web API key is looked up FROM that project rather than asked for, so there is no second
   * constant to get wrong. `--api-key` stays for anyone configuring a project they do not
   * administer, since the lookup needs owner credentials and the key itself is public.
   */
  async init(project_id, api_key_flag) {
    // NO CREDENTIALS, NO SDK. init runs before login by definition; requiring a token to record
    // a project id is a circular dependency that only works on a machine that already has one.
    let api_key = api_key_flag;
    if (!api_key) {
      try {
        api_key = await fetchApiKey(project_id);
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
    // THROUGH THE WRITE FUNCTION, with the user's own token. Not the Admin SDK: a stranger has a
    // user credential from `drydock login` and no service-account key, and this is the first
    // real command they run.
    const cfg = await loadConfig();
    const client = new WriteClient({
      api_url: writeUrl(cfg), api_key: cfg.api_key, log: consoleLogger,
    });
    const directory = new RemoteDirectory(client);
    const close = async () => {};
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

  // AS THE SIGNED-IN USER, through the security rules -- not the Admin SDK.
  //
  // These two used connect(), which builds an admin client and therefore reaches for Application
  // Default Credentials. On a stranger's machine that produced "Could not load the default
  // credentials" instead of "not signed in", which is a message about Google's auth library shown
  // to someone whose actual problem was that they had not run `drydock login`.
  async ls() {
    const cfg = await loadConfig();
    const projects = await new ReadClient({ project_id: cfg.project_id, api_key: cfg.api_key })
      .listProjects();
    if (projects.length === 0) {
      console.log('no projects yet. Run `drydock new <name>` in your repo.');
    } else {
      console.log('your projects:\n');
      for (const p of projects) {
        console.log(`  ${p.role.padEnd(9)} ${p.project_id.padEnd(28)} ${p.repo_url}`);
      }
    }
    return 0;
  },

  async members(project_id) {
    const cfg = await loadConfig();
    const members = await new ReadClient({ project_id: cfg.project_id, api_key: cfg.api_key })
      .listMembers(project_id);
    if (members.length === 0) console.log(`no members, or ${project_id} does not exist.`);
    for (const m of members) {
      console.log(`  ${m.role.padEnd(9)} ${m.uid.padEnd(24)} ${m.label}${m.revoked ? '  (revoked)' : ''}`);
    }
    return 0;
  },
});

/**
 * ONE CLEAN LINE, NOT A CRASH DUMP.
 *
 * An unconfigured install used to print `dist/drydock.js:1783`, the throw statement and a caret.
 * Exit 1 was right; the output told the user they had found a bug in the tool rather than that
 * they had one step left to run. A stack trace is a message to whoever wrote the program, and
 * every line of it is noise to whoever is using it.
 *
 * NotConfigured and its kin already carry the instruction, so they print as-is. Anything else is
 * genuinely unexpected and says so, with the stack available behind DRYDOCK_DEBUG=1 for whoever
 * has to fix it.
 */
const EXPECTED = new Set(['NotConfigured', 'NotLoggedIn', 'AuthError', 'ProjectExistsError', 'BlackboardError']);

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  const e = err as Error;
  if (EXPECTED.has(e.name)) {
    console.error(`\n${e.message}\n`);
  } else {
    console.error(`\ndrydock: ${e.message || String(err)}\n`);
    console.error('This is unexpected. Re-run with DRYDOCK_DEBUG=1 for the full stack.\n');
  }
  if (process.env.DRYDOCK_DEBUG === '1') console.error(e.stack ?? err);
  process.exitCode = 1;
}
