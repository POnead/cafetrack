"use client";

/**
 * The loading screen shown while one angle is being read.
 *
 * It covers the live preview rather than sitting beside it: the person has just
 * been asked to hold a pose, and a frame that keeps moving while it is being read
 * is the one thing they can still get wrong. Covering the preview also makes the
 * hand-off to the next prompt unmistakable — the picture comes back with a new
 * instruction on it.
 *
 * Deliberately no score or percentage. "Scanning" is the whole message; a number
 * that is not the match distance would imply a precision the check does not have.
 */
export default function FaceScanOverlay({
  step,
  total,
}: {
  /** 1-based index of the angle being read. */
  step: number;
  /** How many angles the presentation needs. */
  total: number;
}) {
  return (
    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center rounded-xl bg-cocoa-900/95 px-6 py-8 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-full border border-cream-100/15 bg-cream-100/5">
        <div className="h-9 w-9 animate-spin rounded-full border-[3px] border-cream-200/25 border-t-ochre-400" />
      </div>
      <p className="mt-5 text-base font-semibold text-cream-100">Reading this view</p>
      <p className="mt-1 text-sm text-cream-100/70">Hold still while we check it.</p>
      <div className="mt-5 flex items-center gap-2" aria-hidden>
        {Array.from({ length: total }, (_, index) => (
          <span
            key={index}
            className={`h-1.5 rounded-full transition-all ${
              index + 1 === step
                ? "w-8 bg-ochre-400"
                : index + 1 < step
                  ? "w-4 bg-sage-400"
                  : "w-4 bg-cream-100/25"
            }`}
          />
        ))}
      </div>
      <p className="mt-2 text-xs text-cream-100/55">
        {step} of {total}
      </p>
    </div>
  );
}
