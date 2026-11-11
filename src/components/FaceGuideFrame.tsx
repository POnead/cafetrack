"use client";

/**
 * The live guide drawn over the camera — one design, every face screen.
 *
 * Enrolment and the Face++ login/duty check both need the same things on screen:
 * which view is being asked for, a head-sized outline to sit inside, the
 * sentence that says what to change, a hold bar while the frame is accepted, and
 * a head-angle meter so "turn further" is a visible target rather than a guess.
 *
 * This component is only the presentation. The two callers decide the words and
 * the numbers, so the enrolment guide and the check guide cannot drift into
 * different layouts while still sharing `lib/face-guide` for the meaning.
 *
 * ## No scores
 *
 * There is no similarity percentage and no "confidence". The meter shows head
 * angle, which is what the gate decides on; a number that looked like a match
 * score would imply the recognition result is already known here, and it is not
 * — that is the server's call. The one thing this deliberately shows is *pose*,
 * because pose is the part the person can still fix.
 */

import { meterPercent } from "@/lib/face-guide";

export type GuideBand = [number, number];

type Props = {
  /** The name in the top pill: "Straight on", "Turn left", "Blink". */
  label: string;
  /** The counter in the same pill: "View 1 of 4". */
  viewLabel: string;
  /** The bold sentence in the bottom card. */
  title: string;
  /** The live instruction under it. */
  hint: string;
  /** Whether the outline should turn green — the requested pose is accepted. */
  inBand: boolean;
  /** 0..1 through the hold-still window. Hidden at 0. */
  holdProgress: number;
  /** Hide the hold bar when progress represents a multi-frame action. */
  showHoldProgress?: boolean;
  /** The meter's target ranges, in degrees. Empty when the view has no angle. */
  bands: readonly GuideBand[];
  /** The live yaw, or null when no face is being read. */
  yaw: number | null;
  /** Replaces title/hint briefly after an accepted frame. */
  flashText?: string | null;
  /** Dev-only raw angles; see `?pose=debug`. */
  debugText?: string | null;
  /** Renders the text and angle meter below the camera instead of over it. */
  display?: "overlay" | "instructions";
};

export default function FaceGuideFrame({
  label,
  viewLabel,
  title,
  hint,
  inBand,
  holdProgress,
  showHoldProgress = true,
  bands,
  yaw,
  flashText = null,
  debugText = null,
  display = "overlay",
}: Props) {
  const yawInTargetBand =
    yaw !== null &&
    Number.isFinite(yaw) &&
    bands.some(([from, to]) => yaw >= from && yaw <= to);

  if (display === "instructions") {
    return (
      <div className="space-y-2 rounded-xl border border-cream-200 bg-cream-50 px-3.5 py-3 text-center text-cocoa-800">
        {flashText ? (
          <p role="status" className="text-sm font-semibold text-sage-700">
            {flashText}
          </p>
        ) : (
          <>
            <p className="text-sm font-semibold leading-snug">{title}</p>
            <p role="status" aria-live="polite" className="text-xs leading-relaxed text-cocoa-600">
              {hint}
            </p>
          </>
        )}

        {showHoldProgress && holdProgress > 0 && (
          <div
            role="progressbar"
            aria-label="Hold still to capture"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(holdProgress * 100)}
            className="h-1 overflow-hidden rounded-full bg-cream-200"
          >
            <div
              className="h-full rounded-full bg-sage-500 transition-[width] duration-150"
              style={{ width: `${Math.round(holdProgress * 100)}%` }}
            />
          </div>
        )}

        <div className="mx-auto w-full max-w-[200px]">
          <div className="relative h-1 overflow-hidden rounded-full bg-cream-200">
            {bands.map(([from, to], index) => (
              <div
                key={index}
                className={`absolute inset-y-0 rounded-full ${yawInTargetBand ? "bg-sage-500" : "bg-cocoa-400"}`}
                style={{
                  // The preview is mirrored, so the meter runs backwards: a turn
                  // to the person's own left (positive yaw) lands on screen-left.
                  left: `${meterPercent(-to)}%`,
                  width: `${meterPercent(-from) - meterPercent(-to)}%`,
                }}
              />
            ))}
            {yaw !== null && (
              <div
                className={`absolute inset-y-0 w-0.5 rounded-full transition-colors duration-150 ${
                  yawInTargetBand ? "bg-sage-700" : "bg-cocoa-900"
                }`}
                style={{ left: `${meterPercent(-yaw)}%` }}
              />
            )}
          </div>
          <div className="mt-1 flex justify-between text-[9px] text-cocoa-500">
            <span>your left</span>
            <span>your right</span>
          </div>
        </div>

        {debugText && (
          <p className="font-mono text-[10px] leading-tight text-cocoa-500">
            {debugText}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="pointer-events-none absolute inset-0 z-10 p-2.5 sm:p-3">
      <div
        aria-hidden="true"
        className={`absolute left-1/2 top-[12%] h-[72%] w-[66%] -translate-x-1/2 border-2 transition-[border-color] duration-200 ${
          inBand
            ? "face-guide-in-band border-sage-300/90"
            : "border-cream-100/55"
        }`}
        style={{
          borderRadius: "50% 50% 46% 46% / 34% 34% 62% 62%",
        }}
      />
      <div className="absolute left-2 right-2 top-2 flex items-center justify-between gap-2 sm:left-3 sm:right-3 sm:top-3">
        <span className="rounded-full bg-cocoa-900/80 px-3 py-1.5 text-xs font-semibold text-cream-100 shadow-sm backdrop-blur-sm">
          {label}
        </span>
        <span className="rounded-full bg-cocoa-900/70 px-2.5 py-1.5 text-[11px] font-medium text-cream-100/80 shadow-sm backdrop-blur-sm">
          {viewLabel}
        </span>
      </div>
    </div>
  );
}
