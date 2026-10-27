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
import {
  DEFAULT_FACE_ENGINE,
  parseEngine,
  poseFromSignal,
  type FaceEngine,
  type FacePose,
} from "./face";
import { poseStateFromAngles, type HeadPose, type PoseState } from "./head-pose";
import { detectFaceOnly, readFace, type FaceOnlyRead, type FaceRead } from "./face-client";
import {
  detectSfaceOnly,
  readFaceSface,
  sfaceModelsPresent,
  type SfaceRead,
} from "./face-sface";

/** Both readers return the same shape once the engine is chosen. */
export type EngineRead = FaceRead | SfaceRead;

/** Both scan gates return the same shape once the engine is chosen. */
export type EngineDetect = FaceOnlyRead | SfaceRead;

/**
 * The two pose fields every successful reading carries, whatever the engine.
 *
 * A helper type rather than `EngineRead | EngineDetect` so the function can be
 * called from inside an `if (result.ok)` branch without re-narrowing the union.
 */
export type PoseBearing = {
  headPose: HeadPose | null;
  poseSignal: number | null;
};

/**
 * Which angle a reading shows, preferring the real pose over the old proxy.
 *
 * `headPose` is an angle in degrees, solved from the landmarks; `poseSignal` is
 * the old 2D distance ratio kept for the samples that stored it. Every screen
 * should go through this so a reading is interpreted one way only — the whole
 * reason the old gate flickered was that different screens compared different
 * numbers against different bands.
 *
 * Falls back to the proxy only when there is no pose at all (a degenerate
 * landmark fit). A pose that *is* there but is tilted or half-turned deliberately
 * returns null rather than falling through: those frames should be refused, and
 * the old proxy would happily call a tilted head "straight on".
 */
export function poseOfRead(read: PoseBearing): FacePose | null {
  return poseStateOfRead(read).pose;
}

/**
 * The same decision, with the reason it is not a pose.
 *
 * `poseOfRead` answers "which angle is this?" and throws away *why* the answer
 * was no angle. Every screen then had to invent a reason, and the one they
 * invented was "not turned far enough" — for a head that was too far round, for
 * one that was tilted, and for one that was looking at the ceiling. A person
 * following that advice turns further, which moves the head further from the band
 * the gate wants, and the screen repeats itself until the prompt times out.
 *
 * So the block is carried, not dropped. Anything that needs to tell the person
 * what to change takes this, and only the pose-only callers use `poseOfRead`.
 */
export function poseStateOfRead(read: PoseBearing): PoseState {
  if (read.headPose) return poseStateFromAngles(read.headPose);

  /*
   * No angle at all — the landmark fit was degenerate. Fall back to the old 2D
   * proxy for the pose, but do not pretend to have angles: NaN is honest, and
   * every consumer checks for it before drawing a needle.
   */
  const pose = poseFromSignal(read.poseSignal);
  return {
    pose,
    block: pose ? null : "between",
    yaw: Number.NaN,
    pitch: Number.NaN,
    roll: Number.NaN,
  };
}

let cachedConfig: FaceEngine | null = null;
let configRequest: Promise<FaceEngine> | null = null;

/**
 * The cafe's engine, or the default until the config arrives.
 *
 * SFace is the default now, and it is also what `getFaceEngine` falls back to, so
 * a page that renders before the fetch lands still computes a vector the cafe can
 * compare. A cafe that has deliberately stayed on `legacy` will correct itself on
 * the first config response — one frame, before any capture can complete.
 */
export function useFaceEngine(): FaceEngine {
  const [engine, setEngine] = useState<FaceEngine>(cachedConfig ?? DEFAULT_FACE_ENGINE);

  useEffect(() => {
    if (cachedConfig) {
      setEngine(cachedConfig);
      return;
    }

    let cancelled = false;
    configRequest ??= fetch("/api/face/config", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => (parseEngine(data?.engine) ?? DEFAULT_FACE_ENGINE) as FaceEngine)
      .catch(() => DEFAULT_FACE_ENGINE as FaceEngine);

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

/**
 * Read one face with the given engine. The call sites never pick a model themselves.
 *
 * ## No cross-engine fallback, on purpose
 *
 * This used to fall back to the legacy reader when SFace threw. That was worse
 * than the failure it hid: the server compares against whatever `face_engine`
 * says, so a legacy vector arriving while the cafe is on SFace matches nothing,
 * and the person is told their face was not recognised when the real problem was
 * that the new engine did not load. A failed engine is now a failure, with the
 * error the caller can show.
 */
export async function readFaceFor(
  engine: FaceEngine,
  source: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement
): Promise<EngineRead> {
  if (engine === "sface") return readFaceSface(source);
  return readFace(source);
}

/**
 * Locate a face with the given engine, without computing a descriptor.
 *
 * This is the automatic scanner's cheap half: it answers "is there a face here,
 * and which way is the head turned" at a fraction of the cost of a capture. The
 * full read still goes through `readFaceFor`, so the scanner and the capture
 * cannot disagree about what a face is.
 */
export async function detectFaceFor(
  engine: FaceEngine,
  source: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement
): Promise<EngineDetect> {
  if (engine === "sface") return detectSfaceOnly(source);
  return detectFaceOnly(source);
}

