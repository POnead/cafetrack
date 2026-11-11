"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cameraAvailable, permissionHelp } from "@/lib/face-client";
import {
  cameraOriginProblem,
  classifyCameraError,
  describeCameraProblem,
  type CameraProblem,
} from "@/lib/face-diagnostics";
import {
  captureIdFrame,
  listIdCameras,
  openIdCamera,
  openIdEnrollmentCamera,
  type IdCameraChoice,
  type IdCameraFacing,
} from "@/lib/id-camera";
import { fingerprintFromCanvas } from "@/lib/card-fingerprint";
import { useAutoIdCapture } from "@/lib/use-auto-id-capture";

/**
 * Attach a government ID. The server sends the ID front and saved staff face to
 * Face++ for comparison; no additional face photo or local face model is needed.
 *
 * Loaded with `ssr: false` and `next/dynamic` by its callers, for the same
 * reason this is loaded on demand: it uses the browser camera and image canvas
 * APIs, and the staff list is a page an admin opens constantly.
 *
 * ## What this does before the upload, and why
 *
 * **Downscaling.** A modern phone photographs an ID card at 3-6MB. Base64 adds a
 * third to that, and it would then live in a Postgres text column. Every image is
 * redrawn onto a canvas at a 1600px long edge at JPEG q0.82, which takes that to
 * roughly 300-600KB with no visible loss on a card being read on a laptop.
 *
 * The server enforces its own limit regardless (see lib/id-document.ts) — this is
 * a courtesy that makes the upload fast, not a control.
 *
 * The server runs face comparison with Face++ using the ID front and the
 * already-enrolled staff face. This component only uploads the ID images and
 * computes the card fingerprint used to catch reused cards.
 */

/** Long edge, in pixels, that every image is reduced to before upload. */
const MAX_EDGE = 1600;
const FRONT_OCR_MAX_EDGE = 2400;

/**
 * JPEG quality for the re-encode.
 *
 * 0.82 is where text on a card is still crisp full-size on a laptop and the file
 * is a fraction of the original. Pushed to 0.6 the small print on an LTO licence
 * starts to break up, which is exactly the text an OCR provider needs.
 */
const JPEG_QUALITY = 0.82;
const FRONT_OCR_JPEG_QUALITY = 0.92;

export type IdUploadResult = {
  front: File;
  back: File | null;
  /**
   * 64-bit perceptual fingerprint of the card front, as 16 hex characters.
   *
   * Compared server-side against every other account's stored fingerprint to catch
   * one card covering two people. The card is already on a canvas by this point.
   * See src/lib/card-fingerprint.ts for the trust model.
   */
  cardHash: string | null;
};

export type IdUploadProps = {
  disabled?: boolean;
  /** Called with null whenever the selection is not yet uploadable. */
  onReady: (result: IdUploadResult | null) => void;
};

type Slot = "front" | "back";

const SLOT_COPY: Record<Slot, { label: string; hint?: string; required: boolean }> = {
  front: {
    label: "Front of the ID",
    hint: "Capture the side with the photo and details. Keep all four edges visible and the text clear.",
    required: true,
  },
  back: {
    label: "Back of the ID",
    required: false,
  },
};

/** Downscale an image file to a bounded JPEG. */
async function downscale(file: File, enhanceForOcr = false): Promise<File> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    // Not a decodable image. Passed through so the server produces the refusal,
    // which says more about what is wrong than anything this could guess.
    return file;
  }

  try {
    const maxEdge = enhanceForOcr ? FRONT_OCR_MAX_EDGE : MAX_EDGE;
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext("2d");
    if (!ctx) return file;

    if (enhanceForOcr) {
      ctx.filter = "contrast(1.12) saturate(0.92) brightness(1.03)";
      ctx.drawImage(bitmap, 0, 0, width, height);
      ctx.filter = "none";
    } else {
      ctx.drawImage(bitmap, 0, 0, width, height);
    }

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", enhanceForOcr ? FRONT_OCR_JPEG_QUALITY : JPEG_QUALITY)
    );
    if (!blob) return file;

    // The extension does not matter — the server sniffs the bytes — but keeping
    // the stem makes the upload readable in devtools when something goes wrong.
    const stem = file.name.replace(/\.[^.]+$/, "") || "id";
    return new File([blob], `${stem}.jpg`, { type: "image/jpeg" });
  } finally {
    bitmap.close();
  }
}

