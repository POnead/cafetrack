"use client";

/**
 * Automatic, guided face capture.
 *
 * The manual capture button is replaced by a loop that watches the camera and
 * collects the angles on its own:
 *
 *   prompt (front) -> scanning screen -> prompt (left) -> scanning screen ->
 *   prompt (right) -> scanning screen -> complete
 *
 * ## Two reads, on purpose
 *
 * Every tick runs the *cheap* gate (`detectFaceFor`) — is there a face, and is the
 * head where the prompt asks? Only when the answer is yes for a few consecutive
 * frames does it pay for the full read (`sequence.read`), which computes the
 * descriptor. A loop that ran the descriptor every tick would spend nearly all of
 * its time producing vectors for frames it was about to throw away.
 *
 * ## What it will not do
 *
 * It does not decide whether the person is who they say they are — that is the
 * server's job. It only gets a clean set of frames in front of the camera and
 * hands them to `onComplete`. The submit itself stays with the screen, because
 * each screen posts to a different route.
 *
 * ## Failure, and the manual fallback
 *
 * A head that is not turned far enough yet is normal and is handled by the prompt
 * and a nudge. The manual controls are only revealed after thirty seconds at one
 * prompt, thirty seconds with no face at all, two minutes on the whole
 * presentation, or a read that will not work — see `promptTimeoutMs`,
 * `noFaceTimeoutMs` and `totalTimeoutMs`. Until then there is no button to press,
 * which is the point.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

import { FACE_POSES, poseRefusal, type FacePose } from "./face";
import { detectFaceFor, poseStateOfRead, useFaceEngine } from "./face-engine";
import type { PoseState } from "./head-pose";
import { useFacePoses, type PoseFrame } from "./use-face-poses";

type Sequence = ReturnType<typeof useFacePoses>;

export type AutoCapturePhase =
  /** The camera is not open, so there is nothing to scan. */
  | "idle"
  /** Live preview, watching for a face at the angle being asked for. */
  | "prompt"
  /** The loading screen: one frame is being read. */
  | "scanning"
  /** Every angle has been collected; the caller is submitting. */
  | "complete"
  /** Repeated failures. The manual controls should be shown. */
  | "failed";

export type AutoFaceCaptureOptions = {
  /** The pose sequence from `useFacePoses`. Shared with the file-upload path. */
  sequence: Sequence;
  /** The live <video> element. */
  videoRef: RefObject<HTMLVideoElement | null>;
  /** True while the camera is open and the loop should run. */
  active: boolean;
  /** Angles to collect, in order. Defaults to all three. */
  poses?: readonly FacePose[];
  /** Called once every angle is collected, with the full set. */
  onComplete: (frames: PoseFrame[], photos: (string | null)[]) => void;
  /** ms between detection attempts. */
  intervalMs?: number;
  /** Consecutive face-present reads required before a full read. */
  stableReads?: number;
  /**
   * ms spent on one angle before the manual fallback appears.
   *
   * This is a clock, not a count of attempts. A person reaching for the angle, a
   * slow detector and a blurry frame all look alike in a tick count, and cutting
   * someone off after three 350ms ticks is far too eager. Thirty seconds is long
   * enough for a deliberate turn and short enough that nobody is stuck staring at
   * a prompt.
   */
  promptTimeoutMs?: number;
  /**
   * ms with no face at all before the manual fallback appears.
   *
   * Defaults to the same thirty seconds as the prompt. The step-two staff screen
   * overrides it to a few seconds because a card is a legitimate subject there
   * and will never satisfy a face gate.
   */
  noFaceTimeoutMs?: number;
  /**
   * ms for the whole presentation before the scan gives up.
   *
   * Three prompts at thirty seconds each fit inside two minutes; the cap is what
   * stops a loop that keeps finding a face but never a usable one.
   */
  totalTimeoutMs?: number;
  /** Minimum time the scanning screen stays up, so it is not a flash. */
  scanMinMs?: number;
  /**
   * Grab the JPEG for a frame at the same instant as its embedding.
   *
   * Enrolment stores a photo per angle; the check screens send 128 floats and
   * keep nothing. Optional so those screens do not pay for a canvas encode they
   * would throw away — and, more importantly, so the photo and the embedding
   * always describe the same frame. Reading the video again a moment later would
   * pair one frame's vector with another frame's picture.
   */
  capturePhoto?: (video: HTMLVideoElement) => string;
  /**
   * Called for each angle as it is accepted, with the photo if one was grabbed.
   *
   * Enrolment needs this because a set is not atomic: someone can cancel after
   * two angles, or close the dialog, and the frames already collected are still
   * good. Waiting for `onComplete` to report anything would throw that work away.
   * The check screens do not pass it — they send the set once, or not at all.
   */
  onFrame?: (frame: PoseFrame, photo: string | null) => void;
};

