"use client";

/**
 * Step two of staff sign-in: one button, and whichever of a face or an ID card
 * the person puts in front of it.
 *
 * ## Why this exists instead of reusing FaceSignIn and IdFaceSignIn
 *
 * Those two are the *other* sign-in routes — a badge or username plus a face,
 * and a card plus a face. Both of them have to work out who is signing in before
 * they can check anything, because both are reachable without a password. This
 * one is the opposite: the password step already named the account, so there is
 * nothing to identify. That difference is the whole reason this is a new
 * component rather than a flag on an old one, and the difference is why it can be
 * a single button.
 *
 * ## How one button decides
 *
 * A frame is grabbed, and both readings are attempted on it:
 *
 *   - `readFace` returns either an embedding or a reason. The reason matters —
 *     `no-face` is the expected answer when the frame holds a card, because an ID
 *     card's portrait is small and off-centre and the detector is right to ignore
 *     it.
 *   - `fingerprintFromCanvas` is a perceptual hash of the whole frame, so it is
 *     computed whether or not a face was found.
 *
 * Both readings go to the server and it tries the face first, then the card. So a
 * card that trips the face detector still signs in, because the hash comparison
 * is independent of what the detector believed. Nothing is lost by a
 * misdetection in either direction.
 *
 * ## The framing copy is deliberately neutral
 *
 * "Look at the camera" and "hold the card flat" are contradictory instructions,
 * and this button has to honour both at once. So it says neither: fill the frame
 * with your face or your ID card. The overlay cannot change per-mode when the
 * mode is not known until the frame is read, and guessing wrong would be worse
 * than saying less.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  cameraAvailable,
  cameraPermissionState,
  dataUrlToJpeg,
  loadFaceModels,
  openCamera,
  permissionHelp,
  readFace,
} from "@/lib/face-client";
import {
  classifyCameraError,
  describeCameraProblem,
  type CameraProblem,
} from "@/lib/face-diagnostics";
import { fingerprintFromCanvas } from "@/lib/card-fingerprint";

type Props = {
  /** The ticket from step one. Single use, five minutes, and not a session. */
  ticket: string;
  /** The account's display name, so the greeting is a name rather than a title. */
  fullName?: string;
  /** Called with what the server matched, after the session cookie exists. */
  onVerified: (matchedBy: "face" | "id_card") => void;
  /** Back to the password step, e.g. the ticket expired. */
  onBack: () => void;
};

