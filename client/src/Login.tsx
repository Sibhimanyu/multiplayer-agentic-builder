// The /login page -- the browser half of `flotilla login`.
//
// Order 0055 built it. Order 0056 fixed the two things that made it a dead end in Safari:
//
//   REDIRECT, NOT POPUP. signInWithPopup is the wrong primitive for a page opened BY A CLI.
//   Safari blocks popups by default, so "your browser blocked the sign-in popup" was the
//   FIRST-RUN EXPERIENCE on macOS, not an edge case. signInWithRedirect is a top-level
//   navigation and is not blocked. Popup is still reachable with ?popup=1, but it is not the
//   default and it is not a fallback: popup-first-with-fallback still flashes the blocked-popup
//   failure on every Safari first run, which is the bug with an extra step.
//
//   A WAY OUT. Every failure the page can do something about now renders a retry button that
//   re-attempts with the port and nonce already in hand. Failures it genuinely cannot fix -- a
//   spent nonce, a CLI that stopped waiting -- say so and name the command. Telling someone to
//   "try again" when trying again means switching to a terminal is not an error message, it is
//   a dead end with a polite tone.
//
// The wire contract, the parsing, the sessionStorage round trip and the state machine live in
// ./login-contract so the loopback test can drive them under node.

import { useEffect, useRef, useState } from 'react';

import { BrandLockup } from './components';
import {
  boardAuth, consumeRedirect, signInAnonymous, signInWithGoogle,
} from './store/session';
import {
  clearPendingLogin, initialLoginState, payloadFor, postCredential, probeListener, signInFailure,
  stashPendingLogin,
  type KeyValueStore, type LoginParams, type LoginState, type PageEnvironment, type SignedInUser,
} from './login-contract';

/**
 * Every state of the page, as a pure function of that state.
 *
 * Pure so each state can be rendered and asserted without a browser, a popup or a clock. The
 * switch is exhaustive over LoginState: the original failure here was a page that rendered
 * nothing, and "an unhandled state renders an empty div" is that failure with a smaller blast
 * radius rather than a different one.
 *
 * THE RETRY BUTTON APPEARS EXACTLY WHEN state.params IS PRESENT, which the contract sets only for
 * failures the page can actually do something about. There is no separate judgement here about
 * when to offer it, because two places deciding that would eventually disagree.
 */
