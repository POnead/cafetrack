"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { loadFaceModels, readFace } from "@/lib/face-client";
import { cameraAvailable, permissionHelp } from "@/lib/face-client";
import {
  cameraOriginProblem,
  classifyCameraError,
  describeCameraProblem,
  type CameraProblem,
} from "@/lib/face-diagnostics";
import { captureIdFrame, openIdCamera } from "@/lib/id-camera";
import { fingerprintFromCanvas } from "@/lib/card-fingerprint";

/**
 * Attach a government ID and a photo of the person, and send both up.
 *
 * Loaded with `ssr: false` and `next/dynamic` by its callers, for the same
 * reason FaceCapture is: reading a face pulls in face-api and TensorFlow, which
 * together are several megabytes, and the staff list is a page an admin opens
 * constantly for something that usually has nothing to do with photos.
 *
 * ## Why face-client is imported here and not passed in
 *
 * Importing it in the parent would put face-api and TensorFlow into that page's
 * *initial* download — the dynamic boundary would still work, but the module
 * graph would be resolved by the page that renders the button, and the several
 * megabytes would be fetched whether or not the admin ever opens this. Owning
 * the import inside the component that needs it is what keeps the staff list
 * light.
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
 * **Reading two faces.** The portrait printed on the card and the face in the
 * photo are both turned into 128-float descriptors here, in the browser, and both
 * go up as vectors. The server compares them with the same cosine distance every
 * other face comparison in this app uses.
 *
 * Neither descriptor is the picture: it is 1.5KB of floats that cannot be
 * displayed. The pictures are still uploaded, because an admin has to look at
 * them — that judgement is the whole point.
 *
 * **Failure is soft.** No face in the card image, or no face in the photo, is not
 * an error. It becomes an "unknown" signal on the review screen saying the
 * comparison could not run. Refusing the upload would turn the model's inability
 * to read a face into a refusal to record an ID.
 */

/** Long edge, in pixels, that every image is reduced to before upload. */
const MAX_EDGE = 1600;

/**
 * JPEG quality for the re-encode.
 *
 * 0.82 is where text on a card is still crisp full-size on a laptop and the file
 * is a fraction of the original. Pushed to 0.6 the small print on an LTO licence
 * starts to break up, which is exactly the text an OCR provider needs.
 */
const JPEG_QUALITY = 0.82;

export type IdUploadResult = {
  front: File;
  back: File | null;
  photo: File | null;
  /** 128 floats from the portrait printed on the card, if one was read. */
  cardEmbedding: number[] | null;
  /** 128 floats from the photo of the person, if one was read. */
  photoEmbedding: number[] | null;
  /**
   * 64-bit perceptual fingerprint of the card front, as 16 hex characters.
   *
   * Compared server-side against every other account's stored fingerprint to catch
   * one card covering two people. Computed here for the same reason the embeddings
   * are: the server has no image decoder, and the card is already on a canvas by
   * this point. See src/lib/card-fingerprint.ts for the trust model this shares
   * with the descriptors above.
   */
  cardHash: string | null;
};

export type IdUploadProps = {
  disabled?: boolean;
  /** Called with null whenever the selection is not yet uploadable. */
  onReady: (result: IdUploadResult | null) => void;
};

type Slot = "front" | "back" | "photo";

const SLOT_COPY: Record<Slot, { label: string; hint: string; required: boolean }> = {
  front: {
    label: "Front of the ID",
    hint: "The side with the photo and the details. Fill the frame — the card should be the whole picture.",
    required: true,
  },
  back: {
    label: "Back of the ID",
    hint: "Optional. Most Philippine IDs are single-sided; a passport has useful text here.",
    required: false,
  },
  photo: {
    label: "Photo of the person",
    hint: "A clear photo of the applicant, looking at the camera. Without one the portrait cannot be compared.",
    required: false,
  },
};

/** Downscale an image file to a bounded JPEG. */
async function downscale(file: File): Promise<File> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    // Not a decodable image. Passed through so the server produces the refusal,
    // which says more about what is wrong than anything this could guess.
    return file;
  }

  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext("2d");
    if (!ctx) return file;

    ctx.drawImage(bitmap, 0, 0, width, height);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY)
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

