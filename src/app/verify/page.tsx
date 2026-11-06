"use client";

/**
 * The duty check a staff member passes before starting work.
 *
 * Shown after sign-in when the account still owes a check. The frames go to
 * Face++: Detect finds the face, reads its pose and its eye state (which is how
 * the open → closed → open blink is verified), and Compare matches the
 * straight-on frame with the photo enrolled on the account.
 *
 * The capture is automatic. The café's local pose gate decides when the
 * straight-on, left and right frames are ready, and a small landmark model times
 * the blink. That model never decides identity — it only decides when to take a
 * picture; Face++ still judges every frame.
 *
 * Three states, and the order matters:
 *
 *   loading   — reading whether a check is even owed, from /api/auth/me. The
 *               screen must never flash the camera at someone who is already
 *               inside their window, so this is a real state.
 *   capture   — the guided scan: straight on, left, right, blink.
 *   verifying — a full-screen hold while Face++ makes the decision.
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { describeCameraProblem } from "@/lib/face-diagnostics";
import {
  FACEPP_CAPTURE_COPY,
  facePlusPlusPermissionHelp,
  useFacePlusPlusCapture,
  type FacePlusPlusImages,
} from "@/lib/use-facepp-capture";

type Phase =
  | "loading"
  | "not-required"
  | "no-camera"
  | "capture"
  | "verifying"
  | "passed"
  | "failed";

type FaceStatus = {
  required: boolean;
  enabled: boolean;
  enrolled: boolean;
  dutyHours: number;
  verifiedAt: string | null;
  nextDueAt: string | null;
};

export default function VerifyPage() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("loading");
  const [message, setMessage] = useState<string | null>(null);
  const [status, setStatus] = useState<FaceStatus | null>(null);
  const [facePlusPlusState, setFacePlusPlusState] = useState<
    "checking" | "configured" | "unavailable"
  >("checking");

  const submitFrames = useCallback(
    async (images: FacePlusPlusImages) => {
      setPhase("verifying");
      setMessage(null);
      try {
        const res = await fetch("/api/auth/verify-face", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            face_images: {
              front: images.front,
              left: images.left,
              right: images.right,
            },
            blink_evidence: {
              before: images.before,
              closed: images.closed,
              after: images.after,
            },
          }),
        });
        const data = await res.json();

        if (res.ok && data.ok) {
          setPhase("passed");
          // Long enough to read the confirmation, then in.
          setTimeout(() => router.replace("/dashboard"), 1200);
          return;
        }

        setPhase("failed");
        setMessage(
          data.error ||
            "That face was not recognised. Try again, or ask your manager for an override."
        );
      } catch {
        setPhase("failed");
        setMessage("That could not be checked. Try again.");
      }
    },
    [router]
  );

  const capture = useFacePlusPlusCapture({ onComplete: submitFrames });

  // Ask whether a check is owed, and whether Face++ is configured. Both answers
  // are needed before a camera is ever opened.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [meRes, configRes] = await Promise.all([
          fetch("/api/auth/me", { cache: "no-store" }),
          fetch("/api/auth/face-login", { cache: "no-store" }).catch(() => null),
        ]);

        if (!meRes.ok) {
          router.replace("/login");
          return;
        }

        if (configRes) {
          const config = await configRes.json().catch(() => null);
          if (!cancelled) {
            setFacePlusPlusState(
              config?.facePlusPlusConfigured ? "configured" : "unavailable"
            );
          }
        } else if (!cancelled) {
          setFacePlusPlusState("unavailable");
        }

        const data = await meRes.json();
        if (cancelled) return;

        const face: FaceStatus = data.face;
        setStatus(face);

        if (!face.required) {
          router.replace("/dashboard");
          return;
        }
        if (!face.enrolled) {
          // The feature was switched on after this person was hired. They cannot
          // fix it from here; the manager standing next to them can.
          setPhase("no-camera");
          setMessage(
            "Your account has no reference photo yet, so there is nothing to " +
              "compare against. Ask your manager to enrol you, or approve this " +
              "duty for you."
          );
          return;
        }

        setPhase("capture");
      } catch {
        if (!cancelled) router.replace("/login");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  const start = useCallback(async () => {
    setMessage(null);
    setPhase("capture");

    if (facePlusPlusState === "unavailable") {
      setMessage(
        "Face check is unavailable right now. Ask your manager for help."
      );
      return;
    }

    if (await capture.start()) {
      setMessage(null);
    }
  }, [capture, facePlusPlusState]);

  if (phase === "loading") {
    return (
      <Screen title="Checking your duty status…">
        <Spinner label="" />
      </Screen>
    );
  }

  // Passed — the hold screen, so "reading" is never mistaken for "hung".
  if (phase === "verifying" || phase === "passed") {
    return (
      <Screen title={phase === "passed" ? "Face confirmed" : "Checking your face…"}>
        <div
          className={`mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full ${
            phase === "passed" ? "bg-ochre-100 text-ochre-700" : "bg-cream-200 text-cocoa-500"
          }`}
        >
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden>
            {phase === "passed" ? (
              <path d="m4 12 5 5L20 6" strokeLinecap="round" strokeLinejoin="round" />
            ) : (
              <>
                <circle cx="12" cy="12" r="9" opacity="0.25" />
                <path d="M12 7v5l3 2" strokeLinecap="round" strokeLinejoin="round" />
              </>
            )}
          </svg>
        </div>
        <p className="text-center text-sm text-cocoa-600">
          {phase === "passed"
            ? "You're on duty. Taking you in…"
            : "Checking your face…"}
        </p>
      </Screen>
    );
  }

  const problem = capture.blocked ? describeCameraProblem(capture.blocked) : null;

  return (
    <Screen
      title={
        phase === "no-camera" && !status?.enrolled
          ? "No reference photo"
          : "Duty face check"
      }
      subtitle={
        status
          ? `Password sign-in is complete. Duty face checks are on, so verify now to continue. One check covers ${status.dutyHours} hours.`
          : undefined
      }
    >
      {capture.phase === "camera" ? (
        <div className="mb-5 overflow-hidden rounded-2xl bg-cocoa-900 p-2 sm:p-3">
          <div className="relative mx-auto aspect-[4/5] max-h-[65vh] w-full max-w-sm overflow-hidden rounded-xl">
            <video
              ref={capture.attachStream}
              playsInline
              muted
              autoPlay
              className="block h-full w-full object-cover"
            />
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-between bg-gradient-to-b from-cocoa-900/45 via-transparent to-cocoa-900/75 p-4 text-center text-cream-100">
              <p className="rounded-full bg-cocoa-900/70 px-3 py-1 text-xs font-semibold">
                {FACEPP_CAPTURE_COPY[capture.stage].step}
              </p>
              <div className="flex aspect-square w-[72%] items-center justify-center rounded-[42%] border-4 border-cream-100/80">
                <span className="sr-only">Position your head inside the guide</span>
              </div>
              <p className="rounded-xl bg-cocoa-900/75 px-3 py-2 text-sm font-medium">
                {FACEPP_CAPTURE_COPY[capture.stage].prompt}
              </p>
            </div>
          </div>
        </div>
      ) : null}

      {capture.phase === "camera" ? (
        <div className="mb-4 space-y-3">
          <div className="h-1.5 overflow-hidden rounded-full bg-cream-200">
            <div
              className="h-full rounded-full bg-ochre-400 transition-[width] duration-150"
              style={{ width: `${Math.round(capture.holdProgress * 100)}%` }}
            />
          </div>
          {capture.showManual && (
            <button
              type="button"
              className="btn-primary min-h-12 w-full"
              onClick={capture.capture}
            >
              {FACEPP_CAPTURE_COPY[capture.stage].button}
            </button>
          )}
          {capture.message && (
            <p role="status" className="text-center text-xs text-cocoa-500">
              {capture.message}
            </p>
          )}
        </div>
      ) : (
        <div className="mb-4 flex justify-center">
          <button
            type="button"
            className="btn-primary"
            disabled={phase === "no-camera" || facePlusPlusState === "checking"}
            onClick={() => void start()}
          >
            {phase === "failed"
              ? "Try again"
              : facePlusPlusState === "checking"
                ? "Checking availability…"
                : facePlusPlusState === "unavailable"
                  ? "Face check unavailable"
                  : "Turn on the camera"}
          </button>
        </div>
      )}

      {problem && (
        <div
          role="status"
          className="mb-4 space-y-2 rounded-xl border border-terracotta-100 bg-terracotta-50 px-4 py-3.5 text-sm leading-relaxed text-terracotta-700"
        >
          <p className="font-semibold">{problem.message}</p>
          <p>
            {capture.blocked === "permission-denied"
              ? facePlusPlusPermissionHelp()
              : problem.help}
          </p>
        </div>
      )}

      {message && (
        <div
          role="status"
          className={`mt-4 rounded-2xl border px-4 py-3.5 text-sm leading-relaxed ${
            phase === "failed"
              ? "border-terracotta-100 bg-terracotta-50 text-terracotta-700"
              : "border-amber-200 bg-amber-50 text-cocoa-700"
          }`}
        >
          {message}
        </div>
      )}

      <button
        type="button"
        className="mt-4 w-full rounded-xl px-3 py-2.5 text-center text-sm font-medium text-cocoa-500 transition hover:bg-cream-100 hover:text-cocoa-700"
        onClick={() => router.replace("/login")}
      >
        Sign out
      </button>
    </Screen>
  );
}

/** Shared chrome. Kept here so the three states cannot drift apart. */
function Screen({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-[100svh] items-center justify-center bg-cream-50 px-4 py-8 sm:px-6 sm:py-12">
      <div className="w-full max-w-md text-center">
        <div className="script-logo-dark mb-5 text-3xl">CafeTrack</div>
        <h1 className="deco-title text-3xl sm:text-4xl">{title}</h1>
        {subtitle && <p className="mt-2 text-sm text-cocoa-500">{subtitle}</p>}
        <div className="mt-6 rounded-3xl border border-cream-200 bg-cream-50/70 p-4 text-left shadow-sm sm:p-6">
          {children}
        </div>
      </div>
    </div>
  );
}

function Spinner({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center gap-2">
      <div className="h-8 w-8 animate-spin rounded-full border-[3px] border-cream-200 border-t-ochre-400" />
      {label && <p className="text-sm text-cocoa-500">{label}</p>}
    </div>
  );
}
