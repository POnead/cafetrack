"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { captureIdFrame } from "./id-camera";
import {
  captureRectifiedIdFrame,
  detectIdCard,
  type CardCorners,
} from "./id-card-scanner";

export type IdCapturePhase = "waiting" | "adjust" | "hold" | "capturing" | "manual";

type FrameSample = {
  luminance: Uint8Array;
  mean: number;
  edgeRatio: number;
};

type AutoIdCaptureOptions = {
  videoRef: RefObject<HTMLVideoElement | null>;
  active: boolean;
  paused?: boolean;
  onCapture: (file: File) => void | Promise<void>;
  timeoutMs?: number;
  stableFrames?: number;
};

const SAMPLE_WIDTH = 128;
const SAMPLE_HEIGHT = 80;
const SAMPLE_INTERVAL_MS = 250;
const DETAIL_THRESHOLD = 0.025;
const STABLE_DELTA = 0.035;

function sampleCardArea(video: HTMLVideoElement): FrameSample | null {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) return null;

  const cardRatio = 1.585;
  const sourceRatio = width / height;
  const cropWidth = sourceRatio > cardRatio ? height * cardRatio : width;
  const cropHeight = sourceRatio > cardRatio ? height : width / cardRatio;
  const sx = (width - cropWidth) / 2;
  const sy = (height - cropHeight) / 2;

  const canvas = document.createElement("canvas");
  canvas.width = SAMPLE_WIDTH;
  canvas.height = SAMPLE_HEIGHT;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(video, sx, sy, cropWidth, cropHeight, 0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);

  const rgba = context.getImageData(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT).data;
  const luminance = new Uint8Array(SAMPLE_WIDTH * SAMPLE_HEIGHT);
  let total = 0;
  let edges = 0;

  for (let y = 0; y < SAMPLE_HEIGHT; y++) {
    for (let x = 0; x < SAMPLE_WIDTH; x++) {
      const pixel = y * SAMPLE_WIDTH + x;
      const offset = pixel * 4;
      const value = Math.round(
        rgba[offset] * 0.299 + rgba[offset + 1] * 0.587 + rgba[offset + 2] * 0.114
      );
      luminance[pixel] = value;
      total += value;

      if (x > 0 && Math.abs(value - luminance[pixel - 1]) > 22) edges++;
      if (y > 0 && Math.abs(value - luminance[pixel - SAMPLE_WIDTH]) > 22) edges++;
    }
  }

  return {
    luminance,
    mean: total / luminance.length,
    edgeRatio: edges / (SAMPLE_WIDTH * SAMPLE_HEIGHT * 2),
  };
}

function frameDelta(before: Uint8Array, after: Uint8Array): number {
  let difference = 0;
  for (let i = 0; i < before.length; i++) {
    difference += Math.abs(before[i] - after[i]);
  }
  return difference / before.length / 255;
}

export function useAutoIdCapture({
  videoRef,
  active,
  paused = false,
  onCapture,
  timeoutMs = 30_000,
  stableFrames = 5,
}: AutoIdCaptureOptions) {
  const [phase, setPhase] = useState<IdCapturePhase>("waiting");
  const [holdProgress, setHoldProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const callbackRef = useRef(onCapture);
  const capturingRef = useRef(false);
  const autoStoppedRef = useRef(false);

  useEffect(() => {
    callbackRef.current = onCapture;
  }, [onCapture]);

  const capture = useCallback(async (automatic: boolean, corners?: CardCorners) => {
    if (capturingRef.current) return;
    const video = videoRef.current;
    if (!video) return;

    capturingRef.current = true;
    autoStoppedRef.current = true;
    setPhase("capturing");
    setError(null);
    try {
      const file =
        automatic && corners
          ? await captureRectifiedIdFrame(video, corners, "front")
          : await captureIdFrame(video, "front");
      await callbackRef.current(file);
      setPhase("manual");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "That picture could not be saved. Try taking it again."
      );
      setPhase("manual");
    } finally {
      capturingRef.current = false;
    }

    if (automatic) setHoldProgress(1);
  }, [videoRef]);

  const captureManually = useCallback(() => capture(false), [capture]);
  const resume = useCallback(() => {
    autoStoppedRef.current = false;
    setError(null);
    setHoldProgress(0);
    setPhase("waiting");
    setAttempt((value) => value + 1);
  }, []);

  useEffect(() => {
    if (!active) {
      autoStoppedRef.current = false;
      setPhase("waiting");
      setHoldProgress(0);
      setError(null);
      return;
    }
    if (paused || autoStoppedRef.current) return;

    let cancelled = false;
    let previous: Uint8Array | null = null;
    let steadyCount = 0;
    const startedAt = Date.now();

    const inspect = async () => {
      if (cancelled || autoStoppedRef.current) return;
      if (capturingRef.current) return;
      const video = videoRef.current;
      const sample = video ? sampleCardArea(video) : null;
      if (!sample) {
        setPhase("waiting");
        setHoldProgress(0);
      } else {
        let corners: CardCorners | null;
        try {
          corners = video ? await detectIdCard(video) : null;
        } catch (cause) {
          autoStoppedRef.current = true;
          setError(
            cause instanceof Error
              ? `The local card scanner could not start: ${cause.message}`
              : "The local card scanner could not start. Capture manually or choose a photo."
          );
          setPhase("manual");
          return;
        }

        const wellLit = sample.mean >= 28 && sample.mean <= 238;
        const hasDetail = sample.edgeRatio >= DETAIL_THRESHOLD;
        const steady =
          previous !== null && frameDelta(previous, sample.luminance) <= STABLE_DELTA;
        previous = sample.luminance;

        if (!corners || !wellLit || !hasDetail) {
          steadyCount = 0;
          setPhase("adjust");
          setHoldProgress(0);
        } else if (!steady) {
          steadyCount = 0;
          setPhase("hold");
          setHoldProgress(0);
        } else {
          steadyCount++;
          const progress = Math.min(1, steadyCount / stableFrames);
          setHoldProgress(progress);
          setPhase(progress >= 1 ? "capturing" : "hold");
          if (progress >= 1) {
            await capture(true, corners);
            return;
          }
        }
      }

      if (Date.now() - startedAt >= timeoutMs) {
        autoStoppedRef.current = true;
        setPhase("manual");
        return;
      }
      window.setTimeout(() => void inspect(), SAMPLE_INTERVAL_MS);
    };

    void inspect();
    return () => {
      cancelled = true;
    };
  }, [active, attempt, capture, paused, stableFrames, timeoutMs, videoRef]);

  const message =
    error ??
    (phase === "waiting"
      ? "Looking for the whole ID card. Center all four edges inside the guide."
      : phase === "adjust"
        ? "Card not detected yet. Show the whole card and keep all four edges inside the guide."
        : phase === "hold"
          ? "ID card detected. Hold the card still."
          : phase === "capturing"
            ? "Steady — capturing the ID…"
            : "Having trouble scanning? Adjust the card or capture it manually.");

  return { phase, holdProgress, message, captureManually, resume };
}
