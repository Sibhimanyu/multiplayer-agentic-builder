// The `flotilla` binary's entry point. Order 0048.
//
// This is the COMPOSITION ROOT: the one place allowed to import a backend SDK and hand the
// resulting ports to code that only knows the interfaces. cli/index.ts routes `new`, `ls` and
// `members` through registerProjectCommands and never learns what is behind them, which is the
// same boundary firebase/bridge-run.ts holds for the bridge.
//
// Built to plain JS by flotilla/build.mjs. An installed user has no TypeScript loader, so the
// shipped artifact is a bundle -- shared/** and cli/** are compiled in, and firebase-admin stays
// external because it is a real dependency with native pieces.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { main, registerAuthCommands, registerProjectCommands } from '../cli/index.ts';
import { inferRoleScopes, newProject, topLevelDirs } from '../cli/newproject.ts';
import { boardUrl, fetchApiKey, loadConfig, saveConfig, writeUrl } from '../cli/config.ts';
import {
  credentialsPath, loadCredential, localLoginUrl, loginUrl, loopbackReady, saveCredential,
  startLoopback,
} from '../cli/auth.ts';
import { loginPageHtml } from '../cli/loginpage.ts';
import { openBrowser } from '../cli/browser.ts';
import { WriteClient } from '../cli/writeclient.ts';
import { RemoteDirectory } from '../cli/remotedirectory.ts';
import { ReadClient } from '../cli/readclient.ts';
import { DEFAULT_ROLES, ProjectExistsError } from '../shared/store/directory.ts';
import { consoleLogger } from '../shared/log.ts';

// NO BAKED-IN PROJECT ID. It used to read `?? 'multiplayer-agents-eec02'`, which compiled one
// person's Firebase project into a public package -- found by grepping the BUILT BUNDLE, not the
// source, which is the only place it was visible. flotilla/packtest.mjs now asserts its absence
// there for the same reason.
const uid = () => process.env.FLOTILLA_UID ?? `uid_${process.env.USER ?? 'local'}`;

// NO ADMIN SDK PATH REMAINS IN THIS BINARY.
//
// There used to be a `connect()` helper here that built an admin Firestore client. Making its
// import lazy stopped `init` and `login` from reaching for Application Default Credentials, but
// `ls` and `members` still called it -- so on a stranger's machine they printed "Could not load
// the default credentials", a message about Google's auth library shown to someone whose actual
// problem was that they had not run `flotilla login`.
//
// Deleting it rather than fixing its callers is deliberate: while the helper existed, the next
// command added would reach for it too, and the bug would come back wearing a different name.
// Every command now takes the user's identity -- writes through the deployed function, reads
// through firestore.rules -- and there is no third path to fall into.

