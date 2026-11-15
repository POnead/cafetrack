"use client";

import { useEffect, useState } from "react";

/**
 * Whether the screen is narrower than the given breakpoint.
 *
 * Charts need to know: a horizontal bar chart with a category name down the
 * side needs a different label width on a phone than on a desktop, and an
 * axis with four ticks does not need four labels on a phone.
 *
 * It starts false on the server and settles on the client, which is the only
 * safe order — the first paint is the wide one and the chart re-measures
 * itself a moment later.
 */
export function useIsNarrow(breakpoint = 640): boolean {
  const [narrow, setNarrow] = useState(false);

  useEffect(() => {
    const query = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const update = () => setNarrow(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [breakpoint]);

  return narrow;
}
