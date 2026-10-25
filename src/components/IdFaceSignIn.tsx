"use client";

/**
 * Sign in by showing an ID card and your face.
 *
 * The sibling of `FaceSignIn`, and deliberately not a reuse of it. Both capture a
 * face with the same camera code and the same diagnostics, but this one has an ID
 * image in front of it — so it asks for two things in sequence rather than one,
 * sends both in a single request, and has to explain what happens to a government
 * document on the way past. None of that belongs in the badge flow, and bolting it
 * on would mean both screens carry two sets of wording for two genuinely
 * different situations.
 *
 * ## What the card is for
 *
 * It **identifies** — it narrows to exactly one account. The face **authenticates**
 * — it proves the person holding it is the person enrolled. The server does both,
 * one after the other, and the card never authenticates anything on its own.
 * See the header of `app/api/auth/id-login/route.ts`.
 *
 * ## Why one request and not a wizard
 *
 * The browser sends the card image, the card's fingerprint and the face floats
 * together. There is nothing to ask between them: the face is not compared
 * against a card the person chose, it is compared against whichever account the
 * card turns out to be on file for. Splitting it into "upload, then look up, then
 * capture" would put a round trip between the card and the face for no gain, and
 * would need somewhere to hold a half-finished attempt between them.
 *
 * ## The photo does leave the device
 *
 * Unlike `FaceSignIn`, which transmits 128 floats and nothing else, this uploads
 * a photograph of a government ID. It is read on the server and discarded — never
 * stored, never returned, never written to the audit log — but it does cross the
 * wire, and the copy is worth saying plainly rather than burying.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  cameraAvailable,
  cameraPermissionState,
  openCamera,
  permissionHelp,
  readFace,
} from "@/lib/face-client";
import { openIdCamera } from "@/lib/id-camera";
import {
  classifyCameraError,
  describeCameraProblem,
  type CameraProblem,
} from "@/lib/face-diagnostics";
import { fingerprintFile } from "@/lib/card-fingerprint";

type Stage = "card" | "face" | "sending" | "done";

type Props = {
  /** Called once the server has minted a session. */
  onSignedIn: (data: { user: unknown; session_conflict: boolean; warnings?: string[] }) => void;
  onCancel: () => void;
};

/** Long edge for the card, matching what IdUpload sends. */
const CARD_MAX_EDGE = 1600;

