"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import { CafeTrackBrand } from "@/components/CafeTrackBrand";
import FeatureCarousel from "@/components/FeatureCarousel";
import { fmtDateTime } from "@/lib/format";

type Mode = "staff" | "admin";
type RecoveryStage = "login" | "code" | "password";

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

async function readLoginResponse(response: Response): Promise<Record<string, unknown>> {
  const body = await response.text();
  if (!body.trim()) {
    throw new Error(
      `The sign-in service returned an empty response (HTTP ${response.status}). ` +
        "Check the server and try again."
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(
      `The sign-in service returned an invalid response (HTTP ${response.status}). ` +
        "Check the server and try again."
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `The sign-in service returned an invalid response (HTTP ${response.status}). ` +
        "Check the server and try again."
    );
  }
  return parsed as Record<string, unknown>;
}

function PasswordVisibilityIcon({ visible }: { visible: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.8" />
      {visible && (
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
  );
}

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("staff");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);
  const [recoveryRequestBusy, setRecoveryRequestBusy] = useState(false);
  const [sessionConflict, setSessionConflict] = useState(false);
  const [conflictRedirecting, setConflictRedirecting] = useState(false);
  const [faceCheckResetNotice, setFaceCheckResetNotice] = useState(false);
  const [pendingRedirect, setPendingRedirect] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [showRecoveryPasswords, setShowRecoveryPasswords] = useState(false);
  const [step2, setStep2] = useState<{ ticket: string; fullName?: string } | null>(null);
  const usernameInputRef = useRef<HTMLInputElement>(null);
  const [adminFailedAttempts, setAdminFailedAttempts] = useState(0);
  const [recoveryStage, setRecoveryStage] = useState<RecoveryStage>("login");
  const [recoveryChallengeId, setRecoveryChallengeId] = useState("");
  const [recoveryResetToken, setRecoveryResetToken] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [recoveryPassword, setRecoveryPassword] = useState("");
  const [recoveryConfirmPassword, setRecoveryConfirmPassword] = useState("");
  const [recoveryMessage, setRecoveryMessage] = useState<string | null>(null);
  const [resendSeconds, setResendSeconds] = useState(0);

  useEffect(() => {
    let active = true;
    void fetch("/api/auth/me?session_check=1&login_check=1", { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json();
        if (!active) return;
        if (response.ok && data.authenticated === true) {
          router.replace("/dashboard");
        } else {
          setCheckingSession(false);
        }
      })
      .catch(() => {
        // Login remains available when the session preflight cannot reach the server.
        if (active) setCheckingSession(false);
      });

    return () => {
      active = false;
    };
  }, [router]);

  const step2Ticket = step2?.ticket;
  useEffect(() => {
    if (!step2Ticket) return;

    const activeUrl = `${window.location.pathname}${window.location.search}`;
    const keepFaceCheckOpen = () => {
      window.history.pushState(null, "", activeUrl);
    };

    keepFaceCheckOpen();
    window.addEventListener("popstate", keepFaceCheckOpen);
    return () => window.removeEventListener("popstate", keepFaceCheckOpen);
  }, [step2Ticket]);

  // A disabled account gets a distinct panel instead of the generic sign-in
  // error, carrying the reason an admin recorded.
  const [deactivated, setDeactivated] = useState<{
    reason: string | null;
    when: string | null;
  } | null>(null);

  useEffect(() => {
    if (!window.matchMedia("(min-width: 1024px)").matches) return;
    usernameInputRef.current?.focus({ preventScroll: true });
  }, [mode]);

  useEffect(() => {
    setFaceCheckResetNotice(
      new URLSearchParams(window.location.search).get("face_check_reset") === "1"
    );
  }, []);

  useEffect(() => {
    if (resendSeconds <= 0) return;
    const timer = window.setTimeout(
      () => setResendSeconds((seconds) => Math.max(0, seconds - 1)),
      1000
    );
    return () => window.clearTimeout(timer);
  }, [resendSeconds]);

  function clearRecovery() {
    setRecoveryStage("login");
    setRecoveryChallengeId("");
    setRecoveryResetToken("");
    setRecoveryCode("");
    setRecoveryPassword("");
    setRecoveryConfirmPassword("");
    setRecoveryMessage(null);
    setResendSeconds(0);
    setShowRecoveryPasswords(false);
  }

  function returnToSignIn() {
    setRecoveryStage("login");
    setRecoveryResetToken("");
    setRecoveryCode("");
    setRecoveryPassword("");
    setRecoveryConfirmPassword("");
    setRecoveryMessage(null);
    setError(null);
    setShowRecoveryPasswords(false);
  }

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
    if (busy || recoveryRequestBusy) return;
    setError(null);
    setRecoveryMessage(null);
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

      const data = await readLoginResponse(res);

      if (!res.ok) {
        if (mode === "admin") {
          if (res.status === 401) {
            const serverAttempts = Number(data.failed_attempts);
            setAdminFailedAttempts((attempts) =>
              Math.max(
                attempts + 1,
                Number.isSafeInteger(serverAttempts) ? serverAttempts : 0
              )
            );
          } else if (res.status === 429) {
            setAdminFailedAttempts((attempts) => Math.max(attempts, 3));
          }
        }
        if (data.deactivated) {
          setDeactivated({
            reason:
              typeof data.deactivation_reason === "string"
                ? data.deactivation_reason
                : null,
            when:
              typeof data.deactivated_at === "string"
                ? data.deactivated_at
                : null,
          });
        }
        throw new Error(
          typeof data.error === "string" ? data.error : "Sign in failed"
        );
      }

      if (mode === "admin") setAdminFailedAttempts(0);
      if (mode === "staff" && data.step2_required && typeof data.ticket === "string") {
        setStep2({
          ticket: data.ticket,
          fullName: typeof data.full_name === "string" ? data.full_name : undefined,
        });
        setBusy(false);
        return;
      }

      finishSignIn("/dashboard", Boolean(data.session_conflict));
    } catch (error) {
      setError(getErrorMessage(error));
      setBusy(false);
    }
  }

  async function requestRecoveryCode() {
    if (!username.trim() || busy || recoveryRequestBusy) return;
    setRecoveryRequestBusy(true);
    setError(null);
    setRecoveryMessage(null);

    try {
      const res = await fetch("/api/auth/password-recovery", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "request", username }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not request a recovery code");
      const challengeId =
        typeof data.challenge_id === "string" ? data.challenge_id : "";
      const isSameChallenge = challengeId !== "" && challengeId === recoveryChallengeId;
      setRecoveryChallengeId(challengeId);
      setRecoveryCode("");
      setRecoveryStage("code");
      setRecoveryMessage(
        data.message ||
          "If this admin account is eligible and has a recovery email configured, a code will be sent to that inbox."
      );
      const resendAvailableAt = Date.parse(data.resend_available_at);
      if (Number.isFinite(resendAvailableAt)) {
        setResendSeconds(Math.max(0, Math.ceil((resendAvailableAt - Date.now()) / 1000)));
      } else if (
        typeof data.resend_after_seconds === "number" &&
        Number.isSafeInteger(data.resend_after_seconds) &&
        data.resend_after_seconds >= 0
      ) {
        setResendSeconds(data.resend_after_seconds);
      } else if (!isSameChallenge && !recoveryChallengeId) {
        setResendSeconds(60);
      }
    } catch (requestError) {
      setError(getErrorMessage(requestError));
    } finally {
      setRecoveryRequestBusy(false);
    }
  }

  async function verifyRecoveryCode(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || recoveryRequestBusy) return;
    setBusy(true);
    setError(null);

    try {
      const res = await fetch("/api/auth/password-recovery", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "verify",
          challenge_id: recoveryChallengeId,
          code: recoveryCode,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "That code is incorrect or expired");
      setRecoveryResetToken(data.reset_token);
      setRecoveryPassword("");
      setRecoveryConfirmPassword("");
      setRecoveryStage("password");
      setRecoveryMessage(null);
    } catch (verificationError) {
      setError(getErrorMessage(verificationError));
    } finally {
      setBusy(false);
    }
  }

  async function resetAdminPassword(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || recoveryRequestBusy) return;
    if (recoveryPassword !== recoveryConfirmPassword) {
      setError("Passwords do not match");
      return;
    }
    setBusy(true);
    setError(null);

    try {
      const res = await fetch("/api/auth/password-recovery", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "reset",
          challenge_id: recoveryChallengeId,
          reset_token: recoveryResetToken,
          password: recoveryPassword,
          confirm_password: recoveryConfirmPassword,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not reset the password");
      clearRecovery();
      setPassword("");
      setAdminFailedAttempts(0);
      setRecoveryMessage(data.message || "Password updated. Sign in with your new password.");
    } catch (resetError) {
      setError(getErrorMessage(resetError));
    } finally {
      setBusy(false);
    }
  }

  if (checkingSession) {
    return (
      <main className="grid min-h-dvh place-items-center bg-[#f6f1e8]">
        <p role="status" className="flex items-center gap-3 text-sm font-medium text-cocoa-700">
          <span
            aria-hidden="true"
            className="h-4 w-4 animate-spin rounded-full border-2 border-cocoa-300 border-t-cocoa-800"
          />
          Checking your session…
        </p>
      </main>
    );
  }

  return (
    <main className="min-h-dvh bg-[#f6f1e8] lg:grid lg:h-dvh lg:grid-cols-2 lg:overflow-hidden">
      <section className="relative z-0 hidden min-h-0 flex-col overflow-hidden bg-[#241811] px-9 py-8 text-cream-50 [@media(max-height:700px)]:py-4 lg:flex xl:px-14 xl:py-10 2xl:px-20">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-36 -top-40 h-[28rem] w-[28rem] rounded-full border border-cream-200/10"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-48 -left-36 h-[34rem] w-[34rem] rounded-full border border-cream-200/10"
        />
        <svg
          aria-hidden="true"
          viewBox="0 0 160 150"
          fill="none"
          className="pointer-events-none absolute right-8 top-3 z-0 hidden h-32 w-36 text-cream-300/40 xl:block"
        >
          <g stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 140C62 111 107 70 151 12" strokeWidth="1.5" />
            <path d="M41 122C23 123 12 114 9 98c18-1 31 7 35 22Zm3-3c14-12 17-26 8-41-15 10-19 24-10 41Zm33-21C60 99 48 92 43 76c18-3 31 3 37 20Zm2-3c16-9 22-22 16-38C79 65 75 78 79 95Zm32-29C94 69 81 63 74 48c17-5 31 0 40 16Zm2-3c16-7 24-19 20-36-17 6-25 18-21 35Z" strokeWidth="1.4" />
            <path d="M10 98c12 11 22 18 34 21M52 78c10 6 18 12 25 20m-2-50c11 6 21 12 34 18m2-18c9 2 17 4 25 5" strokeWidth="1" opacity=".8" />
          </g>
        </svg>
        <div className="relative z-10">
          <CafeTrackBrand onDark large />
        </div>

        <div className="relative z-10 flex min-h-0 flex-1 flex-col py-4 [@media(max-height:700px)]:py-2">
          <FeatureCarousel />
          <div className="relative z-10 flex min-h-0 flex-1 items-start justify-center pt-2">
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-8 bottom-8 h-3/4 rounded-full bg-[#c89554]/10 blur-3xl"
            />
            <Image
              src="/brand/merrylane-cafe-login.png"
              alt="Illustration of the Merrylane Cafe dining room"
              width={874}
              height={597}
              priority
              sizes="(min-width: 1280px) 48vw, (min-width: 1024px) 46vw, 0px"
              className="h-auto max-h-[410px] w-full object-contain object-center drop-shadow-[0_14px_18px_rgba(0,0,0,0.2)] [@media(min-height:850px)]:max-h-[460px] [@media(max-height:700px)]:max-h-[320px]"
            />
          </div>
        </div>

      </section>

      <section className="relative z-10 flex min-h-dvh items-start justify-center overflow-hidden bg-[#f8f2e8] px-5 py-6 sm:px-8 sm:py-8 lg:min-h-0 lg:items-center lg:overflow-visible lg:px-10 lg:py-10 before:pointer-events-none before:absolute before:-left-[72px] before:top-[-10%] before:hidden before:h-[120%] before:w-36 before:rounded-[50%] before:bg-[#f8f2e8] before:content-[''] lg:before:block">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-28 -top-32 hidden h-80 w-80 rounded-full border border-[#d9b98b]/35 lg:block"
        />
        <svg
          aria-hidden="true"
          viewBox="0 0 160 190"
          fill="none"
          className="pointer-events-none absolute bottom-4 right-5 hidden h-40 w-36 text-[#b58d57]/45 lg:block"
        >
          <g stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
            <path d="M150 184C102 137 65 78 15 8" strokeWidth="1.6" />
            <path d="M117 147c16 2 29-6 34-22-17-2-29 5-33 20Zm-2-2c-16 2-27-6-31-21 16-2 28 5 32 19Zm-29-35c16 0 27-9 29-25-17 1-28 9-31 24Zm-2-2c-16-2-25-12-25-28 17 3 26 12 27 27Zm-27-35c16-3 24-14 22-30-16 5-24 15-22 30Zm-2-2c-16 0-25-9-27-25 16 1 26 9 28 24ZM25 29c15-5 21-16 16-31-15 6-22 17-17 31Zm-2-1C8 24 2 13 4-2c15 7 21 17 18 30Z" strokeWidth="1.4" />
            <path d="M118 145c10-8 21-15 33-20m-64-17c10 1 20 2 31 3m-58-32c10-1 19-2 29-4m-52-43c7 5 14 11 21 17" strokeWidth="1" opacity=".8" />
          </g>
        </svg>
        <div className="relative z-10 my-auto w-full max-w-[440px]">
          <div className="mb-7 lg:hidden">
            <CafeTrackBrand />
          </div>

          <div
            aria-busy={recoveryRequestBusy}
            className="rounded-[26px] border border-[#e7ddcf] bg-[#fffcf7] p-6 shadow-[0_24px_70px_rgba(47,32,22,0.12)] sm:p-9"
          >
            <div className="mb-6">
              <p className="mb-2 text-[10px] font-extrabold uppercase tracking-[0.18em] text-cocoa-500">
                {recoveryStage === "code"
                  ? "Account recovery"
                  : recoveryStage === "password"
                    ? "Account recovery"
                    : "Welcome back"}
              </p>
              <h2 className="font-serif text-4xl font-medium leading-none tracking-tight text-cocoa-900 sm:text-[2.65rem]">
                {recoveryStage === "code"
                  ? "Confirm your account."
                  : recoveryStage === "password"
                    ? "Set a new password."
                    : "Sign in."}
              </h2>
            </div>

            {recoveryMessage && (
              <p role="status" className="mb-4 rounded-xl bg-sage-50 px-3.5 py-3 text-sm text-sage-700">
                {recoveryMessage}
              </p>
            )}

            {recoveryStage === "login" && !(mode === "staff" && step2) && (
              <div className="mb-5 grid grid-cols-2 gap-1 rounded-xl bg-cream-100 p-1">
                {(["staff", "admin"] as Mode[]).map((m) => (
                  <button
                    key={m}
                    type="button"
                    aria-pressed={mode === m}
                    disabled={busy || recoveryRequestBusy}
                    onClick={() => {
                      setMode(m);
                      setError(null);
                      setDeactivated(null);
                      clearRecovery();
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
            ) : recoveryStage === "code" ? (
              <form onSubmit={verifyRecoveryCode} className="space-y-4">
                <p className="text-sm leading-6 text-cocoa-600">
                  Enter the code sent to this admin account&apos;s recovery inbox. If it has not arrived,
                  check spam or ask an administrator to verify the recovery email and sending account.
                </p>
                <input
                  aria-label="Recovery code"
                  className="input !min-h-12 !rounded-xl !border-cream-300 !bg-white !px-4 text-center text-lg tracking-[0.3em]"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  pattern="[0-9]{6}"
                  placeholder="Enter code"
                  required
                  value={recoveryCode}
                  disabled={busy}
                  onChange={(event) => setRecoveryCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                />
                {error && (
                  <div role="alert" className="rounded-xl bg-terracotta-50 px-3.5 py-3 text-sm text-terracotta-700">
                    {error}
                  </div>
                )}
                <button type="submit" className="btn-primary w-full !min-h-12 !rounded-full" disabled={busy || recoveryRequestBusy}>
                  {busy ? "Checking..." : "Continue"}
                </button>
                <button
                  type="button"
                  className="w-full rounded-full bg-cream-100 px-4 py-3 text-sm font-semibold text-cocoa-700 transition hover:bg-cream-200 disabled:opacity-50"
                  disabled={busy || recoveryRequestBusy || resendSeconds > 0}
                  onClick={requestRecoveryCode}
                >
                  {recoveryRequestBusy
                    ? "Sending code..."
                    : resendSeconds > 0
                    ? `Didn't get a code? Resend in ${resendSeconds}s`
                    : "Didn't get a code? Send again"}
                </button>
                <button type="button" className="w-full py-2 text-sm text-cocoa-500 underline" onClick={returnToSignIn}>
                  Back to sign in
                </button>
              </form>
            ) : recoveryStage === "password" ? (
              <form onSubmit={resetAdminPassword} className="space-y-3.5">
                <p className="text-sm leading-6 text-cocoa-600">
                  Your email is confirmed. Choose a new password to continue to the admin account.
                </p>
                <div className="relative">
                  <input
                    aria-label="New password"
                    className="input !min-h-12 !rounded-xl pr-12"
                    type={showRecoveryPasswords ? "text" : "password"}
                    autoComplete="new-password"
                    minLength={8}
                    placeholder="New password"
                    required
                    value={recoveryPassword}
                    disabled={busy}
                    onChange={(event) => setRecoveryPassword(event.target.value)}
                  />
                </div>
                <div className="relative">
                  <input
                    aria-label="Confirm new password"
                    className="input !min-h-12 !rounded-xl pr-12"
                    type={showRecoveryPasswords ? "text" : "password"}
                    autoComplete="new-password"
                    minLength={8}
                    placeholder="Confirm new password"
                    required
                    value={recoveryConfirmPassword}
                    disabled={busy}
                    onChange={(event) => setRecoveryConfirmPassword(event.target.value)}
                  />
                  <button
                    type="button"
                    aria-label={showRecoveryPasswords ? "Hide passwords" : "Show passwords"}
                    aria-pressed={showRecoveryPasswords}
                    title={showRecoveryPasswords ? "Hide passwords" : "Show passwords"}
                    className="password-visibility-toggle absolute right-0 top-1/2 size-11 -translate-y-1/2 rounded-lg text-cocoa-400 transition hover:bg-transparent hover:text-cocoa-700"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => setShowRecoveryPasswords((visible) => !visible)}
                  >
                    <PasswordVisibilityIcon visible={showRecoveryPasswords} />
                  </button>
                </div>
                {error && (
                  <div role="alert" className="rounded-xl bg-terracotta-50 px-3.5 py-3 text-sm text-terracotta-700">
                    {error}
                  </div>
                )}
                <button type="submit" className="btn-primary w-full !min-h-12 !rounded-xl" disabled={busy || recoveryRequestBusy}>
                  {busy ? "Saving..." : "Save new password"}
                </button>
              </form>
            ) : (
              <form onSubmit={submit} className="space-y-3.5">
                {mode === "admin" ? (
                  <input
                    aria-label="Username"
                    ref={usernameInputRef}
                    className="input !min-h-12 !rounded-xl !border-cream-600 !bg-[#fffcf7] !px-4 !ring-2 !ring-cream-500"
                    placeholder="Username"
                    value={username}
                    disabled={busy || recoveryRequestBusy}
                    onChange={(e) => {
                      setUsername(e.target.value);
                      setRecoveryMessage(null);
                    }}
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
                    disabled={busy || recoveryRequestBusy}
                    onChange={(e) => {
                      setUsername(e.target.value);
                      setRecoveryMessage(null);
                    }}
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
                    className="input !min-h-12 !rounded-xl !border-cream-200 !bg-[#fffcf7] !px-4 pr-12"
                    type={showPassword ? "text" : "password"}
                    placeholder="Password"
                    value={password}
                    disabled={busy || recoveryRequestBusy}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                    required
                  />
                  <button
                    type="button"
                    aria-label={showPassword ? "Hide password" : "Show password"}
                    aria-pressed={showPassword}
                    title={showPassword ? "Hide password" : "Show password"}
                    className="password-visibility-toggle absolute right-0 top-1/2 size-11 -translate-y-1/2 rounded-lg text-cocoa-400 transition hover:bg-transparent hover:text-cocoa-700"
                    onMouseDown={(event) => event.preventDefault()}
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

                {faceCheckResetNotice && (
                  <div
                    role="status"
                    className="rounded-xl border border-ochre-200 bg-ochre-50 px-3.5 py-3 text-center text-sm leading-5 text-ochre-800"
                  >
                    An administrator reset your face check. Sign in with your password to scan
                    your face again.
                  </div>
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
                  disabled={busy || recoveryRequestBusy}
                >
                  {busy ? "Signing in..." : "Login"}
                </button>

                {mode === "admin" && adminFailedAttempts >= 3 && (
                  recoveryRequestBusy ? (
                    <div
                      role="status"
                      aria-live="polite"
                      className="flex min-h-12 items-center justify-center gap-2 rounded-xl bg-cream-100 px-4 py-2 text-sm text-cocoa-600"
                    >
                      <svg
                        aria-hidden="true"
                        className="h-4 w-4 animate-spin text-ochre-700"
                        viewBox="0 0 24 24"
                        fill="none"
                      >
                        <circle
                          className="opacity-25"
                          cx="12"
                          cy="12"
                          r="10"
                          stroke="currentColor"
                          strokeWidth="4"
                        />
                        <path
                          className="opacity-75"
                          fill="currentColor"
                          d="M4 12a8 8 0 0 1 8-8V0C5.373 0 0 5.373 0 12h4z"
                        />
                      </svg>
                      Sending recovery code...
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="min-h-12 w-full py-2 text-sm font-semibold text-ochre-800 underline underline-offset-2"
                      disabled={busy || !username.trim()}
                      onClick={requestRecoveryCode}
                    >
                      Forgot password?
                    </button>
                  )
                )}

              </form>
            )}
          </div>
        </div>

      {/* Session conflict popup */}
      {sessionConflict && createPortal(
        <div className="fixed inset-0 z-[100] grid place-items-center bg-cocoa-900/70 p-4">
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
        </div>,
        document.body
      )}
      </section>
    </main>
  );
}
