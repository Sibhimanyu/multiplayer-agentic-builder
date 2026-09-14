// Run a suite against an ALREADY-RUNNING Firestore emulator.
//
// Two gotchas cost this project three runs between them; both are encoded here so nobody has to
// rediscover them (order 0042):
//
//   1. `firebase emulators:exec "<cmd>"` runs the command under the CLI's own pkg-bundled Node,
//      which treats `--test` as a FILENAME. So the emulator is started standalone and this
//      script points the SDK at it with FIRESTORE_EMULATOR_HOST instead.
//
//   2. `java -version` reporting 1.8 does not mean Java 8 is all you have. A 2014-era Oracle
//      applet-plugin JRE shadowing a modern brew openjdk on PATH reports exactly that. The fix
//      is JAVA_HOME + PATH, not an install. An error message names a symptom, not a cause.
//
//   node scripts/emul-suite.mjs firebase/store.test.ts [...more]
//
// Refuses if the emulator is not actually answering -- running a suite against nothing and
// reading the resulting errors as adapter defects is a failure mode this project has had.
import { spawn } from 'node:child_process';

const HOST = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: node scripts/emul-suite.mjs <test file> [...]');
  process.exit(1);
}

const res = await fetch(`http://${HOST}/`, { signal: AbortSignal.timeout(3_000) }).catch(() => null);
if (!res) {
  console.error(`No Firestore emulator answering on ${HOST}.`);
  console.error('  Start one:  npx firebase-tools emulators:start --only firestore --project <id>');
  process.exit(1);
}
console.log(`emulator: ${HOST} (HTTP ${res.status})\n`);

// A2 IS ONLY DIAGNOSTIC ON AN EMULATOR IT DOES NOT SHARE. Measured, order 0042:
//
//   emulator, 256 concurrent writes to one document -> 247/256 REJECTED, budget exhausted
//   production, the same 256                        -> 256/256 resolved, 2 of 6 attempts unused
//
// The emulator saturates at roughly half the concurrency production does and runs ~3.7x slower,
// so a second suite sharing the process offers load that no individual test intends. A2 run in a
// shared emulator measures emulator saturation, not the adapter. It then fails on whichever test
// happens to be mid-flight, which is why three different tests have failed with one error.
//
// So this refuses the combination rather than letting it produce a red test people learn to
// ignore. --allow-shared runs it anyway and says what the result is worth.
const CONFORMANCE = 'firebase/store.test.ts';
const shared = files.some((f) => f.includes('store.test.ts')) && files.length > 1;
if (shared && !process.argv.includes('--allow-shared')) {
  console.error(`REFUSING: ${CONFORMANCE} is sharing this emulator with ${files.length - 1} other file(s).`);
  console.error('  A2 is the project gate and is only diagnostic on an emulator it does not share.');
  console.error('  Measured: this emulator drops 247/256 concurrent single-document writes where');
  console.error('  production resolves 256/256 with 2 of 6 retry attempts unused.');
  console.error('');
  console.error(`  Run it alone:  node scripts/emul-suite.mjs ${CONFORMANCE}`);
  console.error('  Then the rest: node scripts/emul-suite.mjs firebase/errors.test.ts ...');
  console.error('  Override with --allow-shared if you accept the result is not diagnostic.');
  process.exit(1);
}
if (shared) {
  console.log('WARNING: --allow-shared. A red A2 in this run is NOT evidence of an adapter defect.\n');
}

// --test-concurrency=1 always. Files running in parallel against one emulator is the same
// saturation by another route, and it is not something a caller should have to remember.
const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...files], {
  stdio: 'inherit',
  env: { ...process.env, FIRESTORE_EMULATOR_HOST: HOST, GCLOUD_PROJECT: process.env.GCLOUD_PROJECT ?? 'multiplayer-agents-eec02' },
});
child.on('exit', (code) => process.exit(code ?? 1));