export type AutoFaceCapture = {
  phase: AutoCapturePhase;
  /** The angle the screen should be asking for now. */
  activePose: FacePose;
  /** The angles this presentation collects, in order. */
  poses: readonly FacePose[];
  frames: PoseFrame[];
  /** How many angles are collected so far. */
  progress: number;
  /** How many angles the presentation needs. */
  total: number;
  /** A nudge or a failure reason, or null. */
  message: string | null;
  /**
   * What the last cheap gate saw, for the live guide. Null when no face is in
   * frame. The whole state, not just the pose: the guide needs the angles to draw
   * a needle, and the block reason to say "too far" rather than "turn more".
   */
  liveState: PoseState | null;
  /**
   * 0..1 — how far through the "hold still" window this frame is. Zero when the
   * head is not in the band. The loop requires a few consecutive matching reads
   * before it pays for a descriptor; this is that count as a fraction, so the
   * guide can show a ring filling instead of a silent wait.
   */
  holdProgress: number;
  /** The angle just accepted, for a brief "Got it" flash, or null. */
  flashPose: FacePose | null;
  /** True when the loop gave up and the manual controls should show. */
  showManual: boolean;
  /** Deliberate capture of the current angle (manual fallback). */
  captureNow: () => Promise<void>;
  /** Restart the loop after a give-up. */
  resume: () => void;
  /** Back to the first angle, discarding what was collected. */
  reset: () => void;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function useAutoFaceCapture({
  sequence,
  videoRef,
  active,
  poses = FACE_POSES,
  onComplete,
  intervalMs = 350,
  stableReads = 3,
  promptTimeoutMs = 30_000,
  noFaceTimeoutMs = 30_000,
  totalTimeoutMs = 120_000,
  scanMinMs = 500,
  capturePhoto,
  onFrame,
}: AutoFaceCaptureOptions): AutoFaceCapture {
  const engine = useFaceEngine();
  const [phase, setPhase] = useState<AutoCapturePhase>("idle");
  const [message, setMessage] = useState<string | null>(null);

  /*
   * What the cheap gate is seeing, for the live guide.
   *
   * State rather than a ref because the overlay has to redraw as the head turns.
   * The loop ticks every 350ms, so this is a few renders a second — cheap, and
   * the alternative (a silent prompt that only changes when it succeeds) is what
   * made the capture feel like it was ignoring the person.
   */
  const [liveState, setLiveState] = useState<PoseState | null>(null);
  const [holdProgress, setHoldProgress] = useState(0);
  const [flashPose, setFlashPose] = useState<FacePose | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /*
   * One JPEG per accepted angle, kept beside the embeddings.
   *
   * A ref, not state: nothing renders it, and the loop must read the current map
   * on the same tick that accepted the frame.
   */
  const photosRef = useRef(new Map<FacePose, string>());
  const capturePhotoRef = useRef(capturePhoto);
  capturePhotoRef.current = capturePhoto;
  const onFrameRef = useRef(onFrame);
  onFrameRef.current = onFrame;

  /*
   * The loop is started once and then reads the latest values through refs.
   * Putting the sequence or the callbacks in the loop's closure would either
   * restart it on every frame or leave it looking at a stale pose.
   */
  const sequenceRef = useRef(sequence);
  sequenceRef.current = sequence;
  const engineRef = useRef(engine);
  engineRef.current = engine;
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  const runningRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stableRef = useRef(0);
  const noFaceSinceRef = useRef<number | null>(null);
  /*
   * The two clocks the scan is judged by: when this presentation started, and
   * when the current prompt started. The prompt clock is reset by progress (a
   * new angle, or a frame that was accepted) rather than by a tick count, so a
   * person taking a few seconds to turn is not treated as a failure.
   */
  const startedAtRef = useRef(0);
  const angleSinceRef = useRef(0);
  const lastExpectedRef = useRef<FacePose | null>(null);
  /*
   * True while the message on screen describes the *current* frame — too dark, or
   * the head showing the wrong angle. Both go stale the moment a usable frame
   * arrives, and a guide that keeps saying "turn left" after the turn is exactly
   * the bug this loop exists to avoid. Messages that are not about the current
   * frame (a refused read, a give-up) are left alone.
   */
  const liveMessageRef = useRef(false);
  const completedRef = useRef(false);

  const stopLoop = useCallback(() => {
    runningRef.current = false;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  /*
   * A short "Got it" flash after an angle is accepted. Not a sound and not a
   * modal: the person needs to know the frame landed before the next prompt asks
   * for a different turn, or they keep holding the old pose.
   */
  const flash = useCallback((pose: FacePose) => {
    setFlashPose(pose);
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => setFlashPose(null), 900);
  }, []);

  // A flash timer that outlives the component would set state on an unmounted
  // screen; clear it on the way out.
  useEffect(
    () => () => {
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    },
    []
  );

  const resetCounters = useCallback(() => {
    stableRef.current = 0;
    noFaceSinceRef.current = null;
    lastExpectedRef.current = null;
    liveMessageRef.current = false;
  }, []);

  const finish = useCallback(
    (frames: PoseFrame[]) => {
      completedRef.current = true;
      stopLoop();
      setMessage(null);
      setPhase("complete");
      onCompleteRef.current(
        frames,
        frames.map((frame) => photosRef.current.get(frame.pose) ?? null)
      );
    },
    [stopLoop]
  );

  const giveUp = useCallback(
    (why: string) => {
      stopLoop();
      setPhase("failed");
      setMessage(why);
    },
    [stopLoop]
  );

  const startLoop = useCallback(() => {
    if (runningRef.current || completedRef.current) return;
    runningRef.current = true;

    /*
     * A fresh run gets a fresh two minutes, and the first prompt gets its own
     * thirty seconds. Resuming or a manual capture deliberately restarts both:
     * the person has just asked for another go.
     */
    startedAtRef.current = Date.now();
    angleSinceRef.current = Date.now();
    lastExpectedRef.current = null;
    noFaceSinceRef.current = null;
    stableRef.current = 0;

    const schedule = () => {
      if (!runningRef.current) return;
      timerRef.current = setTimeout(tick, intervalMs);
    };

    const tick = async () => {
      if (!runningRef.current) return;

      // The whole presentation has a hard ceiling. Checked before the camera so
      // a loop that is not getting frames still ends.
      if (Date.now() - startedAtRef.current >= totalTimeoutMs) {
        giveUp(
          "This check is taking longer than two minutes. Move into better light " +
            "and try again, or use the button below."
        );
        return;
      }

      const video = videoRef.current;
      // The camera can be open before it has produced a frame.
      if (!video || !video.videoWidth) {
        schedule();
        return;
      }

      // 1. Cheap gate: is there a face, and where is the head?
      let detected: Awaited<ReturnType<typeof detectFaceFor>>;
      try {
        detected = await detectFaceFor(engineRef.current, video);
      } catch {
        detected = {
          ok: false,
          reason: "no-face",
          message: "The face model could not run on this device.",
        };
      }
      if (!runningRef.current) return;

      if (!detected.ok) {
        stableRef.current = 0;
        setLiveState(null);
        setHoldProgress(0);
        // The light is actionable; say so. Other misses are covered by the prompt.
        if (detected.reason === "too-dark") {
          setMessage(detected.message);
          liveMessageRef.current = true;
        } else if (liveMessageRef.current) {
          // The light is no longer the problem, or there is no frame at all.
          liveMessageRef.current = false;
          setMessage(null);
        }
        if (noFaceSinceRef.current === null) {
          noFaceSinceRef.current = Date.now();
        } else if (Date.now() - noFaceSinceRef.current >= noFaceTimeoutMs) {
          giveUp(
            "We could not find your face. Move into better light and keep your whole head in the frame."
          );
          return;
        }
        schedule();
        return;
      }

      noFaceSinceRef.current = null;

      const expected = sequenceRef.current.activePose;
      const state = poseStateOfRead(detected);
      const seen = state.pose;
      setLiveState(state);

      /*
       * A new angle starts a new thirty seconds. The prompt clock is reset here
       * rather than on every tick, so a slow turn is not mistaken for a stall.
       */
      if (lastExpectedRef.current !== expected) {
        lastExpectedRef.current = expected;
        angleSinceRef.current = Date.now();
      }

      /*
       * The prompt itself has a ceiling. This is the clock the person actually
       * experiences: thirty seconds at "turn left" before the manual controls
       * appear, however many ticks that took.
       */
      if (Date.now() - angleSinceRef.current >= promptTimeoutMs) {
        giveUp(
          "We have not seen the angle we need yet. Turn a little further, or use " +
            "the button below."
        );
        return;
      }

      // 2. Pose gate: do not pay for the descriptor until the head matches.
      if (seen !== expected) {
        stableRef.current = 0;
        setHoldProgress(0);
        /*
         * No message from here any more.
         *
         * The guide already turns the same `PoseState` into one sentence — "too
         * far", "keep your head level", "turn a little further" — and it does so
         * from the block reason rather than from the pose alone. A second voice
         * setting its own message on every tick is how the old build ended up
         * telling a head at 70° to turn further.
         */
        if (liveMessageRef.current) {
          liveMessageRef.current = false;
          setMessage(null);
        }
        schedule();
        return;
      }

      // Back in the band: any nudge about the previous pose is now stale.
      if (liveMessageRef.current) {
        liveMessageRef.current = false;
        setMessage(null);
      }

      // 3. Stability: a few clean reads, so a blurry frame is not kept.
      stableRef.current += 1;
      setHoldProgress(Math.min(1, stableRef.current / stableReads));
      if (stableRef.current < stableReads) {
        schedule();
        return;
      }
      stableRef.current = 0;

      // 4. The full read, behind the scanning screen.
      const requested = expected;
      setPhase("scanning");
      setMessage(null);
      const readStartedAt = Date.now();
      try {
        const result = await sequenceRef.current.read(video);

        /*
         * The photo has to be taken now, not when the set is handed over.
         *
         * `read` has just computed the embedding from this frame; the video keeps
         * playing, so a canvas encode 500ms later (after the scanning screen) would
         * pair this vector with a different picture. Taken here, before the
         * minimum-scan sleep, they describe the same frame.
         */
        const accepted =
          result.outcome === "retry" ? null : result.frames[result.frames.length - 1];
        const grabPhoto = capturePhotoRef.current;
        if (accepted && grabPhoto) {
          try {
            photosRef.current.set(accepted.pose, grabPhoto(video));
          } catch {
            // Without a photo the angle cannot be stored, so it is not accepted.
            setMessage("That photo could not be saved. Try again.");
            setHoldProgress(0);
            setPhase("prompt");
            schedule();
            return;
          }
        }

        if (accepted) {
          onFrameRef.current?.(accepted, photosRef.current.get(accepted.pose) ?? null);
        }

        const elapsed = Date.now() - readStartedAt;
        if (elapsed < scanMinMs) await sleep(scanMinMs - elapsed);
        if (!runningRef.current) return;

        if (result.outcome === "retry") {
          /*
           * A refusal is not a give-up. The prompt clock is still running, and it
           * is the clock that decides when the manual controls appear — three
           * quick refusals should not cut someone off after a second.
           */
          setMessage(result.message);
          setHoldProgress(0);
          setPhase("prompt");
          schedule();
          return;
        }

        setMessage(null);

        if (result.outcome === "complete") {
          finish(result.frames);
          return;
        }

        /*
         * Accepted. Progress restarts the prompt clock, because the next tick may
         * still be asking for the same angle (a frame can be filed under the
         * angle it actually shows) and the person has just earned more time.
         */
        angleSinceRef.current = Date.now();
        lastExpectedRef.current = null;
        setHoldProgress(0);
        flash(requested);
        setPhase("prompt");
        schedule();
      } catch {
        // Same as a refusal: keep the prompt clock running and try again.
        setPhase("prompt");
        schedule();
      }
    };

    void tick();
  }, [
    videoRef,
    intervalMs,
    stableReads,
    promptTimeoutMs,
    noFaceTimeoutMs,
    totalTimeoutMs,
    scanMinMs,
    finish,
    giveUp,
    flash,
  ]);

  const { reset: resetSequence } = sequence;

  /*
   * Start and stop with the camera. A rising edge is a fresh presentation, so
   * the frames and counters from a previous attempt cannot leak into this one.
   */
  useEffect(() => {
    if (!active) {
      stopLoop();
      completedRef.current = false;
      resetCounters();
      photosRef.current.clear();
      setPhase("idle");
      setMessage(null);
      setLiveState(null);
      setHoldProgress(0);
      setFlashPose(null);
      return;
    }

    completedRef.current = false;
    resetCounters();
    resetSequence();
    photosRef.current.clear();
    setMessage(null);
    setLiveState(null);
    setHoldProgress(0);
    setFlashPose(null);
    setPhase("prompt");
    startLoop();

    return stopLoop;
  }, [active, startLoop, stopLoop, resetCounters, resetSequence]);

  const captureNow = useCallback(async () => {
    if (completedRef.current) return;
    const video = videoRef.current;
    if (!video || !video.videoWidth) {
      setMessage("The camera is not showing anything yet.");
      return;
    }

    stopLoop();
    setPhase("scanning");
    setMessage(null);
    try {
      const result = await sequenceRef.current.read(video);

      // Same instant as the read, for the same reason as the automatic path.
      const accepted =
        result.outcome === "retry" ? null : result.frames[result.frames.length - 1];
      const grabPhoto = capturePhotoRef.current;
      if (accepted && grabPhoto) {
        try {
          photosRef.current.set(accepted.pose, grabPhoto(video));
        } catch {
          setMessage("That photo could not be saved. Try again.");
          setPhase("failed");
          return;
        }
      }

      if (accepted) {
        onFrameRef.current?.(accepted, photosRef.current.get(accepted.pose) ?? null);
      }

      if (result.outcome === "retry") {
        setMessage(result.message);
        setPhase("failed");
        return;
      }
      setMessage(null);
      if (result.outcome === "complete") {
        finish(result.frames);
        return;
      }
      // Accepted; go back to automatic for the angles that remain.
      setPhase("prompt");
      startLoop();
    } catch {
      setMessage("That could not be read. Try again in better light.");
      setPhase("failed");
    }
  }, [videoRef, stopLoop, finish, startLoop]);

  const resume = useCallback(() => {
    if (completedRef.current) return;
    resetCounters();
    setMessage(null);
    setPhase("prompt");
    startLoop();
  }, [resetCounters, startLoop]);

  const reset = useCallback(() => {
    stopLoop();
    completedRef.current = false;
    resetCounters();
    resetSequence();
    photosRef.current.clear();
    setMessage(null);
    setLiveState(null);
    setHoldProgress(0);
    setFlashPose(null);
    if (active) {
      setPhase("prompt");
      startLoop();
    } else {
      setPhase("idle");
    }
  }, [stopLoop, resetCounters, resetSequence, active, startLoop]);

  return {
    phase,
    activePose: sequence.activePose,
    poses,
    frames: sequence.frames,
    progress: sequence.frames.length,
    total: poses.length,
    message,
    liveState,
    holdProgress,
    flashPose,
    showManual: phase === "failed",
    captureNow,
    resume,
    reset,
  };
}