export function LoginView({
  state, onSignIn, onRetry,
}: {
  state: LoginState;
  onSignIn?: () => void;
  onRetry?: () => void;
}) {
  return (
    <>
      <nav className="nav">
        <BrandLockup />
        <span className="grow" />
      </nav>
      <div className="stage">
        <div className="login" data-login-step={state.step}>
          {/*
            THIS PAGE IS THE FALLBACK, AND IT NOW SAYS SO ON ITS FACE.

            Three separate failures were reported from this page by someone who believed they were
            on the local one. The two pages shared a brand, a heading and a button, and the only
            thing telling them apart was a line of body copy about redirects -- which nobody reads
            when they are trying to log in. A restored tab or a bookmark landed here and looked
            exactly like success.
          */}
          <div className="fallback-banner" data-fallback="hosted">
            <strong>Hosted sign-in</strong> — the fallback. The normal way to sign in is to
            run <code>flotilla login</code> in your terminal, which opens a page on your own
            machine.
          </div>

          {state.step === 'refused' && (
            <>
              {/*
                Refused ON LOAD. Knowable before anything was clicked: https + WebKit + a loopback
                handoff. The previous behaviour walked the user all the way through Google and
                only then said it could not work.
              */}
              <h2 className="bad">This browser cannot finish a hosted sign-in.</h2>
              <p>{state.reason}</p>
              <p>Two ways forward, both of which work:</p>
              <ul className="ways">
                <li>
                  Run <code>flotilla login</code> in your terminal. It serves the sign-in page
                  from your own machine, which Safari is happy with. This is the normal path.
                </li>
                <li>Or open this same link in Chrome.</li>
              </ul>
            </>
          )}

          {state.step === 'checking' && (
            <>
              <h2>Checking this link…</h2>
              <p>Making sure the <code>flotilla</code> CLI that issued it is still waiting.</p>
            </>
          )}

          {state.step === 'stale' && (
            <>
              {/*
                The shape of what actually happens now that `flotilla login` opens the browser
                itself: nobody navigates here deliberately, so arriving here means a restored tab
                whose CLI exited long ago. Signing in would spend a Google round trip to reach a
                port that stopped listening.
              */}
              <h2 className="bad">This login link has expired.</h2>
              <p>
                Nothing is listening on port <code>{state.params.port}</code> any more — the
                <code>flotilla login</code> that opened this page has already finished or been
                stopped. This is usually a tab restored from a previous session.
              </p>
              <p>
                Run <code>flotilla login</code> again. It will open a fresh page on your own
                machine.
              </p>
              {/* An escape, because the probe cannot be certain and stranding a live login would
                  be a worse failure than one extra click. */}
              <button className="cta" onClick={onSignIn}>Sign in anyway</button>
            </>
          )}

          {state.step === 'ready' && !state.params.anonymous && (
            <>
              <h2>Sign in to Flotilla</h2>
              <p>
                This connects the <code>flotilla</code> CLI waiting in your terminal. It is the
                only thing that will receive your credential.
              </p>
              <button className="cta" onClick={onSignIn}>Continue with Google</button>
              <p className="note">You will be sent to Google and brought back here.</p>
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
              <h2>Taking you to Google…</h2>
              <p>This page will come back on its own once you have signed in.</p>
            </>
          )}

          {state.step === 'returning' && (
            <>
              <h2>Finishing sign-in…</h2>
              <p>Back from Google. Handing the credential to your CLI.</p>
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
              {state.params ? (
                <>
                  {/* Recoverable HERE. The port and nonce are still in hand, so the whole fix is
                      this button -- no terminal, no browser settings. */}
                  <button className="cta" onClick={onRetry}>Try again</button>
                  <p className="note">
                    Your terminal is still waiting on port <code>{state.params.port}</code>.
                  </p>
                </>
              ) : (
                <p>
                  This one cannot be retried from here. Start a new login from your terminal
                  with <code>flotilla login</code> — it issues the port and the one-time nonce,
                  and this page will not guess either.
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}

/**
 * The route.
 *
 * `signIn` and `post` are injectable because a Google consent screen cannot be clicked by a test.
 * Everything either side of it is driven for real; the anonymous path needs no provider UI at all
 * and is driven end to end with nothing stubbed.
 */
export function LoginPage({
  search,
  store,
  env,
  signIn,
  post = postCredential,
  probe = probeListener,
  redirectResult,
}: {
  search: string;
  store?: KeyValueStore | null;
  /** Protocol and user agent. Injected so both engines' outcomes can be asserted without a browser. */
  env?: PageEnvironment | null;
  /** Resolves a user, or null when the flow left the page (a redirect is under way). */
  signIn?: (params: LoginParams) => Promise<SignedInUser | null>;
  post?: typeof postCredential;
  probe?: typeof probeListener;
  /** What Google left behind, if this load is the return leg. */
  redirectResult?: () => Promise<SignedInUser | null>;
}) {
  const session: KeyValueStore | null | undefined =
    store ?? (typeof window === 'undefined' ? null : window.sessionStorage);
  const pageEnv: PageEnvironment | null = env ?? (typeof window === 'undefined' ? null : {
    protocol: window.location.protocol,
    ua: navigator.userAgent,
  });

  const [state, setState] = useState<LoginState>(() => initialLoginState(search, session, pageEnv));
  const busy = useRef(false);

  /** Everything after a user exists: build the payload, hand it over, say what happened. */
  const deliver = async (params: LoginParams, user: SignedInUser) => {
    setState({ step: 'posting', params });
    let payload;
    try {
      payload = await payloadFor(params.nonce, user);
    } catch (err) {
      const f = signInFailure(err);
      setState({ step: 'error', at: 'reading the credential', detail: f.detail,
        ...(f.recoverable ? { params } : {}) });
      return;
    }
    if (!payload.refresh_token || !payload.uid) {
      // Not "the call did not throw": a credential missing these is one the CLI answers with a
      // 400, and catching it here names the cause instead of reporting the symptom.
      setState({ step: 'error', at: 'sign-in', params,
        detail: 'Signed in, but no refresh token was issued.' });
      return;
    }

    const out = await post(params.port, payload);
    if (!out.ok) {
      setState({
        step: 'error', at: 'handing the credential to the CLI', detail: out.reason,
        // The contract decides. A 403 means a spent nonce and no button can fix it; a 400 leaves
        // the nonce unburned, so retrying genuinely works.
        ...(out.recoverable ? { params } : {}),
      });
      return;
    }
    // Only now. Clearing earlier would lose the nonce for a retry that is still possible.
    clearPendingLogin(session);
    setState({ step: 'done', uid: payload.uid, email: payload.email });
  };

  const run = async (params: LoginParams) => {
    if (busy.current) return;
    busy.current = true;
    setState({ step: 'signing-in', params });

    let user: SignedInUser | null;
    try {
      user = await (signIn ?? defaultSignIn)(params);
    } catch (err) {
      const f = signInFailure(err);
      busy.current = false; // leave the retry live
      setState({ step: 'error', at: 'sign-in', detail: f.detail,
        ...(f.recoverable ? { params } : {}) });
      return;
    }
    // null means the browser is navigating away to Google. Nothing more happens in this document;
    // the flow resumes in the 'returning' branch of the next one.
    if (!user) return;

    busy.current = false;
    await deliver(params, user);
  };

  useEffect(() => {
    // The return leg. getRedirectResult must be called on EVERY load of this page, not only when
    // something looks like a return -- it is what consumes the pending credential, and Firebase
    // resolves it to null when there is nothing to consume.
    if (state.step === 'returning') {
      void (async () => {
        const params = state.params;
        let user: SignedInUser | null;
        try {
          user = await (redirectResult ?? defaultRedirectResult)();
        } catch (err) {
          const f = signInFailure(err);
          setState({ step: 'error', at: 'coming back from Google', detail: f.detail,
            ...(f.recoverable ? { params } : {}) });
          return;
        }
        if (!user) {
          // Back on /login with a pending login but nothing from Google: the user abandoned the
          // consent screen, or the browser discarded the flow. The nonce is still good, so this
          // is a retry, not a trip to the terminal.
          setState({
            step: 'error', at: 'coming back from Google', params,
            detail: 'Google did not return a sign-in. It may have been cancelled.',
          });
          return;
        }
        await deliver(params, user);
      })();
      return;
    }
    // Is the CLI that issued this link still there? Asked before anything actionable is drawn,
    // because `flotilla login` now opens the browser itself -- so anyone arriving at THIS page is
    // almost always arriving from a tab restored days later, pointing at a port nobody holds.
    if (state.step === 'checking') {
      const params = state.params;
      void (async () => {
        const alive = await probe(params.port);
        if (alive === 'alive') {
          setState({ step: 'ready', params });
          // The anonymous path starts itself: no provider UI, so no gesture is needed, and a
          // button in front of it would exist only to be clicked.
          if (params.anonymous) void run(params);
        } else {
          setState({ step: 'stale', params });
        }
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const retry = () => {
    if (state.step !== 'error' || !state.params) return;
    busy.current = false;
    void run(state.params);
  };

  return (
    <LoginView
      state={state}
      // `stale` gets the button too: the probe cannot be certain, and stranding a live login
      // would be a worse failure than one extra click.
      onSignIn={state.step === 'ready' || state.step === 'stale'
        ? () => void run(state.params)
        : undefined}
      onRetry={retry}
    />
  );
}

/**
 * REDIRECT IS THE DEFAULT. `?popup=1` opts back in.
 *
 * The provider calls themselves now live in ./store/session, shared with the board. Order 0064:
 * the board had no sign-in at all and the obvious repair was to write a second one here's twin,
 * which is how `STALE_AFTER_MS` ended up with two values. The redirect-versus-popup reasoning
 * moved with the code and is stated there.
 *
 * What stays HERE is the part that is only true of this page: the pending-login stash, which the
 * board has no equivalent of.
 */
async function defaultSignIn(params: LoginParams): Promise<SignedInUser | null> {
  const auth = boardAuth();
  if (params.anonymous) return signInAnonymous(auth);

  // BEFORE the navigation, never after. Once signInWithRedirect is called this document is on
  // its way out, and a nonce not written by now is a login that returns as "malformed nonce" --
  // a worse bug than the blocked popup, because it reads as the CLI's fault. Written before the
  // call even on the popup path, which costs nothing and removes a branch that could rot.
  if (typeof window !== 'undefined' && !params.popup) stashPendingLogin(window.sessionStorage, params);
  return signInWithGoogle(auth, { popup: params.popup });
}

async function defaultRedirectResult(): Promise<SignedInUser | null> {
  return consumeRedirect(boardAuth());
}
