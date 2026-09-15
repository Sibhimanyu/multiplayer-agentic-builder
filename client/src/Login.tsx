// The /login page -- the browser half of `flotilla login`.
//
// The CLI half was complete: random port, one-time nonce, single use, 127.0.0.1-only bind, a 403
// that refuses a bad nonce without killing the pending login. THIS PAGE DID NOT EXIST. The CLI
// opened /login, the SPA rewrite served index.html, and App rendered its only other route -- the
// projects index, with nothing on it to sign in with. Order 0050 described this page as though it
// were already built; it was not.
//
// The wire contract, the parsing and the state machine live in ./login-contract, so the loopback
// test can drive them under node. This file is the rendering and the Firebase calls.

import { useEffect, useRef, useState } from 'react';
import { initializeApp, getApps, type FirebaseApp } from 'firebase/app';
import {
  GoogleAuthProvider, connectAuthEmulator, getAuth, signInAnonymously, signInWithPopup,
} from 'firebase/auth';

import { configFromEnv } from './store/firebase';
import {
  initialLoginState, payloadFor, postCredential, signInFailure,
  type LoginParams, type LoginState, type SignedInUser,
} from './login-contract';

/**
 * Every state of the page, as a pure function of that state.
 *
 * Pure so each state can be rendered and asserted without a browser, a popup or a clock. There is
 * no fallthrough: the switch is exhaustive over LoginState, because the failure being fixed here
 * is a page that renders nothing, and "an unhandled state renders an empty div" is that failure
 * with a smaller blast radius rather than a different one.
 */
export function LoginView({ state, onSignIn }: { state: LoginState; onSignIn?: () => void }) {
  return (
    <>
      <nav className="nav">
        <div className="mark">FL</div>
        <div className="brand">Flotilla</div>
        <span className="grow" />
      </nav>
      <div className="stage">
        <div className="login" data-login-step={state.step}>
          {state.step === 'ready' && !state.params.anonymous && (
            <>
              <h2>Sign in to Flotilla</h2>
              <p>
                This connects the <code>flotilla</code> CLI waiting in your terminal. It is the
                only thing that will receive your credential.
              </p>
              <button className="cta" onClick={onSignIn}>Continue with Google</button>
            </>
          )}

          {state.step === 'ready' && state.params.anonymous && (
            <>
              <h2>Signing in anonymously…</h2>
              <p>No account needed. Your CLI will receive a throwaway identity.</p>
            </>
          )}

          {state.step === 'signing-in' && (
            <>
              <h2>Waiting for sign-in…</h2>
              <p>Finish in the window your browser opened. If you do not see one, it was blocked.</p>
            </>
          )}

          {state.step === 'posting' && (
            <>
              <h2>Handing the credential to the CLI…</h2>
              <p>Sending it to <code>127.0.0.1:{state.params.port}</code>.</p>
            </>
          )}

          {state.step === 'done' && (
            <>
              <h2>Signed in{state.email ? ` as ${state.email}` : ''}.</h2>
              <p>
                Your CLI has the credential. <strong>You can close this tab.</strong>
              </p>
              <p className="uid"><code>{state.uid}</code></p>
            </>
          )}

          {state.step === 'error' && (
            <>
              {/* Names WHICH STEP failed. "Login failed" leaves the user choosing between their
                  browser, their network and the CLI, which is three places to look for one fact. */}
              <h2 className="bad">Login failed at {state.at}.</h2>
              <p>{state.detail}</p>
              <p>
                Start a login from your terminal with <code>flotilla login</code>. This page cannot
                begin one on its own — the CLI supplies the port and the one-time nonce, and this
                page will not guess either.
              </p>
            </>
          )}
        </div>
      </div>
    </>
  );
}

/**
 * The route. Drives LoginView through the flow.
 *
 * `signIn` and `post` are injectable because a Google consent screen cannot be clicked by a test:
 * everything on either side of the popup is driven for real, and the popup itself is the one
 * stubbed step. The anonymous path needs no popup and is driven end to end with nothing stubbed.
 */
export function LoginPage({
  search,
  signIn,
  post = postCredential,
}: {
  search: string;
  signIn?: (anonymous: boolean) => Promise<SignedInUser>;
  post?: typeof postCredential;
}) {
  const [state, setState] = useState<LoginState>(() => initialLoginState(search));
  const started = useRef(false);

  const run = async (params: LoginParams) => {
    if (started.current) return;
    started.current = true;

    setState({ step: 'signing-in', params });
    let user: SignedInUser;
    try {
      user = await (signIn ?? defaultSignIn)(params.anonymous);
    } catch (err) {
      setState({ step: 'error', at: 'sign-in', detail: signInFailure(err) });
      started.current = false; // a blocked popup is worth retrying; leave the button live
      return;
    }

    setState({ step: 'posting', params });
    let payload;
    try {
      payload = await payloadFor(params.nonce, user);
    } catch (err) {
      setState({ step: 'error', at: 'reading the credential', detail: signInFailure(err) });
      return;
    }
    if (!payload.refresh_token || !payload.uid) {
      // Not "the call did not throw": a credential missing these is one the CLI answers with a
      // 400, and catching it here names the cause instead of reporting the symptom.
      setState({ step: 'error', at: 'sign-in', detail: 'Signed in, but no refresh token was issued.' });
      return;
    }

    const out = await post(params.port, payload);
    if (!out.ok) {
      setState({ step: 'error', at: 'handing the credential to the CLI', detail: out.reason });
      return;
    }
    setState({ step: 'done', uid: payload.uid, email: payload.email });
  };

  // The anonymous path starts itself: it opens no popup, so it needs no user gesture, and a
  // button in front of it would be a click that exists only to be clicked. Google cannot start
  // itself -- a popup opened without a gesture is blocked by the browser.
  useEffect(() => {
    if (state.step === 'ready' && state.params.anonymous) void run(state.params);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <LoginView
      state={state}
      onSignIn={state.step === 'ready' ? () => void run(state.params) : undefined}
    />
  );
}

function defaultApp(): FirebaseApp {
  const env = import.meta.env as unknown as Record<string, string | undefined>;
  const app = getApps()[0] ?? initializeApp(configFromEnv(env));
  const emulator = env.VITE_AUTH_EMULATOR;
  if (emulator) connectAuthEmulator(getAuth(app), emulator, { disableWarnings: true });
  return app;
}

async function defaultSignIn(anonymous: boolean): Promise<SignedInUser> {
  const auth = getAuth(defaultApp());
  const cred = anonymous
    ? await signInAnonymously(auth)
    : await signInWithPopup(auth, new GoogleAuthProvider());
  return cred.user;
}
