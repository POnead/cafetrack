/**
 * The fallback shown while a route under (app) is being rendered.
 *
 * One file for the whole group rather than one per page: it only has to say
 * "something is coming" for the moment between a tap and the server's answer,
 * and a skeleton shaped like the page it stands in for is mostly a guess
 * anyway. The win is that a tap now paints immediately instead of leaving the
 * previous page's scroll position with nothing to show for it.
 *
 * Deliberately plain markup rather than the Card component: ui.tsx is a client
 * module, and a loading state is the one thing that should never cost a
 * round trip of JavaScript to appear.
 */
export default function Loading() {
  return (
    <div className="space-y-4" aria-busy="true">
      <div className="h-7 w-48 animate-pulse rounded-lg bg-cream-200" />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="card h-24 animate-pulse p-5" />
        ))}
      </div>

      <div className="card h-64 animate-pulse p-5" />

      <span className="sr-only">Loading…</span>
    </div>
  );
}