export default function IdUpload({ disabled, onReady }: IdUploadProps) {
  const [files, setFiles] = useState<Partial<Record<Slot, File>>>({});
  const [previews, setPreviews] = useState<Partial<Record<Slot, string>>>({});

  /**
   * The card's perceptual fingerprint, for the duplicate check.
   *
   * Kept independent so a fingerprint failure cannot affect the ID upload itself.
   */
  const [cardHash, setCardHash] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  /*
   * Which slot's camera is open, if any.
   *
   * One at a time, deliberately. Three live cameras at once would mean three
   * permission flows, three green privacy lights, and an admin photographing an
   * ID card through the laptop webcam while holding the card up to the phone.
   */
  const [camSlot, setCamSlot] = useState<Slot | null>(null);
  const [camBlocked, setCamBlocked] = useState<CameraProblem | null>(null);
  const [camBusy, setCamBusy] = useState(false);
  const [camFacing, setCamFacing] = useState<IdCameraFacing>("unknown");
  const [camDevices, setCamDevices] = useState<IdCameraChoice[]>([]);
  const [activeCameraId, setActiveCameraId] = useState("");
  const [pendingFront, setPendingFront] = useState<{ file: File; preview: string } | null>(null);

  const camVideoRef = useRef<HTMLVideoElement | null>(null);
  const guideRef = useRef<HTMLDivElement | null>(null);
  const camStreamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    if (!pendingFront) return;
    return () => URL.revokeObjectURL(pendingFront.preview);
  }, [pendingFront]);

  /*
   * Attach the stream to the video element as it mounts.
   *
   * A callback ref, for the reason the three face screens all use one: assigning
   * `srcObject` from the open routine raced the element's own mounting, and when
   * it lost the race the camera opened — light on, stream running — with nothing
   * assigned to the element, which reads as a broken camera rather than as the
   * bug it was. Assigning on mount makes the ordering irrelevant.
   */
  const attachCamStream = useCallback((node: HTMLVideoElement | null) => {
    camVideoRef.current = node;
    if (!node) return;
    const stream = camStreamRef.current;
    if (!stream) return;
    node.srcObject = stream;
    void node.play().catch(() => {});
  }, []);

  const stopCam = useCallback(() => {
    camStreamRef.current?.getTracks().forEach((t) => t.stop());
    camStreamRef.current = null;
    camVideoRef.current = null;
    setCamSlot(null);
  }, []);

  // A camera left running behind a closed modal keeps its privacy light on,
  // which is exactly the surprise FaceCapture's stop-on-unmount exists to avoid.
  useEffect(() => stopCam, [stopCam]);

  /*
   * The published result, and the object URLs, both have to survive re-renders
   * without becoming part of the render's dependencies — otherwise publishing a
   * new result would re-fire the publish effect, which would build another
   * result, which would fire it again.
   */
  const published = useRef<IdUploadResult | null>(null);
  const urls = useRef<string[]>([]);
  const slotSelectionVersions = useRef<Record<Slot, number>>({
    front: 0,
    back: 0,
  });

  useEffect(() => {
    const held = urls.current;
    return () => {
      for (const url of held) URL.revokeObjectURL(url);
    };
  }, []);

  const revoke = useCallback((url: string | undefined) => {
    if (!url) return;
    URL.revokeObjectURL(url);
    urls.current = urls.current.filter((u) => u !== url);
  }, []);

  const acceptCameraFront = useCallback(
    async (file: File) => {
      stopCam();
      setPendingFront({ file, preview: URL.createObjectURL(file) });
    },
    [stopCam]
  );

  const idScanner = useAutoIdCapture({
    videoRef: camVideoRef,
    guideRef,
    active: camSlot === "front" && !camBlocked && !camBusy,
    onCapture: acceptCameraFront,
  });
  const resumeIdScanner = idScanner.resume;

  /*
   * "Detected" = the local scanner has found a card-shaped outline, judged its
   * light, glare and distance acceptable, and is counting steady frames. This
   * is the green state: the preview ring, the status card and the steadiness
   * bar all switch on it, so someone holding the card can read "keep it
   * exactly like this" off the screen at a glance, without parsing words.
   */
  const idScanDetected =
    idScanner.phase === "hold" || idScanner.phase === "capturing";

  const pick = useCallback(
    async (slot: Slot, file: File | undefined) => {
      if (!file) return;

      if (!file.type.startsWith("image/")) {
        setNote(`${SLOT_COPY[slot].label} must be an image — a PDF cannot be read.`);
        return;
      }

      slotSelectionVersions.current[slot]++;
      const selectionVersion = slotSelectionVersions.current[slot];
      setNote(null);

      const small = await downscale(file, slot === "front");
      if (selectionVersion !== slotSelectionVersions.current[slot]) return;

      setFiles((prev) => ({ ...prev, [slot]: small }));

      setPreviews((prev) => {
        revoke(prev[slot]);
        const url = URL.createObjectURL(small);
        urls.current.push(url);
        return { ...prev, [slot]: url };
      });
    },
    [revoke]
  );

  /** Open the camera for one slot, closing whatever was open before. */
  const startCam = useCallback(
    async (slot: Slot, deviceId?: string) => {
      setNote(null);
      setCamBlocked(null);
      if (slot === "front") resumeIdScanner();

      // Checked before asking, so a plain-http LAN address gets an explanation
      // rather than a silent failure from getUserMedia — the common case here.
      const originProblem = cameraOriginProblem();
      if (originProblem) {
        setCamBlocked(originProblem);
        setCamSlot(slot);
        return;
      }

      setCamBusy(true);
      setCamSlot(slot);

      try {
        const result =
          slot === "front"
            ? await openIdEnrollmentCamera(deviceId)
            : { stream: await openIdCamera(), facing: "unknown" as const };
        const stream = result.stream;
        camStreamRef.current = stream;
        if (slot === "front") {
          const track = stream.getVideoTracks()[0];
          const selectedDeviceId = track?.getSettings().deviceId ?? deviceId ?? "";
          setActiveCameraId(selectedDeviceId);
          setCamFacing(result.facing);
          try {
            const devices = await listIdCameras();
            setCamDevices(devices);
            if (result.facing === "unknown") {
              setCamFacing(
                devices.find((camera) => camera.deviceId === selectedDeviceId)?.facing ??
                  "unknown"
              );
            }
          } catch (error) {
            setNote(
              error instanceof Error
                ? `Available cameras could not be listed: ${error.message}`
                : "Available cameras could not be listed."
            );
          }
        }
        // The <video> mounts because camSlot changed; attachCamStream runs on
        // that mount and picks the stream up.
        attachCamStream(camVideoRef.current);
      } catch (e) {
        stopCam();
        setCamBlocked(classifyCameraError(e));
        setCamSlot(slot);
      } finally {
        setCamBusy(false);
      }
    },
    [attachCamStream, resumeIdScanner, stopCam]
  );

  const switchCamera = useCallback(
    async (deviceId: string) => {
      if (!deviceId || deviceId === activeCameraId) return;
      camStreamRef.current?.getTracks().forEach((track) => track.stop());
      camStreamRef.current = null;
      await startCam("front", deviceId);
    },
    [activeCameraId, startCam]
  );

  /**
   * Take the picture and hand it to `pick` as if it had been chosen from a file.
   *
   * Going through the same handler is the whole design: the captured image is
   * then downscaled, previewed, face-read and published by exactly the code an
   * uploaded file goes through, so the two routes cannot produce different
   * results.
   */
  const shoot = useCallback(async () => {
    const slot = camSlot;
    const video = camVideoRef.current;
    if (!slot || !video) return;

    setCamBusy(true);
    try {
      const file = await captureIdFrame(video, slot);
      stopCam();
      await pick(slot, file);
    } catch (e) {
      setNote(e instanceof Error ? e.message : "That picture could not be taken. Try again.");
    } finally {
      setCamBusy(false);
    }
  }, [camSlot, pick, stopCam]);

  const clearSlot = useCallback(
    (slot: Slot) => {
      slotSelectionVersions.current[slot]++;
      setNote(null);
      setFiles((prev) => {
        const next = { ...prev };
        delete next[slot];
        return next;
      });
      setPreviews((prev) => {
        revoke(prev[slot]);
        const next = { ...prev };
        delete next[slot];
        return next;
      });
    },
    [revoke]
  );

  const confirmFrontCapture = useCallback(async () => {
    if (!pendingFront) return;
    await pick("front", pendingFront.file);
    setPendingFront(null);
  }, [pendingFront, pick]);

  const retakeFrontCapture = useCallback(() => {
    setPendingFront(null);
    void startCam("front", activeCameraId || undefined);
  }, [activeCameraId, startCam]);

  // Publish only when the selection actually differs from what was last handed
  // up, so the parent's state is not replaced on every unrelated render.
  useEffect(() => {
    if (!files.front) {
      if (published.current !== null) {
        published.current = null;
        onReady(null);
      }
      return;
    }

    const next: IdUploadResult = {
      front: files.front,
      back: files.back ?? null,
      cardHash,
    };

    const previous = published.current;
    if (
      previous &&
      previous.front === next.front &&
      previous.back === next.back &&
      previous.cardHash === next.cardHash
    ) {
      return;
    }

    published.current = next;
    onReady(next);
  }, [files, cardHash, onReady]);

  // Fingerprint the front whenever it changes.
  //
  // Keep duplicate-card checking independent from Face++ so a provider outage
  // cannot hide whether the same card is already attached.
  // to another account.
  useEffect(() => {
    const front = files.front;
    if (!front) {
      setCardHash(null);
      return;
    }

    let cancelled = false;
    const blobUrl = URL.createObjectURL(front);
    const image = new Image();

    image.onload = () => {
      if (cancelled) return;
      try {
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) return;
        ctx.drawImage(image, 0, 0);
        setCardHash(fingerprintFromCanvas(canvas));
      } catch {
        // A failure here costs the duplicate check and nothing else, which the
        // review screen says in as much. Nothing to recover from.
        setCardHash(null);
      }
    };

    image.onerror = () => {
      if (!cancelled) setCardHash(null);
    };
    image.src = blobUrl;

    return () => {
      cancelled = true;
      URL.revokeObjectURL(blobUrl);
    };
  }, [files.front]);

  return (
    <div className="space-y-4">
      {(Object.keys(SLOT_COPY) as Slot[]).map((slot) => (
        <section
          key={slot}
          aria-labelledby={`id-${slot}-label`}
          className={`rounded-2xl border p-3.5 sm:p-4 ${
            slot === "front"
              ? "border-ochre-300 bg-ochre-50/50"
              : "border-cream-200 bg-white"
          }`}
        >
          <div className="mb-3 flex items-start justify-between gap-3">
            <div>
              <h3 id={`id-${slot}-label`} className="text-sm font-semibold text-cocoa-800">
                {SLOT_COPY[slot].label}
              </h3>
              {SLOT_COPY[slot].hint && (
                <p className="mt-0.5 text-[11px] leading-snug text-cocoa-500">
                  {SLOT_COPY[slot].hint}
                </p>
              )}
            </div>
            <span
              className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-semibold ${
                SLOT_COPY[slot].required
                  ? "bg-ochre-100 text-ochre-800"
                  : "bg-cream-100 text-cocoa-500"
              }`}
            >
              {SLOT_COPY[slot].required ? "Required" : "Optional"}
            </span>
          </div>

          {/*
            The live preview, for whichever slot has its camera open.

            Rendered inside the slot it belongs to rather than as one panel at the
            bottom, so it appears exactly where the admin clicked "Use camera" —
            three separately-mounted elements would otherwise mean whichever one
            mounted last wins, and the preview could open under the wrong label.

            `autoPlay` and `muted` are load-bearing, not decoration: a video
            carrying a MediaStream draws no frames until it is playing, and a
            browser will refuse to start audible media that did not begin in a
            user gesture. Both are satisfied, and attachCamStream calls play()
            too, for browsers that ignore autoplay on a stream.
          */}
          {camSlot === slot && (
            <div className="relative mb-3 overflow-hidden rounded-2xl bg-cocoa-900">
              <video
                ref={attachCamStream}
                playsInline
                muted
                autoPlay
                className="mx-auto block max-h-72 w-full object-contain"
              />

              {/*
                The framing guide. A card-shaped outline rather than a full-bleed
                frame, so the admin is filling the picture with the card rather
                than filling the card with the picture — and so the capture lands
                inside the 1.05-2.6 aspect band the server checks instead of
                beside it.
              */}
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 flex items-center justify-center p-5"
              >
                <div
                  ref={slot === "front" ? guideRef : undefined}
                  className={`aspect-[1.59/1] w-[88%] max-w-[21rem] rounded-xl border-2 border-dashed shadow-[0_0_0_999px_rgba(22,18,14,0.28)] transition-colors ${
                    idScanDetected ? "border-green-400 shadow-[0_0_0_999px_rgba(22,18,14,0.18)]" : "border-cream-100/80"
                  }`}
                />
              </div>

              {camBlocked && (
                <div className="absolute inset-0 flex items-center justify-center bg-cocoa-900/85 px-4 text-center">
                  <p className="text-sm text-cream-200">
                    {describeCameraProblem(camBlocked).message}
                  </p>
                </div>
              )}
            </div>
          )}

          {slot === "front" && camSlot === "front" && !camBlocked && camDevices.length > 1 && (
            <label className="mb-3 flex items-center gap-2 text-xs text-cocoa-600">
              Camera
              <select
                aria-label="ID camera"
                className="min-w-0 flex-1 rounded-lg border border-cream-300 bg-white px-2.5 py-2"
                value={activeCameraId}
                disabled={camBusy}
                onChange={(event) => void switchCamera(event.target.value)}
              >
                <option value="">Select a camera</option>
                {camDevices.map((camera) => (
                  <option key={camera.deviceId} value={camera.deviceId}>
                    {camera.label}
                    {camera.facing === "rear" ? " (rear)" : ""}
                  </option>
                ))}
              </select>
            </label>
          )}

          {slot === "front" &&
            camSlot === "front" &&
            !camBlocked &&
            !camBusy &&
            camFacing !== "rear" && (
            <p
              className="mb-3 rounded-xl border border-cream-200 bg-cream-50 px-3.5 py-3 text-xs leading-relaxed text-cocoa-700"
            >
              Automatic scanning is active on this camera. It waits for a card-shaped outline and a
              steady frame; you will review the photo before it can be used.
            </p>
          )}

          {slot === "front" && pendingFront && (
            <div className="mb-3 rounded-xl border border-ochre-200 bg-white p-3.5">
              <p className="text-sm font-semibold text-cocoa-800">Review the ID photo</p>
              <p className="mt-1 text-xs leading-relaxed text-cocoa-500">
                Make sure this shows the whole ID card, not your face. It will not be added until
                you confirm.
              </p>
              <div className="mt-3 overflow-hidden rounded-lg bg-cocoa-900">
                <img
                  src={pendingFront.preview}
                  alt="Captured ID photo pending confirmation"
                  className="max-h-64 w-full object-contain"
                />
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn-primary !px-3 !py-1.5 text-xs"
                  disabled={disabled}
                  onClick={() => void confirmFrontCapture()}
                >
                  Use this ID
                </button>
                <button
                  type="button"
                  className="btn-ghost !px-3 !py-1.5 text-xs"
                  disabled={disabled}
                  onClick={retakeFrontCapture}
                >
                  Retake
                </button>
              </div>
            </div>
          )}

          {slot === "front" && camSlot === "front" && !camBlocked && (
            <div
              className={`mb-3 rounded-xl border px-3.5 py-3 transition-colors ${
                idScanDetected
                  ? "border-green-200 bg-green-50"
                  : "border-cream-200 bg-white"
              }`}
            >
              <div className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className={`h-2.5 w-2.5 shrink-0 rounded-full ${
                    idScanner.phase === "capturing"
                      ? "animate-pulse bg-green-600"
                      : idScanDetected
                        ? "bg-green-600"
                        : "bg-cocoa-300"
                  }`}
                />
                <p
                  role="status"
                  aria-live="polite"
                  className={`text-xs font-medium ${idScanDetected ? "text-green-800" : "text-cocoa-700"}`}
                >
                  {idScanner.message}
                </p>
              </div>
              <div
                className={`mt-2 h-1.5 overflow-hidden rounded-full ${
                  idScanDetected ? "bg-green-100" : "bg-cream-100"
                }`}
                role="progressbar"
                aria-label="ID steadiness"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(idScanner.holdProgress * 100)}
              >
                <div
                  className={`h-full rounded-full transition-[width] duration-200 ${
                    idScanDetected ? "bg-green-600" : "bg-ochre-500"
                  }`}
                  style={{ width: `${Math.round(idScanner.holdProgress * 100)}%` }}
                />
              </div>
              <p className="mt-2 text-[10px] leading-snug text-cocoa-400">
                The scanner checks for a card-shaped outline, then straightens it for reading. You
                must confirm every camera photo. Scanning does not verify that an ID is genuine.
              </p>
            </div>
          )}

          {camSlot === slot && camBlocked && (
            <div className="mb-1.5 rounded-xl bg-amber-50 px-3 py-2.5 text-[11px] leading-snug text-cocoa-700">
              <p>
                {camBlocked === "permission-denied" && permissionHelp("denied")
                  ? permissionHelp("denied")
                  : describeCameraProblem(camBlocked).help}
              </p>
              <p className="mt-1">
                You can still choose a picture from a file above — on a phone that
                opens the camera app and works the same way.
              </p>
            </div>
          )}

          <div className="grid grid-cols-[6rem_minmax(0,1fr)] items-start gap-3 sm:grid-cols-[8rem_minmax(0,1fr)]">
            <div className="flex aspect-[1.59/1] w-24 items-center justify-center overflow-hidden rounded-xl border border-cream-200 bg-cream-100 sm:w-32">
              {previews[slot] ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={previews[slot]}
                  alt={`Preview of ${SLOT_COPY[slot].label}`}
                  className="h-full w-full object-contain"
                />
              ) : (
                <span className="flex h-full w-full items-center justify-center px-1 text-center text-[10px] text-cocoa-400">
                  Not captured
                </span>
              )}
            </div>

            <div className="min-w-0 flex-1 space-y-1.5">
              {/*
                The camera, beside the file picker — never instead of it.

                Uploading stays because it is what works when the camera does
                not, and the two answer to genuinely different situations: a
                phone photographing a card it is holding, versus a laptop
                receiving a picture somebody took earlier.

                `capture="environment"` on the input is the part that matters
                most on a phone. getUserMedia needs a secure origin and the cafe
                LAN is plain http, where it can never work — but the OS picker
                behind a `capture` attribute opens the phone's own camera app
                regardless, so the file input *is* a camera on exactly the
                devices the in-page camera cannot reach. Without it those phones
                get a file chooser and a shrug.
              */}
              <input
                id={`id-${slot}`}
                type="file"
                accept="image/*"
                capture="environment"
                disabled={disabled || camSlot === slot || (slot === "front" && !!pendingFront)}
                onChange={(e) => void pick(slot, e.target.files?.[0])}
                className="block w-full text-xs text-cocoa-600 file:mr-2 file:rounded-lg file:border-0 file:bg-cream-100 file:px-2.5 file:py-1.5 file:text-xs file:font-semibold file:text-cocoa-700"
              />

              <div className="flex flex-wrap items-center gap-2">
                {camSlot === slot ? (
                  <>
                    <button
                      type="button"
                      className="btn-primary !px-3 !py-1 text-xs"
                      disabled={disabled || camBusy}
                      onClick={() =>
                        slot === "front"
                          ? void idScanner.captureManually()
                          : void shoot()
                      }
                    >
                      {camBusy
                        ? "Taking…"
                        : slot === "front"
                          ? "Capture manually"
                          : "Take the picture"}
                    </button>
                    <button
                      type="button"
                      className="text-[11px] text-cocoa-400 underline"
                      onClick={stopCam}
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="btn-ghost !px-3 !py-1 text-xs"
                    disabled={disabled || camSlot !== null}
                    onClick={() => void startCam(slot)}
                  >
                    {files[slot] ? "Retake with camera" : "Use camera"}
                  </button>
                )}

                {files[slot] && camSlot !== slot && (
                  <button
                    type="button"
                    className="text-[11px] text-terracotta-600 underline"
                    onClick={() => clearSlot(slot)}
                    disabled={disabled}
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>
          </div>
        </section>
      ))}

      {note && (
        <div className="rounded-xl bg-ochre-50 px-3 py-2.5 text-[11px] leading-snug text-ochre-700">
          {note}
        </div>
      )}
    </div>
  );
}
