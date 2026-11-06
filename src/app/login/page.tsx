"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { CafeTrackBrand } from "@/components/CafeTrackBrand";
import { fmtDateTime } from "@/lib/format";

type Mode = "staff" | "admin";

const StaffCheck = dynamic(
  () => import("@/components/StaffCheck").then((module) => module.default),
  {
    ssr: false,
    loading: () => (
      <div className="flex items-center justify-center py-10 text-sm text-cocoa-400">
        Loading face check…
      </div>
    ),
  }
);

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "Sign in failed";
}

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("staff");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sessionConflict, setSessionConflict] = useState(false);
  const [conflictRedirecting, setConflictRedirecting] = useState(false);
  const [pendingRedirect, setPendingRedirect] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [step2, setStep2] = useState<{ ticket: string; fullName?: string } | null>(null);
  const usernameInputRef = useRef<HTMLInputElement>(null);

  // A disabled account gets a distinct panel instead of the generic sign-in
  // error, carrying the reason an admin recorded.
  const [deactivated, setDeactivated] = useState<{
    reason: string | null;
    when: string | null;
  } | null>(null);

  useEffect(() => {
    usernameInputRef.current?.focus({ preventScroll: true });
  }, [mode]);

  /** Shared by both routes, so they cannot drift on what "signed in" means. */
  function finishSignIn(destination: string, hasSessionConflict: boolean) {
    if (hasSessionConflict) {
      setPendingRedirect(destination);
      setSessionConflict(true);
      setBusy(false);
      return;
    }

    router.replace(destination);
  }

  function finishStaffCheck(_matchedBy: "face", hasSessionConflict = false) {
    setStep2(null);
    finishSignIn("/dashboard", hasSessionConflict);
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

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
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

      if (mode === "staff" && data.step2_required && typeof data.ticket === "string") {
        setStep2({ ticket: data.ticket, fullName: data.full_name });
        setBusy(false);
        return;
      }

      finishSignIn("/dashboard", Boolean(data.session_conflict));
    } catch (error) {
      setError(getErrorMessage(error));
      setBusy(false);
    }
  }

  return (
    <main className="min-h-dvh bg-[#f6f1e8] lg:grid lg:h-dvh lg:grid-cols-[0.94fr_1.06fr] lg:overflow-hidden">
      <section className="relative hidden min-h-0 flex-col overflow-hidden bg-[#241811] px-9 py-8 text-cream-50 lg:flex xl:px-14 xl:py-10">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-36 -top-40 h-[28rem] w-[28rem] rounded-full border border-cream-200/10"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-48 -left-36 h-[34rem] w-[34rem] rounded-full border border-cream-200/10"
        />
        <div className="relative z-10">
          <CafeTrackBrand onDark />
        </div>

        <div className="relative z-10 flex min-h-0 flex-1 flex-col py-8">
          <h1 className="max-w-lg font-serif text-4xl font-medium leading-[1.05] tracking-tight text-cream-50 xl:text-5xl">
            Keep every shift
            <br />
            <span className="italic text-cream-400">running smoothly.</span>
          </h1>
          <p className="mt-4 max-w-md text-sm leading-6 text-cream-100/60">
            Track stock, manage restocks, and keep your team in sync from one
            cafe inventory workspace.
          </p>
          <Image
            src="/brand/merrylane-storefront.png"
            alt="Illustration of the Merrylane Cafe storefront"
            width={600}
            height={400}
            sizes="(min-width: 1024px) 45vw, 390px"
            preload
            className="relative z-10 mt-7 h-full min-h-[260px] w-full flex-1 object-contain drop-shadow-[0_0_32px_rgba(240,197,130,0.38)] sm:min-h-[300px]"
          />
        </div>

      </section>

      <section className="flex min-h-dvh items-center justify-center px-5 py-8 sm:px-8 lg:min-h-0 lg:overflow-y-auto lg:px-10 lg:py-10">
        <div className="w-full max-w-[440px]">
          <div className="mb-7 lg:hidden">
            <CafeTrackBrand />
          </div>

          <div className="rounded-[26px] border border-[#e7ddcf] bg-[#fffcf7] p-6 shadow-[0_24px_70px_rgba(47,32,22,0.12)] sm:p-9">
            <div className="mb-6">
              <p className="mb-2 text-[10px] font-extrabold uppercase tracking-[0.18em] text-cocoa-500">
                Welcome back
              </p>
              <h2 className="font-serif text-4xl font-medium leading-none tracking-tight text-cocoa-900 sm:text-[2.65rem]">
                Sign in.
              </h2>
            </div>

            {!(mode === "staff" && step2) && (
              <div className="mb-5 grid grid-cols-2 gap-1 rounded-xl bg-cream-100 p-1">
                {(["staff", "admin"] as Mode[]).map((m) => (
                  <button
                    key={m}
                    type="button"
                    aria-pressed={mode === m}
                    onClick={() => {
                      setMode(m);
                      setError(null);
                      setDeactivated(null);
                    }}
                    className={`rounded-lg px-3 py-2.5 text-xs font-bold uppercase tracking-[0.12em] transition-colors ${
                      mode === m
                        ? "bg-cream-400 text-cocoa-900 shadow-sm"
                        : "text-cocoa-400 hover:text-cocoa-600"
                    }`}
                  >
                    {m}
                  </button>
                ))}
              </div>
            )}

            {mode === "staff" && step2 ? (
              <StaffCheck
                ticket={step2.ticket}
                fullName={step2.fullName}
                onVerified={finishStaffCheck}
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
                    ref={usernameInputRef}
                    className="input !min-h-12 !rounded-xl !border-cream-600 !bg-[#fffcf7] !px-4 !ring-2 !ring-cream-500"
                    placeholder="Username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    autoComplete="username"
                    required
                  />
                ) : (
                  <input
                    id="staff-username"
                    aria-label="Username"
                    ref={usernameInputRef}
                    className="input !min-h-12 !rounded-xl !border-cream-600 !bg-[#fffcf7] !px-4 !ring-2 !ring-cream-500"
                    placeholder="Username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    autoComplete="username"
                    required
                  />
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
                    className="input !min-h-12 !rounded-xl !border-cream-200 !bg-[#fffcf7] !px-4 pr-11"
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
                    <div
                      role="alert"
                      className="rounded-xl border border-terracotta-100 bg-terracotta-50 px-3.5 py-3 text-sm leading-5 text-terracotta-700"
                    >
                      {error}
                    </div>
                  )
                )}

                <button
                  type="submit"
                  className="btn-primary w-full !min-h-12 !rounded-xl !bg-cocoa-700 !py-3 !text-cream-50 hover:!bg-cocoa-800"
                  disabled={busy}
                >
                  {busy ? "Signing in..." : "Login"}
                </button>

              </form>
            )}
          </div>
        </div>

      {/* Session conflict popup */}
      {sessionConflict && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-cocoa-900/55 p-4 backdrop-blur-[3px]">
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="session-conflict-title"
            className="relative w-full max-w-md overflow-hidden rounded-[24px] border border-cream-200 bg-white p-7 text-center shadow-[0_24px_70px_rgba(61,43,31,0.24)]"
          >
            <div className="absolute inset-x-0 top-0 h-1 bg-ochre-500" />
            <span
              aria-hidden="true"
              className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-ochre-50 text-xl font-bold text-ochre-700"
            >
              !
            </span>
            <h3 id="session-conflict-title" className="text-xl font-bold text-cocoa-800">
              Session conflict
            </h3>
            <p className="mt-3 text-sm leading-6 text-cocoa-600">
              Your account was signed in on another browser or site. That session
              has been signed out, and you are now signed in here.
            </p>
            <div className="mt-6 flex justify-center">
              {conflictRedirecting ? (
                <p role="status" className="flex items-center gap-2 text-sm font-semibold text-cocoa-600">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-cream-300 border-t-cocoa-700" />
                  Opening your account…
                </p>
              ) : (
                <button
                  type="button"
                  className="btn-primary min-w-32"
                  onClick={() => {
                    setConflictRedirecting(true);
                    if (pendingRedirect) {
                      router.replace(pendingRedirect);
                      setPendingRedirect(null);
                    } else {
                      setSessionConflict(false);
                    }
                  }}
                >
                  Got it
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      </section>
    </main>
  );
}