export default function StaffCheck({ ticket, fullName, onVerified, onBack }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [message, setMessage] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ loaded: number; total: number } | null>(null);
  const [blocked, setBlocked] = useState<CameraProblem | null>(null);
  const [live, setLive] = useState(false);
  const [busy, setBusy] = useState(false);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setLive(false);
  }, []);

  /**
   * A callback ref, not the plain object one — and this is the whole reason the
   * camera showed a black rectangle the first time round.
   *
   * The <video> only exists once `live` is true, and React mounts it on a later
   * render than the one that set it. So attaching the stream by hand inside
   * start(), right after setLive(true), reads videoRef.current as null: the
   * element has not been created yet. The stream is opened and the hardware light
   * comes on, and then it is simply never given to an element. getUserMedia
   * succeeded, so nothing threw, and the failure is invisible from the page.
   *
   * A callback ref runs on the element's own mount, which is the only moment at
   * which the node exists. FaceCapture, FaceSignIn, IdFaceSignIn and the verify
   * screen all do it this way for the same reason.
   */
  const attachStream = useCallback((node: HTMLVideoElement | null) => {
    videoRef.current = node;
    if (!node) return;
    const stream = streamRef.current;
    if (!stream) return;
    node.srcObject = stream;
    void node.play().catch(() => {});
  }, []);

  useEffect(() => stopCamera, [stopCamera]);

  const start = useCallback(async () => {
    setMessage(null);
    setBlocked(null);

    if (!cameraAvailable()) {
      setBlocked("insecure-origin");
      return;
    }
    if ((await cameraPermissionState()) === "denied") {
      setBlocked("permission-denied");
      return;
    }

    setMessage("Getting the reader ready…");
    try {
      const lib = await import("@/lib/face-client");
      await lib.loadFaceModels((loaded, total) => setProgress({ loaded, total }));
    } catch {
      setMessage(
        "The face model could not be downloaded. Check the connection, then try again."
      );
      return;
    }

    try {
      // openCamera, not openIdCamera. The rear camera is the right one for a
      // card held flat on a table and the wrong one for a face, and there is no
      // way to know which this is until the frame is read.
      const stream = await openCamera();
      streamRef.current = stream;

      // Only the stream is stored here. setLive mounts the <video>, and
      // attachStream hands it the stream on that mount — see its comment.
      setProgress(null);
      setLive(true);
      setMessage("Fill the frame with your face or your ID card.");
    } catch (e) {
      stopCamera();
      const problem = classifyCameraError(e);
      setBlocked(problem);
      setMessage(describeCameraProblem(problem).message);
    }
  }, [stopCamera]);

  /*
   * Preload the face models in the background from the moment this panel
   * appears, rather than waiting for the person to press the button.
   *
   * The models are ~6MB and take several seconds to fetch on first use. When
   * that happened inside `start()`, the person had already committed — camera
   * permission granted, privacy light on — and then sat through a progress bar
   * doing nothing. Loading it here means the download runs while they are still
   * reading the instructions, and by the time they press the button it is done.
   *
   * A failure here is silent on purpose: `start()` calls `loadFaceModels()`
   * again, which either finishes the job or throws, and only that second call
   * reports anything. A preload that surfaced its own error would show two
   * messages for one problem.
   */
  useEffect(() => {
    void import("@/lib/face-client")
      .then((lib) => lib.loadFaceModels())
      .catch(() => {});
  }, []);

  const capture = useCallback(async () => {
    if (busy) return;
    const video = videoRef.current;
    if (!video || !video.videoWidth) {
      setMessage("The camera is not showing anything yet.");
      return;
    }

    setBusy(true);
    setMessage("Checking…");

    try {
      // One canvas, two readings. Sized to the video's own dimensions so the
      // fingerprint is taken at a resolution comparable to enrolment.
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        setMessage("This browser could not read the camera image.");
        return;
      }
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      // Both, unconditionally. The card hash does not care what the detector
      // thought, which is what makes a single button safe.
      const cardHash = fingerprintFromCanvas(canvas);

      let faceEmbedding: number[] | null = null;
      try {
        const face = await readFace(canvas);
        // A low-confidence read is not thrown away here. The server is the only
        // thing entitled to decide whether a face counts, and it compares against
        // a known account rather than trusting this number.
        if (face.ok) faceEmbedding = face.embedding;
      } catch {
        // A face model that will not run leaves the card reading intact.
      }

      if (!faceEmbedding && !cardHash) {
        setMessage(
          "Nothing recognisable in that. Fill the frame with your face, or with the front of your ID card."
        );
        return;
      }

      let idFaceEmbedding: number[] | null = null;
      try {
        const imgRes = await fetch(`/api/auth/staff/id-image?ticket=${encodeURIComponent(ticket)}`);
        if (imgRes.ok) {
          const imgData = await imgRes.json();
          const dataUrl: string = imgData.image ?? "";
          if (dataUrl) {
            const jpeg = await dataUrlToJpeg(dataUrl);
            const img = new Image();
            img.src = jpeg;
            await img.decode().catch(() => {});
            if (img.naturalWidth > 0) {
              const lib = await import("@/lib/face-client");
              const idFace = await lib.readFace(img);
              if (idFace.ok) idFaceEmbedding = idFace.embedding;
            }
          }
        }
      } catch {
        // The ID card image may be missing or unreadable; skip silently.
      }

      const res = await fetch("/api/auth/staff/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticket,
          face_embedding: faceEmbedding,
          card_hash: cardHash,
          id_face_embedding: idFaceEmbedding,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setMessage(data.error || "That did not match.");
        if (data.expired || res.status === 401) {
          // A spent or expired ticket cannot be recovered from here, and the
          // honest thing is to say so rather than loop the person on a button
          // that will never work.
          setMessage(
            data.error && data.expired
              ? data.error
              : "That did not match. Check your password to start again."
          );
        }
        return;
      }

      stopCamera();
      onVerified(data.matched_by === "id_card" ? "id_card" : "face");
    } catch {
      setMessage("Something went wrong reading the camera. Try again.");
    } finally {
      setBusy(false);
    }
  }, [busy, onVerified, stopCamera, ticket]);

  const problem = blocked ? describeCameraProblem(blocked) : null;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-cocoa-800">
          {fullName ? `Hello ${fullName.split(" ")[0]}` : "One more thing"}
        </h2>
        <p className="mt-1 text-xs leading-relaxed text-cocoa-500">
          Your password is right. Confirm you are you with your face or your ID
          card, and you are in.
        </p>
      </div>

      {!live ? (
        <div className="space-y-3">
          <button
            type="button"
            onClick={start}
            disabled={Boolean(progress)}
            className="w-full rounded-xl bg-cream-400 py-3 text-sm font-semibold text-cocoa-900 transition hover:bg-cream-300 disabled:opacity-60"
          >
            {progress
              ? `Loading the reader… ${progress.loaded}/${progress.total}`
              : "Open the camera"}
          </button>

          {problem && (
            <div className="space-y-2 rounded-xl bg-cream-50 px-3.5 py-3 text-xs leading-relaxed text-cocoa-600">
              <p>{problem.message}</p>
              {permissionHelp(blocked!) && <p>{permissionHelp(blocked!)}</p>}
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="relative overflow-hidden rounded-2xl bg-cocoa-800">
            <video
              /* The callback ref, not the plain object one — see attachStream. */
              ref={attachStream}
              playsInline
              muted
              className="aspect-[3/4] w-full object-cover"
            />
            {/* Neutral on purpose: one button, two subjects, no way to know which
                is in frame until it has been read. */}
            <div className="pointer-events-none absolute inset-6 rounded-2xl border-2 border-dashed border-cream-200/70" />
          </div>

          <button
            type="button"
            onClick={capture}
            disabled={busy}
            className="w-full rounded-xl bg-cream-400 py-3 text-sm font-semibold text-cocoa-900 transition hover:bg-cream-300 disabled:opacity-60"
          >
            {busy ? "Checking…" : "That is me"}
          </button>

          <button
            type="button"
            onClick={onBack}
            disabled={busy}
            className="w-full text-center text-xs text-cocoa-400 underline disabled:opacity-50"
          >
            Use my password instead
          </button>
        </div>
      )}

      {message && !problem && (
        <p role="status" className="text-center text-xs leading-relaxed text-cocoa-500">
          {message}
        </p>
      )}
    </div>
  );
}