export default function IdFaceSignIn({ onSignedIn, onCancel }: Props) {
  const [stage, setStage] = useState<Stage>("card");
  const [message, setMessage] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<CameraProblem | null>(null);
  const [progress, setProgress] = useState({ loaded: 0, total: 0 });
  const [modelsPresent, setModelsPresent] = useState<boolean | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const cardFileRef = useRef<File | null>(null);
  const cardHashRef = useRef<string | null>(null);
  const previewUrlRef = useRef<string | null>(null);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => stopCamera, [stopCamera]);

  // The card preview is a blob URL, and blob URLs are not garbage collected.
  useEffect(
    () => () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    },
    []
  );

  const attachStream = useCallback((node: HTMLVideoElement | null) => {
    videoRef.current = node;
    if (!node) return;
    const stream = streamRef.current;
    if (!stream) return;
    node.srcObject = stream;
    void node.play().catch(() => {});
  }, []);

  /* Are the recognition weights installed? Asked before anyone points a camera at
     themselves — the face model is a 6.7MB download, and finding that out after
     they have committed to the flow is worse than being told now. */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const lib = await import("@/lib/face-client");
      const present = await lib.modelsPresent();
      if (!cancelled) setModelsPresent(present);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /* ---- stage one: the card --------------------------------------------- */

  /**
   * Open the camera pointing at the card.
   *
   * `openIdCamera` rather than `openCamera`, and the difference matters on a
   * phone: this one asks for the rear camera so the card is the only thing in
   * frame, rather than the person holding it. `openCamera` is hard-coded to
   * `facingMode: "user"` and takes no options, which is right for the face and
   * wrong here.
   */
  const startCardCamera = useCallback(async () => {
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
        "The face model could not be downloaded. Check the connection, or use your badge and password."
      );
      return;
    }

    try {
      const stream = await openIdCamera();
      streamRef.current = stream;
      setStage("card");
      attachStream(videoRef.current);
    } catch (e) {
      stopCamera();
      const problem = classifyCameraError(e);
      setBlocked(problem);
      setMessage(describeCameraProblem(problem).message);
    }
  }, [attachStream, stopCamera]);

  /* ---- stage two: the face --------------------------------------------- */

  /** Open the camera pointing at the person, for the second half. */
  const startFaceCamera = useCallback(async () => {
    try {
      const stream = await openCamera();
      streamRef.current = stream;
      attachStream(videoRef.current);
    } catch (e) {
      const problem = classifyCameraError(e);
      setBlocked(problem);
      setMessage(describeCameraProblem(problem).message);
    }
  }, [attachStream]);

  const acceptCard = useCallback(
    async (raw: File) => {
      setBusy(true);
      setMessage("Reading your ID…");
      try {
        const file = await normaliseCard(raw);
        cardFileRef.current = file;
        /*
         * The fingerprint is computed here, in the browser, and sent alongside the
         * image. Same trust model as the face descriptors this app already accepts —
         * and it is the *identifier*, not the proof, so a forged one at worst
         * narrows the search wrongly and is caught by the face that follows.
         */
        cardHashRef.current = await fingerprintFile(file);

        if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
        const url = URL.createObjectURL(file);
        previewUrlRef.current = url;
        setPreview(url);

        stopCamera();
        setMessage(null);
        setStage("face");
        await startFaceCamera();
      } finally {
        setBusy(false);
      }
    },
    [startFaceCamera, stopCamera]
  );

  const submit = useCallback(
    async (photoFile: File | Blob | null) => {
      setBusy(true);
      setStage("sending");
      setMessage("Checking…");

      try {
        const face = await readFace(photoFile);
        if (!face.ok) {
          setStage("face");
          setMessage(face.message || "No face could be read. Try again, in better light.");
          return;
        }

        const fd = new FormData();
        if (cardFileRef.current) fd.append("id_front", cardFileRef.current);
        if (cardHashRef.current) fd.append("card_hash", cardHashRef.current);
        fd.append("face_embedding", face.embedding.join(","));

        const res = await fetch("/api/auth/id-login", { method: "POST", body: fd });
        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
          setStage("face");
          setMessage(data.error ?? "That did not match. Try again, or use your password.");
          return;
        }

        setStage("done");
        onSignedIn(data);
      } catch {
        setStage("face");
        setMessage("Something went wrong. Try again, or use your password.");
      } finally {
        setBusy(false);
      }
    },
    [onSignedIn]
  );

  const shoot = useCallback(() => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")?.drawImage(video, 0, 0);

    canvas.toBlob((blob) => {
      if (blob) void submit(blob);
    }, "image/jpeg", 0.9);
  }, [submit]);

  /* ---- rendering -------------------------------------------------------- */

  if (stage === "done") {
    return (
      <div className="flex h-48 items-center justify-center px-6 text-center">
        <p className="text-sm text-cream-200/70">Signed in.</p>
      </div>
    );
  }

  const showingCard = stage === "card";
  const showingFace = stage === "face" || stage === "sending";

  return (
    <div className="space-y-3.5">
      {/* Steps. Two things have to happen and the order matters — the card has to
          be seen before the face, because the face is compared against whichever
          account the card turns out to be. */}
      <ol className="flex items-center justify-center gap-2 text-[11px]">
        <li className={showingCard ? "font-semibold text-ochre-600" : "text-cocoa-400"}>
          1. Your ID
        </li>
        <li className="text-cocoa-300">→</li>
        <li className={showingFace ? "font-semibold text-ochre-600" : "text-cocoa-400"}>
          2. Your face
        </li>
      </ol>

      <div className="relative overflow-hidden rounded-2xl bg-cocoa-900">
        {(showingCard || showingFace) && (
          <video
            ref={attachStream}
            playsInline
            muted
            autoPlay
            className="mx-auto block w-full max-w-xs"
          />
        )}

        {preview && showingFace && (
          <img
            src={preview}
            alt=""
            className="pointer-events-none absolute left-2 top-2 w-20 rounded-lg border border-cream-200/30"
          />
        )}

        {(busy || (stage === "card" && !streamRef.current)) && (
          <div className="flex h-48 items-center justify-center">
            <div className="h-8 w-8 animate-spin rounded-full border-[3px] border-cream-200 border-t-ochre-400" />
          </div>
        )}

        {modelsPresent === false && (
          <p className="px-6 py-4 text-center text-sm text-cream-200/60">
            The face model files are not installed on this server.
          </p>
        )}
      </div>

      {blocked && (
        <div className="rounded-xl bg-amber-50 px-3.5 py-3 text-sm text-cocoa-700">
          <p className="font-semibold">{describeCameraProblem(blocked).message}</p>
          <p className="mt-1">
            {blocked === "permission-denied" && permissionHelp("denied")
              ? permissionHelp("denied")
              : describeCameraProblem(blocked).help}
          </p>
          {describeCameraProblem(blocked).retryable && (
            <button
              type="button"
              className="btn-ghost mt-2.5 !py-1.5 text-xs"
              onClick={() => {
                setBlocked(null);
                setMessage(null);
                void startCardCamera();
              }}
            >
              Check again
            </button>
          )}
        </div>
      )}

      {message && <p className="text-center text-sm text-cocoa-600">{message}</p>}

      <p className="text-center text-xs text-cocoa-500">
        {showingCard
          ? "Fill the frame with the card, flat on. The photo and the printed details both need to be readable."
          : "Now fill the frame with your face — whole head, top of hair to chin."}
      </p>

      <button
        type="button"
        className="btn-primary w-full"
        disabled={busy || blocked !== null || !streamRef.current}
        onClick={() => (showingCard ? shoot() : undefined)}
      >
        {showingCard ? "Take a picture of my ID" : "Take a picture of my face"}
      </button>

      <label className="btn-ghost block w-full cursor-pointer text-center !py-2 text-sm">
        Take a photo instead
        <input
          type="file"
          accept="image/*"
          capture="environment"
          className="sr-only"
          disabled={busy}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void acceptCard(file);
          }}
        />
      </label>

      {/* Shown from stage two onwards, because the camera has to be reopened
          facing the person and that is the point at which a failure would strand
          them here. */}
      {showingFace && (
        <label className="btn-ghost block w-full cursor-pointer text-center !py-2 text-sm">
          Take my photo with the gallery instead
          <input
            type="file"
            accept="image/*"
            capture="user"
            className="sr-only"
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void submit(file);
            }}
          />
        </label>
      )}

      <button
        type="button"
        className="w-full text-center text-xs text-cocoa-400 underline"
        onClick={() => {
          stopCamera();
          onCancel();
        }}
      >
        Use my badge and password instead
      </button>
    </div>
  );
}

/* ------------------------------------------------------------- helpers -- */

/** Downscale a captured card the way the upload path does, before fingerprinting. */
async function normaliseCard(raw: File): Promise<File> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(raw);
  } catch {
    // Not decodable here. Passed through so the server produces the refusal, which
    // says more about what is wrong than anything this could guess.
    return raw;
  }

  try {
    const scale = Math.min(1, CARD_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, width, height);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.85)
    );
    if (!blob) return raw;

    return new File([blob], "id.jpg", { type: "image/jpeg" });
  } finally {
    bitmap.close();
  }
}

export { normaliseCard };
