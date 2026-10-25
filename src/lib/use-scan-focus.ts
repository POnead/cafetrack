"use client";

import { useEffect, type RefObject } from "react";

/**
 * Keeps a barcode field focused when nobody is deliberately typing elsewhere.
 *
 * ## Why this exists
 *
 * A USB barcode scanner is a keyboard. It types the code at speed and presses
 * Enter, and it does it without clicking anything first. If the operator has
 * touched the screen since the page loaded — and on a till they touch it
 * constantly — the keystrokes go wherever focus happens to be, and the scan is
 * silently lost. Nothing looks wrong; the item simply does not appear in the cart.
 *
 * So the field takes focus back. Every `intervalMs`, and only when it is safe to:
 * the guard below refuses to steal focus from anything the operator could plausibly
 * be typing into, because a scanner that yanks the cursor out of a quantity box
 * mid-entry is worse than one that misses a scan.
 *
 * ## Why it is a hook
 *
 * Because this behaviour has now been lost once. The scan field was a shared
 * `ScanInput` component that had it, and a rewrite of the checkout search —
 * a better one, with a results dropdown and a clear button — replaced it with an
 * inline `<input>` that kept `autoFocus` and Enter-to-submit but quietly dropped
 * the refocus. `autoFocus` only runs on mount, so the field looked correct and
 * stopped working the moment anyone clicked the page.
 *
 * The user tour caught it, because it asserts the behaviour rather than the markup.
 * The point of extracting this is that the next rewrite has one import to keep
 * rather than a block of logic to remember.
 */
export function useScanFocus(
  ref: RefObject<HTMLInputElement | null>,
  enabled = true,
  intervalMs = 800
): void {
  useEffect(() => {
    if (!enabled) return;

    const refocus = () => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return;

      // Already ours, or sitting in something the operator is working in.
      if (ref.current && el === ref.current) return;

      const tag = el.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (el.isContentEditable) return;
      // A dialog or menu owns the keyboard while it is open.
      if (el.closest('[role="dialog"], [role="listbox"], [role="menu"]')) return;

      ref.current?.focus();
    };

    const t = setInterval(refocus, intervalMs);
    return () => clearInterval(t);
  }, [ref, enabled, intervalMs]);
}
