"use client";

/**
 * The three-angle capture sequence, for a screen that is *checking* a face.
 *
 * Enrolment has its own component (FaceCapture) because it also stores photos
 * and talks about what is being saved. Every other screen — the duty check, face
 * sign-in, the step-two panel — is doing the same thing as each other: ask for
 * the angles in order, refuse a frame whose head is not where the prompt says,
 * and hand back the set once it is complete. That sequence lives here so the
 * three cannot drift into asking for different angles in a different order.
 *
 * The camera itself stays with the caller. Those screens already own a stream, a
 * preview element and their own wording for a camera that will not open, and
 * moving that into a hook would be a rewrite of four working screens to share
 * something none of them gets wrong. This shares the part they *could* get wrong.
 *
 * ## What it will not do
 *
 * It does not keep the photos. A check sends 128 floats per angle and the frame
 * is never stored — the four floats-per-angle comparison is the whole point of
 * running the model in the browser.
 */
import { useCallback, useMemo, useState } from "react";

import {
  FACE_POSES,
  type FacePose,
  fileFrame,
  poseAlreadyHeld,
  poseRefusal,
} from "./face";
import { poseStateOfRead, readFaceFor, useFaceEngine } from "./face-engine";

/** One frame of a presentation. What goes on the wire as `face_frames`. */
export type PoseFrame = {
  pose: FacePose;
  embedding: number[];
  poseSignal: number | null;
  quality: number;
};

export type ReadOutcome = "accepted" | "retry" | "complete";

/** What one `read` produced. The frames are returned, not only stored, so a
 *  caller can submit the completed set from the same click that finished it. */
export type ReadResult = {
  outcome: ReadOutcome;
  frames: PoseFrame[];
  message: string | null;
};

export type FacePoseSequence = {
  /** The angle the screen should be asking for now. */
  activePose: FacePose;
  /** Frames accepted so far, in capture order. */
  frames: PoseFrame[];
  /** Why the last frame was refused, or null. */
  message: string | null;
  /** Every angle has a frame. */
  complete: boolean;
  /** How many angles are still to go. */
  remaining: number;
  /** Back to the start — the whole presentation is rejected on the server. */
  reset: () => void;
};

/**
 * Run the sequence, reading each frame as it arrives.
 *
 * `read` is returned separately from the state so a caller can await one frame
 * and immediately decide to submit: a click handler that had to wait for a
 * re-render to learn whether the set was complete would submit on the next
 * press instead of this one.
 */
export function useFacePoses(poses: readonly FacePose[] = FACE_POSES): FacePoseSequence & {
  read: (source: HTMLVideoElement | HTMLImageElement) => Promise<ReadResult>;
} {
  /*
   * The café's engine, read once per page. Every screen that checks a face goes
   * through this hook, so they all run the model the server will compare against.
   * Using the wrong one is silent: the vectors simply never match.
   */
  const engine = useFaceEngine();
  const [frames, setFrames] = useState<PoseFrame[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  const activePose = useMemo(() => {
    const missing = poses.find((pose) => !frames.some((f) => f.pose === pose));
    // Falls back to the last angle rather than throwing when the set is complete,
    // so a render that races the final frame still has something to show.
    return missing ?? poses[poses.length - 1];
  }, [frames, poses]);

  const reset = useCallback(() => {
    setFrames([]);
    setMessage(null);
  }, []);

  const read = useCallback(
    async (source: HTMLVideoElement | HTMLImageElement): Promise<ReadResult> => {
      const expected = poses.find((pose) => !frames.some((f) => f.pose === pose)) ?? activePose;

      const result = await readFaceFor(engine, source);
      if (!result.ok) {
        setMessage(result.message);
        return { outcome: "retry", frames, message: result.message };
      }

      const state = poseStateOfRead(result);
      const seen = state.pose;
      const held = frames.map((f) => f.pose);
      const filing = fileFrame({ expected, seen, held });

      if (filing.kind === "turn-more") {
        // Halfway between straight on and turned, too far round, or tilted. The
        // refusal names which one — see `poseRefusal` — because they need
        // opposite corrections. Refused here rather than on the server so the
        // person is told while they are still in front of the camera.
        const refusal = poseRefusal(expected, state);
        setMessage(refusal);
        return { outcome: "retry", frames, message: refusal };
      }

      if (filing.kind === "already-have") {
        const missing = poses.find((pose) => !held.includes(pose)) ?? null;
        const note = poseAlreadyHeld(filing.pose, missing);
        setMessage(note);
        return { outcome: "retry", frames, message: note };
      }

      /*
       * A sequence only ever collects the angles it was created for.
       *
       * `fileFrame` deliberately takes a frame that shows an angle the set still
       * needs — during a three-angle presentation, showing the next angle early is
       * a kindness, not a mistake. But a retake runs a sequence of one pose, and
       * without this guard a left frame offered while the screen asks for the
       * frontal retake would be filed as the left one, count as "complete", and
       * leave the frontal photo missing.
       */
      if (!poses.includes(filing.pose)) {
        const refusal = poseRefusal(expected, state);
        setMessage(refusal);
        return { outcome: "retry", frames, message: refusal };
      }

      // Filed under the angle the frame actually shows — which is usually the
      // one asked for, and sometimes the one next to it. See fileFrame.
      const next = [
        ...frames.filter((f) => f.pose !== filing.pose),
        {
          pose: filing.pose,
          embedding: result.embedding,
          poseSignal: result.poseSignal,
          quality: result.score,
        },
      ];

      setFrames(next);
      setMessage(null);

      return {
        outcome: next.length === poses.length ? "complete" : "accepted",
        frames: next,
        message: null,
      };
    },
    [frames, poses, activePose, engine]
  );

  return {
    activePose,
    frames,
    message,
    complete: poses.every((pose) => frames.some((f) => f.pose === pose)),
    remaining: poses.filter((pose) => !frames.some((f) => f.pose === pose)).length,
    reset,
    read,
  };
}

/**
 * The body a check posts: one entry per angle, plus nothing else.
 *
 * Kept as a function so every caller builds the same shape — a route that
 * receives `{pose, embedding}` per frame is the contract `parseFaceFrames`
 * enforces, and a caller inventing a different shape would fail only at the
 * till, which is the worst place to find out.
 */
export function framesBody(frames: readonly PoseFrame[]): { face_frames: PoseFrame[] } {
  return {
    face_frames: frames.map((f) => ({
      pose: f.pose,
      embedding: f.embedding,
      poseSignal: f.poseSignal,
      quality: f.quality,
    })),
  };
}


