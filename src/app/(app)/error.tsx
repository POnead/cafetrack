"use client";

import { useEffect } from "react";
import Link from "next/link";

/**
 * Error boundary for everything inside the signed-in area. Next.js renders this
 * instead of the page when a client render throws, so a single broken screen
 * never takes the whole app down with it.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The server log has the stack; this is the only trace the browser keeps.
    console.error("CafeTrack page error:", error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="card max-w-md space-y-3 p-8 text-center">
        <div className="deco-title text-3xl">Something went wrong</div>
        <p className="text-sm text-cocoa-500">
          This page hit an unexpected error. Try again — and if it keeps
          happening, check the audit trail for what was recorded.
        </p>
        {error.digest && (
          <p className="font-mono text-[11px] text-cocoa-300">
            Reference: {error.digest}
          </p>
        )}
        <div className="flex justify-center gap-2 pt-1">
          <button className="btn-ghost" onClick={reset}>
            Try again
          </button>
          <Link href="/dashboard" className="btn-primary">
            Back to dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}
