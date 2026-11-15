"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Feature = {
  id: string;
  headline: [string, string];
  body: string;
};

/** CafeTrack features shown as rotating copy in the login hero. */
const FEATURES: Feature[] = [
  {
    id: "track-stock",
    headline: ["Every item", "in view."],
    body: "Check live quantities, locations, and stock levels across your cafe inventory.",
  },
  {
    id: "manage-restocks",
    headline: ["Restock before", "the rush."],
    body: "See what needs replenishing and record deliveries with supplier and batch details.",
  },
  {
    id: "inventory-alerts",
    headline: ["Catch stock and", "expiry issues early."],
    body: "Spot low or empty stock, and keep an eye on items nearing their expiry date.",
  },
  {
    id: "team-sync",
    headline: ["Keep your team", "in sync."],
    body: "Staff and admins share one workspace for inventory, restocks, and daily activity.",
  },
  {
    id: "waste-logging",
    headline: ["Log waste", "with a reason."],
    body: "Record spoilage and spills against the right stock batch, with a reason for each log.",
  },
  {
    id: "reports",
    headline: ["Turn stock activity", "into insight."],
    body: "Review inventory and movement reports, then export or email a PDF.",
  },
  {
    id: "approvals",
    headline: ["Keep item changes", "reviewed."],
    body: "Admins can review staff item submissions and change requests before approval.",
  },
  {
    id: "activity-history",
    headline: ["Know what changed", "and when."],
    body: "Review checkout, restock, and waste transactions by date and activity type.",
  },
];

/** How long each slide shows before the carousel advances automatically. */
const AUTO_ADVANCE_MS = 5000;

export default function FeatureCarousel() {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const touchStartX = useRef(0);
  const count = FEATURES.length;

  const next = useCallback(() => setIndex((i) => (i + 1) % count), [count]);
  const prev = useCallback(() => setIndex((i) => (i - 1 + count) % count), [count]);

  // Autoplay: advances every few seconds, and only pauses when the tab is
  // hidden. It runs regardless of the OS's reduced-motion preference: this
  // machine runs with animations disabled, which used to freeze the copy in
  // place forever — the operator asked for the slide to always move.
  useEffect(() => {
    if (paused) {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      return;
    }
    timerRef.current = setInterval(next, AUTO_ADVANCE_MS);
    return () => {
      clearInterval(timerRef.current!);
      timerRef.current = null;
    };
  }, [next, paused]);

  useEffect(() => {
    const onVisibility = () => setPaused(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  const handleTouchStart = useCallback((event: React.TouchEvent) => {
    touchStartX.current = event.touches[0].clientX;
  }, []);

  const handleTouchEnd = useCallback(
    (event: React.TouchEvent) => {
      const dx = event.changedTouches[0].clientX - touchStartX.current;
      if (dx > 30) prev();
      else if (dx < -30) next();
    },
    [prev, next]
  );

  return (
    <section
      aria-label="CafeTrack core features"
      aria-roledescription="carousel"
      className="relative z-10 mt-4 h-[160px] w-full [@media(max-height:700px)]:mt-2 [@media(max-height:700px)]:h-[140px]"
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      {/*
        The leaving and the arriving slide both stay mounted during a change,
        so the copy can crossfade instead of cutting — the previous version
        unmounted the old text outright, which is why the transition read as
        "nothing happening". Only the active slide is reachable by pointer or
        screen reader; the wrapper carries the live region.
      */}
      <div className="relative h-full" aria-live="polite" aria-atomic="true">
        {FEATURES.map((feature, slideIndex) => {
          const active = slideIndex === index;
          return (
            <div
              key={feature.id}
              aria-hidden={!active}
              className={`feature-slide absolute inset-0 h-full overflow-hidden transition-[opacity,transform,filter] duration-500 ease-out ${
                active
                  ? "translate-x-0 opacity-100 blur-0"
                  : "pointer-events-none translate-x-4 opacity-0 blur-sm"
              }`}
            >
              <FeatureCopy feature={feature} />
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** The headline and supporting copy for one slide. */
function FeatureCopy({ feature }: { feature: Feature }) {
  return (
    <>
      <h1 className="max-w-lg font-serif text-4xl font-medium leading-[1.05] tracking-tight text-cream-50 xl:text-5xl">
        {feature.headline[0]}
        <br />
        <span className="italic text-cream-400">{feature.headline[1]}</span>
      </h1>
      <p className="line-clamp-2 max-w-md text-sm leading-6 text-cream-100/60">
        {feature.body}
      </p>
    </>
  );
}