registerAuthCommands({
  /**
   * `flotilla init --project <id>` — the one identifier a user supplies.
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
    console.log('\nNext:  flotilla login');
    return 0;
  },

  /**
   * `flotilla login` — the loopback flow, now with a real provider.
   *
   * GOOGLE by default; `--anonymous` keeps the disposable path working, because that is what
   * lets someone open the board, see the denied state and read their own uid off the screen
   * before anyone has admitted them. Both land in the same credential store.
   *
   * The nonce handling is unchanged and deliberately so: a bad nonce is refused, logged, and NOT
   * fatal, because aborting would let any page the user visits kill a login in progress.
   */
  /**
   * `flotilla whoami` — which identity this machine is signed in as.
   *
   * Reads the stored credential and NOTHING ELSE. No network call, no token mint: the question is
   * "who does this install think I am", and answering it by contacting Firebase would make it fail
   * offline and turn a lookup into a round trip. The credential file IS the answer.
   *
   * Three outcomes, three exit codes, because this is the command people put in scripts:
   *   configured and signed in  -> the identity, 0
   *   configured, not signed in -> says so, names `flotilla login`, 1
   *   not configured            -> the existing NotConfigured message, 1
   */
  async whoami() {
    let cfg;
    try {
      cfg = await loadConfig();
    } catch (err) {
      console.error(`\n${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }

    const cred = await loadCredential();
    if (!cred) {
      console.log('Not signed in.');
      console.log(`  project     ${cfg.project_id}`);
      console.log('\nRun:  flotilla login');
      return 1;
    }

    console.log(`Signed in as ${cred.email ?? cred.uid}`);
    console.log(`  uid         ${cred.uid}`);
    console.log(`  email       ${cred.email ?? '(anonymous — no email)'}`);
    console.log(`  project     ${cred.project_id}`);
    console.log(`  credential  ${credentialsPath()}`);
    // A credential for one project sitting in a config pointing at another is the kind of thing
    // that surfaces much later as an unexplained permission denial.
    if (cred.project_id !== cfg.project_id) {
      console.log(`\n  NOTE: this config points at ${cfg.project_id}, but the credential is for `
        + `${cred.project_id}.\n  Run \`flotilla login\` to sign in to ${cfg.project_id}.`);
    }
    return 0;
  },

  async login(anonymous, hosted = false, no_browser = false) {
    let cfg;
    try {
      cfg = await loadConfig();
    } catch (err) {
      console.error(`\n${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }

    // LOCAL-FIRST since order 0057. The CLI serves the page itself, so the browser never has an
    // https page posting to http -- which WebKit blocks as mixed content, making the hosted page
    // unusable in Safari. `--hosted` keeps the old path for anyone who needs it.
    const lb = startLoopback({
      log: consoleLogger,
      timeout_ms: 300_000,
      ...(hosted ? {} : {
        page: (nonce) => loginPageHtml({
          api_key: cfg.api_key,
          // The auth handler still lives on the Firebase domain: the PAGE is local, the OAuth
          // handler cannot be. That is fine here -- what mattered was the credential POST, and
          // that is now same-origin.
          auth_domain: `${cfg.project_id}.firebaseapp.com`,
          project_id: cfg.project_id,
          nonce,
          anonymous,
        }),
      }),
    });
    const port = await loopbackReady(lb);
    const url = hosted
      ? `${loginUrl(boardUrl(cfg), port, lb.nonce)}&provider=${anonymous ? 'anonymous' : 'google'}`
      : localLoginUrl(port);

    // THE URL IS PRINTED FIRST, AND ALWAYS.
    //
    // A launcher can report success and still put nothing on screen -- wrong default browser, a
    // window on another desktop, a launcher that silently no-ops. The printed URL is what makes
    // that recoverable, so it is never conditional on the launch.
    console.log(`\nOpen this in your browser to sign in${anonymous ? ' (anonymous)' : ' with Google'}:\n`);
    console.log(`  ${url}\n`);
    if (!hosted) {
      console.log('  This page is served by this command, on your own machine.');
      console.log(`  If your browser cannot open it, run: flotilla login --hosted\n`);
    }

    // WHICH URL IS HANDED OVER IS THE WHOLE POINT. The user who reported this ended up signing in
    // on the HOSTED board -- a tab they already had open -- which uses redirect and is the flow
    // Safari's ITP breaks. Three orders of work went into the local page they never reached. So
    // the launcher gets `url`, the one this server is bound to, and firebase/login-launch.mjs
    // asserts the exact string a real launcher receives from the real binary.
    //
    // `--no-browser` suppresses the launch and keeps the print: genuinely useful on a headless
    // box, and it is what the browser harnesses use so the system browser cannot race them to
    // the credential.
    if (!no_browser) {
      const launch = await openBrowser(url);
      if (!launch.ok) {
        // Not swallowed. A user whose launcher is missing otherwise watches a terminal that looks
        // like it is waiting on them.
        console.log(`  Could not open your browser automatically (${launch.command}: ${launch.error}).`);
        console.log('  Open the URL above yourself — the login is waiting either way.\n');
      }
    }

    try {
      const cred = await lb.result;
      // The listener settles once its reply is flushed, but the browser still has to receive and
      // process it. Exiting immediately closes the socket under a page that is mid-fetch, and the
      // user is shown "Login failed" for a login that worked. A short grace costs nothing here --
      // the command is already finished from the user's point of view.
      await new Promise((r) => { setTimeout(r, 400); });
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
    // user credential from `flotilla login` and no service-account key, and this is the first
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

      // Fit the fences to this repo. After the create, and never fatal: the project exists and
      // works with template scopes; a failed fit is one `flotilla role` away from fixed.
      const fitted = inferRoleScopes(await topLevelDirs(root), {
        backend: DEFAULT_ROLES.backend.file_scope,
        frontend: DEFAULT_ROLES.frontend.file_scope,
        qa: DEFAULT_ROLES.qa.file_scope,
      });
      for (const [role_slug, file_scope] of Object.entries(fitted)) {
        const res = await client.write(r.project_id, 'set_role_scope', { role_slug, file_scope });
        console.log(res.ok
          ? `  ${role_slug.padEnd(10)} ${file_scope.join(', ')}  (fitted to this repo)`
          : `  ${role_slug.padEnd(10)} kept the default: ${String(res.body.error ?? res.status)}`);
      }
      console.log(`\nopen it at /p/${r.project_id}`);
      return 0;
    } catch (err) {
      // Two clones of one repo are ONE project, so a collision is information rather than a
      // crash -- it tells the second person what to ask for.
      if (err instanceof ProjectExistsError) {
        console.error(`\n${err.project_id} already exists.`);
        console.error(`Two clones of the same repo are one project. Ask an owner to add you:`);
        console.error(`  flotilla members ${err.project_id}`);
      } else {
        console.error(`\n${err instanceof Error ? err.message : String(err)}`);
      }
      return 1;
    } finally {
      await close();
    }
  },

  /**
   * `flotilla task "<title>" --kind <kind>` — Order 0063.
   *
   * THE COMMAND THAT DID NOT EXIST. `flotilla claim <task_id>` took an id that nothing in the
   * product could produce: every task the board had shown came from a seeder or a fixture, so
   * someone who ran `flotilla new` on a real repo got six empty columns and no way to fill them.
   *
   * Through the write function with the user's own token, like `new`: creating work is a triage
   * act, the function checks the `triage` capability against the project's role policy, and that
   * check has to live somewhere the person being checked cannot edit.
   *
   * The project comes from `.agentic/project.json`, so the command works where the user already
   * is -- in the repo -- rather than needing a project id pasted from the board.
   */
  /**
   * Mint a single-use invite code.
   *
   * THE COMMAND THAT MAKES THIS A MULTIPLAYER PRODUCT. `connect` has always consumed an invite
   * document; nothing has ever written one, so every project had exactly one member -- whoever
   * ran `flotilla new`. Gated server-side by the `invite` capability, which only the owner holds.
   *
   * The code is printed ONCE. Firestore stores only its sha256, so it cannot be read back out:
   * lose it and mint another.
   */
  async invite(root, role_slug, label) {
    const cfg = await loadConfig();
    const raw = await readFile(join(root, '.agentic/project.json'), 'utf8').catch(() => '');
    if (!raw) {
      console.error('\nno .agentic/project.json here. Run `flotilla new <name>` in your repo first.');
      return 1;
    }
    const project_id = (JSON.parse(raw) as { project_id?: string }).project_id ?? '';
    if (!project_id) {
      console.error('\n.agentic/project.json names no project_id.');
      return 1;
    }

    const client = new WriteClient({
      api_url: writeUrl(cfg), api_key: cfg.api_key, log: consoleLogger,
    });
    const res = await client.write(project_id, 'create_invite', {
      role_slug, ...(label ? { member_label: label } : {}),
    });
    if (!res.ok) {
      console.error(`\n${String(res.body.error ?? `write refused (HTTP ${res.status})`)}`);
      return 1;
    }

    const code = String(res.body.invite ?? '');
    console.log(`\ninvite for ${String(res.body.role_slug ?? role_slug)}`);
    console.log(`  label    ${String(res.body.member_label ?? role_slug)}`);
    console.log(`  expires  in 7 days`);
    console.log('\nSend them this, once:\n');
    console.log(`  flotilla connect ${code}\n`);
    console.log('It works one time. This is the only time the code is shown.');
    return 0;
  },

  /**
   * Redraw a role's file scope for this project. Owner only, enforced by the write function.
   *
   * Role policy is copied from the template at `flotilla new` and describes a functions/ +
   * client/ layout. A repo shaped any other way needs its fences redrawn, and until this there
   * was no way to do it: every backend claim in a server/ repo was refused.
   */
  async roleScope(root, role_slug, globs) {
    const cfg = await loadConfig();
    const raw = await readFile(join(root, '.agentic/project.json'), 'utf8').catch(() => '');
    const project_id = raw ? ((JSON.parse(raw) as { project_id?: string }).project_id ?? '') : '';
    if (!project_id) {
      console.error('\nno project here. Run this in a repo with .agentic/project.json.');
      return 1;
    }
    const client = new WriteClient({ api_url: writeUrl(cfg), api_key: cfg.api_key, log: consoleLogger });
    const res = await client.write(project_id, 'set_role_scope', { role_slug, file_scope: globs });
    if (!res.ok) {
      console.error(`\n${String(res.body.error ?? `write refused (HTTP ${res.status})`)}`);
      return 1;
    }
    const got = (res.body.file_scope as string[] | undefined) ?? globs;
    console.log(`\n${role_slug} may now edit: ${got.join(', ')}`);
    console.log('Takes effect on the next claim. Locks already held are unchanged.');
    return 0;
  },

  async task(root, title, kind, task_id, file_scope) {
    const cfg = await loadConfig();
    const raw = await readFile(join(root, '.agentic/project.json'), 'utf8').catch(() => '');
    if (!raw) {
      console.error('\nno .agentic/project.json here. Run `flotilla new <name>` in your repo first.');
      return 1;
    }
    const project_id = (JSON.parse(raw) as { project_id?: string }).project_id ?? '';
    if (!project_id) {
      console.error('\n.agentic/project.json names no project_id.');
      return 1;
    }

    const client = new WriteClient({
      api_url: writeUrl(cfg), api_key: cfg.api_key, log: consoleLogger,
    });
    const res = await client.write(project_id, 'create_task', {
      title, kind, ...(task_id ? { task_id } : {}),
      ...(file_scope && file_scope.length > 0 ? { file_scope } : {}),
    });
    if (!res.ok) {
      console.error(`\n${String(res.body.error ?? `write refused (HTTP ${res.status})`)}`);
      return 1;
    }

    const created = res.body.ok === true;
    const id = String(res.body.task_id ?? '');
    if (!created) {
      // Not an error and not exit 1. A repeat is the normal outcome of a retry, and the useful
      // thing to print is the task that is actually there -- the same call the user wanted.
      const existing = (res.body.existing ?? {}) as { status?: string; title?: string };
      console.log(`${id} already exists — ${existing.title ?? title} (${existing.status ?? 'unknown'})`);
      console.log('Pass --id to create a second task with the same title.');
      return 0;
    }

    console.log(`created ${id}`);
    console.log(`  title  ${title}`);
    console.log(`  kind   ${kind}`);
    console.log(`  locks  ${file_scope && file_scope.length > 0 ? file_scope.join(', ') : '(nothing — no --scope given)'}`);
    console.log(`\nAn agent can take it now:  flotilla claim ${id}`);
    return 0;
  },

  // AS THE SIGNED-IN USER, through the security rules -- not the Admin SDK.
  //
  // These two used connect(), which builds an admin client and therefore reaches for Application
  // Default Credentials. On a stranger's machine that produced "Could not load the default
  // credentials" instead of "not signed in", which is a message about Google's auth library shown
  // to someone whose actual problem was that they had not run `flotilla login`.
  async ls() {
    const cfg = await loadConfig();
    const projects = await new ReadClient({ project_id: cfg.project_id, api_key: cfg.api_key })
      .listProjects();
    if (projects.length === 0) {
      console.log('no projects yet. Run `flotilla new <name>` in your repo.');
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
 * An unconfigured install used to print `dist/flotilla.js:1783`, the throw statement and a caret.
 * Exit 1 was right; the output told the user they had found a bug in the tool rather than that
 * they had one step left to run. A stack trace is a message to whoever wrote the program, and
 * every line of it is noise to whoever is using it.
 *
 * NotConfigured and its kin already carry the instruction, so they print as-is. Anything else is
 * genuinely unexpected and says so, with the stack available behind FLOTILLA_DEBUG=1 for whoever
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
    console.error(`\nflotilla: ${e.message || String(err)}\n`);
    console.error('This is unexpected. Re-run with FLOTILLA_DEBUG=1 for the full stack.\n');
  }
  if (process.env.FLOTILLA_DEBUG === '1') console.error(e.stack ?? err);
  process.exitCode = 1;
}