/** A canvas holding an already-decoded image, ready for the face model. */
async function toCanvas(file: File): Promise<HTMLCanvasElement | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null;
  }

  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0);
    return canvas;
  } finally {
    bitmap.close();
  }
}

export default function IdUpload({ disabled, onReady }: IdUploadProps) {
  const [files, setFiles] = useState<Partial<Record<Slot, File>>>({});
  const [previews, setPreviews] = useState<Partial<Record<Slot, string>>>({});
  const [embeddings, setEmbeddings] = useState<{
    cardEmbedding: number[] | null;
    photoEmbedding: number[] | null;
  }>({ cardEmbedding: null, photoEmbedding: null });

  /**
   * The card's perceptual fingerprint, for the duplicate check.
   *
   * Held separately from `embeddings` because it fails for a completely different
   * reason: the descriptors come back null when there is no *face* to find, while
   * this is null when the canvas cannot be read at all. Folding them together would
   * mean a card with no portrait quietly losing its duplicate check too.
   */
  const [cardHash, setCardHash] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
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

  const camVideoRef = useRef<HTMLVideoElement | null>(null);
  const camStreamRef = useRef<MediaStream | null>(null);

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

  /**
   * Read whatever faces the current selection allows.
   *
   * Takes the two files as arguments rather than reading them from state: it is
   * called from inside the change handler where `files` is still the previous
   * value, and a callback closing over that would compare the card against a
   * photo the admin has not chosen yet.
   */
  const readFaces = useCallback(
    async (front: File | undefined, photo: File | undefined) => {
      if (!front) {
        setEmbeddings({ cardEmbedding: null, photoEmbedding: null });
        setReading(false);
        return;
      }

      setReading(true);
      const warnings: string[] = [];

      try {
        await loadFaceModels();
      } catch {
        setEmbeddings({ cardEmbedding: null, photoEmbedding: null });
        setNote(
          "The face-matching model could not be loaded, so the portrait will not be compared. " +
            "Everything else still runs."
        );
        setReading(false);
        return;
      }

      let cardEmbedding: number[] | null = null;
      let photoEmbedding: number[] | null = null;

      const frontCanvas = await toCanvas(front);
      if (!frontCanvas) {
        warnings.push("The front of the ID could not be opened as an image.");
      } else {
        const read = await readFace(frontCanvas);
        if (read.ok) {
          cardEmbedding = read.embedding;
        } else {
          warnings.push(
            "No face could be read from the card image, so the printed portrait will not be " +
              "compared. Check the card is large enough in the photo."
          );
        }
      }

      if (photo) {
        const photoCanvas = await toCanvas(photo);
        if (!photoCanvas) {
          warnings.push("The photo of the person could not be opened as an image.");
        } else {
          const read = await readFace(photoCanvas);
          if (read.ok) {
            photoEmbedding = read.embedding;
          } else {
            warnings.push("No face could be read from the photo, so nothing will be compared.");
          }
        }
      }

      setEmbeddings({ cardEmbedding, photoEmbedding });
      setNote(warnings.length ? warnings.join(" ") : null);
      setReading(false);
    },
    /*
     * Nothing reactive is captured: the two files arrive as arguments, the
     * setters are stable, and `toCanvas`, `loadFaceModels` and `readFace` are
     * module scope. Listing the imports here was not just noise — the lint rule
     * is right that a module binding can never change in a way a re-render
     * would observe, so the array was describing a dependency that does not
     * exist.
     */
    []
  );
  const pick = useCallback(
    async (slot: Slot, file: File | undefined) => {
      if (!file) return;

      if (!file.type.startsWith("image/")) {
        setNote(`${SLOT_COPY[slot].label} must be an image — a PDF cannot be read.`);
        return;
      }

      setNote(null);

      const small = await downscale(file);

      setFiles((prev) => {
        const next = { ...prev, [slot]: small };
        // The next selection is worked out here, from `next`, so the face read
        // sees the images the admin has actually chosen rather than the ones
        // that were there when this handler started.
        queueMicrotask(() => {
          if (slot === "front" || slot === "photo") {
            void readFaces(next.front, next.photo);
          }
        });
        return next;
      });

      setPreviews((prev) => {
        revoke(prev[slot]);
        const url = URL.createObjectURL(small);
        urls.current.push(url);
        return { ...prev, [slot]: url };
      });
    },
    [readFaces, revoke]
  );

  /** Open the camera for one slot, closing whatever was open before. */
  const startCam = useCallback(
    async (slot: Slot) => {
      setNote(null);
      setCamBlocked(null);

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
        const stream = await openIdCamera();
        camStreamRef.current = stream;
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
    [attachCamStream, stopCam]
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
      setFiles((prev) => {
        const next = { ...prev };
        delete next[slot];
        queueMicrotask(() => void readFaces(next.front, next.photo));
        return next;
      });
      setPreviews((prev) => {
        revoke(prev[slot]);
        const next = { ...prev };
        delete next[slot];
        return next;
      });
    },
    [readFaces, revoke]
  );

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
      photo: files.photo ?? null,
      cardEmbedding: embeddings.cardEmbedding,
      photoEmbedding: embeddings.photoEmbedding,
      cardHash,
    };

    const previous = published.current;
    if (
      previous &&
      previous.front === next.front &&
      previous.back === next.back &&
      previous.photo === next.photo &&
      previous.cardEmbedding === next.cardEmbedding &&
      previous.photoEmbedding === next.photoEmbedding &&
      previous.cardHash === next.cardHash
    ) {
      return;
    }

    published.current = next;
    onReady(next);
  }, [files, embeddings, cardHash, onReady]);

  // Fingerprint the front whenever it changes.
  //
  // On the file rather than inside readFaces, because readFaces is skipped when
  // there is no photo of the person to compare against — and a card with no
  // accompanying photo is exactly the case where an admin most needs to know
  // whether that card is already on file somewhere else.
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
    <div className="space-y-3">
      {(Object.keys(SLOT_COPY) as Slot[]).map((slot) => (
        <div key={slot}>
          <label className="label" htmlFor={`id-${slot}`}>
            {SLOT_COPY[slot].label}
            {!SLOT_COPY[slot].required && (
              <span className="ml-1 font-normal text-cocoa-400">(optional)</span>
            )}
          </label>

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
            <div className="relative mb-2 overflow-hidden rounded-xl bg-cocoa-900">
              <video
                ref={attachCamStream}
                playsInline
                muted
                autoPlay
                className="mx-auto block w-full max-w-sm"
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
                className="pointer-events-none absolute inset-0 flex items-center justify-center p-3"
              >
                <div className="aspect-[1.59/1] w-full max-w-[15rem] rounded-lg border-2 border-dashed border-cream-100/60" />
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

          <div className="flex items-start gap-3">
            <div className="h-20 w-28 shrink-0 overflow-hidden rounded-xl border border-cream-200 bg-cream-100">
              {previews[slot] ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={previews[slot]}
                  alt={`Preview of ${SLOT_COPY[slot].label}`}
                  className="h-full w-full object-cover"
                />
              ) : (
                <span className="flex h-full w-full items-center justify-center text-[10px] text-cocoa-400">
                  No image
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
                disabled={disabled || camSlot === slot}
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
                      onClick={() => void shoot()}
                    >
                      {camBusy ? "Taking…" : "Take the picture"}
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
                    Use camera
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
              <p className="text-[11px] leading-snug text-cocoa-400">{SLOT_COPY[slot].hint}</p>
            </div>
          </div>
        </div>
      ))}

      {reading && <p className="text-[11px] text-cocoa-500">Looking for the face on the card…</p>}

      {note && (
        <div className="rounded-xl bg-ochre-50 px-3 py-2.5 text-[11px] leading-snug text-ochre-700">
          {note}
        </div>
      )}
    </div>
  );
}
