"use client";

/**
 * Which face engine to run on this page, and how to read a face with it.
 *
 * Two things that were previously implicit are now explicit here:
 *
 *   - the *engine* is a property of the cafe, read once per page from
 *     /api/face/config, so the sign-in screen and the duty check cannot disagree
 *     about which model they are running;
 *   - reading a face always goes through `readFaceFor`, so a screens' choice of
 *     engine is one argument rather than an import that might be the wrong one.
 *
 * Enrolment is the exception, and deliberately so: it uses `useEnrolmentEngine`,
 * which prefers the new engine whenever its models are installed. That is what
 * lets a cafe migrate without a maintenance window — new enrolments land in the
 * new space while the cafe still verifies in the old one, and nobody is locked
 * out until every account holds both.
 */
import { useEffect, useState } from "react";
import type { FaceEngine } from "./face";
import { readFace, type FaceRead } from "./face-client";
import { readFaceSface, sfaceModelsPresent, type SfaceRead } from "./face-sface";

/** Both readers return the same shape once the engine is chosen. */
export type EngineRead = FaceRead | SfaceRead;

let cachedConfig: FaceEngine | null = null;
let configRequest: Promise<FaceEngine> | null = null;

/**
 * The cafe's engine, or "legacy" until the config arrives.
 *
 * Legacy is the safe default: it is what every existing enrolment holds, so a
 * page that renders and captures before the fetch lands still produces a vector
 * that this cafe can compare.
 */
export function useFaceEngine(): FaceEngine {
  const [engine, setEngine] = useState<FaceEngine>(cachedConfig ?? "legacy");

  useEffect(() => {
    if (cachedConfig) {
      setEngine(cachedConfig);
      return;
    }

    let cancelled = false;
    configRequest ??= fetch("/api/face/config", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => (data?.engine === "sface" ? "sface" : "legacy") as FaceEngine)
      .catch(() => "legacy" as FaceEngine);

    void configRequest.then((value) => {
      cachedConfig = value;
      if (!cancelled) setEngine(value);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  return engine;
}

//** Read one face with the given engine. The call sites never pick a model themselves. */
export async function readFaceFor(
  engine: FaceEngine,
  source: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement
): Promise<EngineRead> {
  if (engine === "sface") {
    try {
      return await readFaceSface(source);
    } catch (e) {
      /*
       * A new engine that will not start must not take sign-in down with it.
       *
       * The failure this catches is a missing or unloadable wasm/model pair — a
       * deployment problem, not a face problem — and the old engine is still
       * installed and still matches the vectors this cafe may hold. Falling back
       * costs accuracy and keeps the till working, which is the right trade at a
       * counter with a queue.
       */
      console.error("sface engine failed, falling back to the legacy reader:", e);
      return readFace(source);
    }
  }

  return readFace(source);
}

