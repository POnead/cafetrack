"use client";

import { useEffect, useRef, useState } from "react";

/**
 * A polite live region, for announcing things that change without a click.
 *
 * Reusing the toast would be wrong: a toast is a reaction to something a person
 * did, this is the app talking to itself. Someone scanning items in another tab
 * does not want a stack of "stock changed" popups over the till — they want the
 * numbers, quietly, to be right.
 *
 * `role="status"` with `aria-live="polite"` is what makes a screen reader say it
 * at the next natural pause rather than interrupting whatever it is currently
 * reading. Nothing here is an alert: nothing demands attention.
 *
 * The state/ref pair is deliberate. A screen reader announces a change in the
 * content of a region that is already on the page, not the insertion of a new
 * one — so the usual `{message && <div>{message}</div>}` shape is silent. One
 * node is kept mounted for the region's lifetime and only its text is swapped.
 */
export function LiveRegion({ message }: { message: string | null }) {
  const [text, setText] = useState<string | null>(null);

  // Ref tracks the last value so a repeated identical message still moves the
  // text off itself and back, which is what makes a repeat announce.
  const previous = useRef<string | null>(null);

  useEffect(() => {
    if (message === previous.current) return;
    previous.current = message;
    setText(message);
  }, [message]);

  return (
    <div aria-live="polite" role="status" className="sr-only">
      {text}
    </div>
  );
}