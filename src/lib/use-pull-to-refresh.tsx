"use client";

import { useEffect, useRef, useState } from "react";

const REFRESH_THRESHOLD = 72;
const MAX_PULL = 92;

export function usePullToRefresh(onRefresh: () => void | Promise<void>) {
  const pullStart = useRef<{ x: number; y: number } | null>(null);
  const refreshing = useRef(false);
  const onRefreshRef = useRef(onRefresh);
  const feedbackTimer = useRef<number | null>(null);
  const [pullDistance, setPullDistance] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [result, setResult] = useState<"complete" | "failed" | null>(null);

  onRefreshRef.current = onRefresh;

  useEffect(
    () => () => {
      if (feedbackTimer.current !== null) {
        window.clearTimeout(feedbackTimer.current);
      }
    },
    []
  );

  const resetPull = () => {
    pullStart.current = null;
    setPullDistance(0);
  };

  const onTouchStart = (event: React.TouchEvent<HTMLDivElement>) => {
    if (refreshing.current || event.touches.length !== 1) {
      resetPull();
      return;
    }

    const target = event.target;
    if (
      !(target instanceof Element) ||
      target.closest(
        "a, button, input, select, textarea, form, [role='button'], [role='dialog'], [role='alertdialog'], [aria-modal='true'], [contenteditable='true'], [data-pull-refresh-ignore]"
      )
    ) {
      resetPull();
      return;
    }

    const scrollSurface = event.currentTarget.closest<HTMLElement>(".app-main");
    if (!scrollSurface || scrollSurface.scrollTop > 0) {
      resetPull();
      return;
    }

    setResult(null);
    pullStart.current = {
      x: event.touches[0].clientX,
      y: event.touches[0].clientY,
    };
  };

  const onTouchMove = (event: React.TouchEvent<HTMLDivElement>) => {
    const start = pullStart.current;
    if (!start || event.touches.length !== 1) {
      resetPull();
      return;
    }

    const touch = event.touches[0];
    const deltaX = touch.clientX - start.x;
    const deltaY = touch.clientY - start.y;
    if (deltaY <= 0 || Math.abs(deltaX) > Math.abs(deltaY)) {
      resetPull();
      return;
    }

    if (deltaY > 8) {
      setPullDistance(Math.min(deltaY, MAX_PULL));
    }
  };

  const onTouchEnd = (event: React.TouchEvent<HTMLDivElement>) => {
    const start = pullStart.current;
    pullStart.current = null;

    const touch = event.changedTouches[0];
    const scrollSurface = event.currentTarget.closest<HTMLElement>(".app-main");
    if (
      !start ||
      !touch ||
      Math.abs(touch.clientX - start.x) > Math.abs(touch.clientY - start.y) ||
      touch.clientY - start.y < REFRESH_THRESHOLD ||
      !scrollSurface ||
      scrollSurface.scrollTop > 0 ||
      refreshing.current
    ) {
      setPullDistance(0);
      return;
    }

    refreshing.current = true;
    setIsRefreshing(true);
    setPullDistance(0);
    setResult(null);
    if (feedbackTimer.current !== null) {
      window.clearTimeout(feedbackTimer.current);
    }

    void (async () => {
      let completed = true;
      try {
        await onRefreshRef.current();
      } catch {
        completed = false;
      } finally {
        refreshing.current = false;
        setIsRefreshing(false);
        setResult(completed ? "complete" : "failed");
        feedbackTimer.current = window.setTimeout(() => setResult(null), 1200);
      }
    })();
  };

  const active = pullDistance > 0 || isRefreshing || result !== null;
  const message = isRefreshing
    ? "Refreshing…"
    : result === "complete"
      ? "Refresh complete"
      : result === "failed"
        ? "Refresh failed"
        : pullDistance >= REFRESH_THRESHOLD
          ? "Release to refresh"
          : "Pull down to refresh";
  const indicatorHeight = isRefreshing || result ? 48 : Math.min(pullDistance, REFRESH_THRESHOLD);

  return {
    handlers: {
      onTouchStart,
      onTouchMove,
      onTouchEnd,
      onTouchCancel: resetPull,
    },
    indicator: (
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        aria-hidden={!active}
        className="flex items-center justify-center gap-2 overflow-hidden text-xs font-semibold text-cocoa-500 transition-[height,opacity] duration-150"
        style={{ height: indicatorHeight, opacity: active ? 1 : 0 }}
      >
        {active && (
          <>
            <span
              aria-hidden="true"
              className={`text-base leading-none ${
                isRefreshing ? "animate-spin" : ""
              }`}
            >
              ↻
            </span>
            <span>{message}</span>
          </>
        )}
      </div>
    ),
  };
}
