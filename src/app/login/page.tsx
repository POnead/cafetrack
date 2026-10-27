"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { StorefrontArt } from "@/components/BrandArt";
import { fmtDateTime } from "@/lib/format";

/*
 * The camera panel, loaded only when someone actually asks for it.
 *
 * Statically imported, this put face-client.ts and face-diagnostics.ts into the
 * initial download of /login — the first page every single person loads, and the
 * one nobody reaches the camera on unless face sign-in is switched on for their
 * cafe. `ssr: false` is valid because this page is a Client Component, and it
 * means the 6.7MB of TensorFlow and face-api weights behind those imports are
 * not even part of the graph until the button is pressed.
 */
/*
 * Step two. Loaded the same way as the camera panels above, and for the same
 * reason: it pulls in the face model and the camera, neither of which belongs in
 * the initial bundle for someone who only ever types a password.
 */
const StaffCheck = dynamic(
  () => import("@/components/StaffCheck").then((m) => m.default),
  {
    ssr: false,
    loading: () => (
      <div className="flex items-center justify-center py-10 text-sm text-cocoa-400">
        Loading camera…
      </div>
    ),
  }
);

type Mode = "staff" | "admin";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("staff");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sessionConflict, setSessionConflict] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  /*
   * Face sign-in, staff only.

   * The identifier is always typed or scanned first, and the camera only confirms
   * the face already enrolled against that one account. That makes the comparison
   * one-to-one rather than a search across the whole roster — see the header of
   * api/auth/face-login/route.ts for why the difference matters.
   *
   * Whether the option is offered at all comes from the server, not from a flag
   * baked into the page: an admin switches it on in Settings and it appears with
   * no deploy, and switching it off takes it away just as quickly.
   */

  
  /*
   * Step two of two-step sign-in.
   *
   * Set only by a successful password step, and it is the *only* thing standing
   * between that success and the app. There is deliberately no way to reach the
   * dashboard from here without it, and no "skip" — which is why the button at
   * the bottom of the password form is gone rather than moved.
   *
   * The ticket is held in state, not in a cookie, precisely so the session code
   * cannot see it. It is signed with a key readSessionToken does not hold, so
   * even if it were promoted to a cookie it would not authenticate anything.
   */
  const [step2, setStep2] = useState<{
    ticket: string;
    fullName?: string;
  } | null>(null);

  // A disabled account gets a distinct panel instead of the generic sign-in
  // error, carrying the reason an admin recorded.
  const [deactivated, setDeactivated] = useState<{
    reason: string | null;
    when: string | null;
  } | null>(null);

  /** Shared by both routes, so they cannot drift on what "signed in" means. */
  function afterSignIn(
    data?: { user?: unknown; session_conflict?: boolean } | "face" | "id_card"
  ) {
    if (data && typeof data === "object" && data.session_conflict) {
      setSessionConflict(true);
    }

    /*
     * Staff come here twice now: once from the badge panel, with the session
     * already in hand, and once from StaffCheck, which has just been handed one
     * by /api/auth/staff/confirm. Both need the duty check below — but that
     * check reads /api/auth/me, which only answers for a real session, so it is
     * reached at the same point either way.
     */
    router.replace("/dashboard");
  }

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    if (busy) return;
    setError(null);
    setDeactivated(null);
    setBusy(true);

    try {
      // In staff mode the same field accepts either a barcode scan or a
      // typed username — the server decides which by the input's shape.
      const url = mode === "admin" ? "/api/auth/login" : "/api/auth/staff";
      const body =
        mode === "admin" ? { username, password } : { username, password };

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = await res.json();

      if (!res.ok) {
        if (data.deactivated) {
          setDeactivated({
            reason: data.deactivation_reason ?? null,
            when: data.deactivated_at ?? null,
          });
        }
        throw new Error(data.error || "Sign in failed");
      }

      /*
       * Staff: the password is half a login. The route hands back a ticket
       * instead of a session, and the app is unreachable until that ticket is
       * exchanged for one by a match with the enrolled face.
       *
       * Checked before anything else because it changes what happens next
       * entirely — there is no session to be in conflict about yet, and the
       * duty check below would answer 401 against a session that does not exist.
       */
      if (mode === "staff" && data.step2_required && data.ticket) {
        setStep2({ ticket: data.ticket, fullName: data.full_name });
        setBusy(false);
        return;
      }

      // Session conflict: the same account is already logged in elsewhere.
      // The new login has already overwritten the old session token server-side,
      // so the old tab will be logged out on its next request. Show a popup
      // so the user knows their account was open on another device.
      if (data.session_conflict) {
        setSessionConflict(true);
      }

      /*
       * Send a staff member who still owes a duty check to the verify screen
       * rather than into the app.
       *
       * The status is re-read from the database here rather than taken from the
       * sign-in response, for the same reason lib/face-gate re-reads it instead
       * of trusting the session token: a token minted a moment ago cannot know
       * whether the feature is switched on, whether this account has a photo, or
       * whether they are already inside their window.
       *
       * Only for staff. An admin is never gated, and sending one here would put
       * an account they manage behind the screen that manages accounts.
       */
      if (mode === "staff") {
        try {
          const me = await fetch("/api/auth/me", { cache: "no-store" });
          if (me.ok) {
            const who = await me.json();
            if (who?.face?.required) {
              router.replace("/verify");
              return;
            }
          }
        } catch {
          // If the status cannot be read, let them in rather than stranding them
          // on a screen that will not load. The routes that move stock re-check
          // the duty window themselves.
        }
      }

      router.replace("/dashboard");
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen bg-white">
      {/* ============ LEFT — peach panel ============ */}
      <div className="relative hidden w-[52%] shrink-0 overflow-hidden bg-cream-300 lg:block">
        <div className="relative z-10 flex h-full flex-col px-12 py-10">
          <h1 className="script-logo text-4xl">CafeTrack</h1>

          <div className="flex flex-1 items-center justify-center">
            {/* The illustration is a JPEG with an opaque white background, so it
                gets its own white panel instead of sitting straight on the
                peach. See the note at the top of @/components/BrandArt. */}
            <div className="w-full max-w-[380px] rounded-[28px] bg-white p-6 shadow-warm-lg">
              {/* Preloaded: this is the desktop LCP element. It costs a phone
                  one small fetch for a panel it never shows, which is the
                  cheaper mistake than a late-loading hero. The panel is 380px
                  and p-6 leaves the image 332px, so 380px is the honest
                  `sizes`; the next candidate down, 256px, would be too small. */}
              <StorefrontArt preload sizes="380px" />
            </div>
          </div>

          <p className="text-xs font-medium text-cocoa-600/70">
            Merrylane Cafe Foodhub · Lipa City
          </p>
        </div>

        {/* wavy right edge */}
        <svg
          className="absolute right-0 top-0 h-full w-16 text-white lg:w-24"
          viewBox="0 0 80 800"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <path
            d="M0 0 C 58 110, 4 210, 44 330 C 76 430, 0 550, 40 670 C 58 730, 18 775, 0 800 L 0 0 Z"
            fill="currentColor"
          />
        </svg>
      </div>

      {/* ============ RIGHT — form ============ */}
      <div className="flex flex-1 items-center justify-center bg-white px-6 py-12">
        <div className="w-full max-w-[400px]">
          {/* mobile-only brand */}
          <div className="mb-6 text-center lg:hidden">
            <div className="script-logo-dark text-3xl">CafeTrack</div>
          </div>

          {/* double-framed card */}
          <div className="rounded-[32px] border border-cream-200 p-2">
            <div className="rounded-[24px] border border-cream-200 px-8 py-9">
              <div className="text-center">
                <div className="script-logo-dark text-2xl">CafeTrack</div>
                <h2 className="deco-title mt-0.5 text-5xl">Login</h2>
              </div>

              {/* mode switch */}
              <div className="mt-6 mb-5 grid grid-cols-2 gap-1 rounded-full bg-cream-100 p-1">
                {(["staff", "admin"] as Mode[]).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => {
                      setMode(m);
                      setError(null);
                      setDeactivated(null);
                    }}
                    className={`rounded-full px-3 py-1.5 text-xs font-bold uppercase tracking-wide transition-colors ${
                      mode === m
                        ? "bg-cream-400 text-cocoa-900 shadow-sm"
                        : "text-cocoa-400 hover:text-cocoa-600"
                    }`}
                  >
                    {m}
                  </button>
                ))}
              </div>

              {/*
                Step two takes over the whole panel once the password is right.

                It is a replacement rather than an addition, and it is not
                dismissible: the panel below this one is the ordinary password
                form, and letting both be visible at once would invite a person to
                type a password while a camera is already running.
              */}
              {mode === "staff" && step2 ? (
                <StaffCheck
                  ticket={step2.ticket}
                  fullName={step2.fullName}
                  onVerified={afterSignIn}
                  onBack={() => {
                    setStep2(null);
                    setBusy(false);
                  }}
                />
              ) : (
              <form onSubmit={submit} className="space-y-3.5">
                {mode === "admin" ? (
                  <input
                    aria-label="Username"
                    className="input"
                    placeholder="Username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    autoComplete="username"
                    required
                  />
                ) : (
                  <div>
                    <label className="label" htmlFor="staff-username">
                      Username or scan barcode
                    </label>
                    <input
                      id="staff-username"
                      className="input"
                      placeholder="Type username or scan barcode"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      autoComplete="username"
                      autoFocus={true}
                      required
                    />
                    <p className="mt-1 text-[11px] text-cocoa-300">
                      Scan your staff barcode or type your username, then enter your password.
                    </p>
                  </div>
                )}

                {/*
                  Reveal toggle, and always rendered.

                  It was previously conditional on the field holding text, which
                  meant it appeared the moment you started typing and vanished the
                  moment the field emptied or lost focus — a control that showed
                  up and hid by itself, which is worse than not having it. It is
                  now there from the start and stays there.

                  Checked rather than conditionally rendered so the space is
                  reserved: rendering it late shifted the text left as the value
                  grew, which is its own small jolt on a phone.
                */}
                <div className="relative">
                  <input
                    aria-label="Password"
                    className="input pr-11"
                    type={showPassword ? "text" : "password"}
                    placeholder="Password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                    required
                  />
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label={showPassword ? "Hide password" : "Show password"}
                    aria-pressed={showPassword}
                    title={showPassword ? "Hide password" : "Show password"}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-lg p-2 text-cocoa-400 transition hover:bg-cream-200 hover:text-cocoa-700"
                    onClick={() => setShowPassword((v) => !v)}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <path
                        d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinejoin="round"
                      />
                      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.8" />
                      {showPassword && (
                        <line
                          x1="4"
                          y1="20"
                          x2="20"
                          y2="4"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                        />
                      )}
                    </svg>
                  </button>
                </div>

                {mode === "staff" && (
                  <p className="text-center text-[11px] text-cocoa-300">
                    Scan your staff ID, or type the code printed on it.
                  </p>
                )}

                {deactivated ? (
                  <div className="rounded-xl bg-ochre-50 px-3.5 py-3 text-center text-sm text-ochre-700">
                    <div className="font-bold">This account is deactivated</div>
                    {deactivated.reason && (
                      <div className="mt-1 text-xs leading-snug">
                        Reason: {deactivated.reason}
                      </div>
                    )}
                    {deactivated.when && (
                      <div className="mt-1 text-[11px] text-ochre-700">
                        Deactivated {fmtDateTime(deactivated.when)}
                      </div>
                    )}
                    <div className="mt-1.5 text-[11px] text-ochre-700">
                      Ask an administrator to re-activate it.
                    </div>
                  </div>
                ) : (
                  error && (
                    <div className="rounded-xl bg-terracotta-50 px-3.5 py-2.5 text-center text-sm text-terracotta-700">
                      {error}
                    </div>
                  )
                )}

                <button
                  type="submit"
                  className="btn-primary w-full !py-2.5"
                  disabled={busy}
                >
                  {busy ? "Signing in..." : "Login"}
                </button>

                {/*
                  Neither alternative is here any more.

                  Both used to be links under this button - "use my face instead
                  of my password" and "sign in with my ID card and my face" - and
                  both were ways into the app *without* a password. With the
                  password now a mandatory first step they are unreachable states:
                  their routes answer with a session, and there is no longer a
                  point in the flow where a session can be issued before step two
                  has run.

                  So the links are gone rather than moved. Keeping them visible
                  would be a promise the code cannot keep, and the replacement is
                  in StaffCheck: one camera and one button, and the face has to
                  match the one enrolled on the account.

                  The routes themselves are untouched and still work, which is
                  what lets this land without dismantling the badge flow.
                */}
              </form>
              )}
            </div>
          </div>

          <p className="mt-5 text-center text-[11px] text-cocoa-300">
            Sessions expire after a period of inactivity set by your administrator.
          </p>
        </div>
      </div>

      {/* Session conflict popup */}
      {sessionConflict && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-cocoa-900/40 p-4">
          <div className="w-full max-w-md rounded-2xl border border-cream-200 bg-white p-6 shadow-warm-lg">
            <h3 className="text-lg font-bold text-cocoa-800">Session Conflict</h3>
            <p className="mt-3 text-sm text-cocoa-600">
              Your account was already logged in on another device or browser.
              That session has been logged out. You are now signed in here.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                className="btn-ghost"
                onClick={() => setSessionConflict(false)}
              >
                Got it
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
