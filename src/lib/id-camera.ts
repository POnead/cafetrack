"use client";

/**
 * Taking a picture of an ID card with a camera.
 *
 * Separate from `lib/face-client.ts` even though both open a camera, because an
 * ID is not a face and the two differ in ways that are easy to get wrong:
 *
 *   - **Which camera.** `openCamera()` there asks for `facingMode: "user"` — the
 *     front one, pointed at whoever is using the device. An ID is held flat in
 *     front of the *rear* camera on every phone that has one, so asking for the
 *     wrong one gets a photo of the ceiling.
 *
 *   - **The shape of the output.** `toJpegDataUrl` there centre-crops to a
 *     square, which is right for a face and badly wrong here. The server's own
 *     shape check refuses anything below a 1.05:1 aspect ratio as "not a card"
 *     (see CARD_ASPECT_MIN in lib/id-verification/local.ts), and a 1:1 capture
 *     sits just under it — so reusing that function would make every capture
 *     raise a warning that is true of the code and false of the card.
 *
 * The camera *problems* are deliberately not duplicated. Diagnosis and wording
 * come from lib/face-diagnostics.ts, so a camera that is blocked on this screen
 * is described in exactly the words it would be on the face screens rather than
 * becoming a fourth, differently-worded explanation of the same fault.
 */

/** Long edge of a captured frame. Comfortably under the 3MB server limit. */
const CAPTURE_EDGE = 1600;

/** JPEG quality. Matches the re-encode IdUpload already applies to files. */
const CAPTURE_QUALITY = 0.82;

/**
 * Ask for a camera pointed at the card.
 *
 * `facingMode: "environment"` first, then anything. The fallback is not
 * politeness: a laptop has one camera and reports it as whatever it likes, and
 * a device that cannot supply an "environment" camera would otherwise fail
 * outright rather than opening the one it has.
 *
 * Constrained the same way the face capture is — a hand-held device at a card,
 * not a studio.
 */
export async function openIdCamera(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error(
      "This browser will not open a camera here. The address has to start with https:// (or be localhost)."
    );
  }

  // A hand-held device held over a card, not a studio. Same budget as the face
  // capture, which is deliberately modest so a cheap phone still copes.
  const size = { width: { ideal: 1600 }, height: { ideal: 1200 } };

  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { ...size, facingMode: { ideal: "environment" } },
    });
  } catch (e) {
    /*
     * Retry with no camera hint before giving up.
     *
     * A laptop has one camera and reports it as whatever it likes, so the
     * "environment" request can come back empty on hardware that has a perfectly
     * good camera. Only a genuine refusal reaches this point; if the second
     * attempt fails too, the original error is the informative one.
     */
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: false, video: size });
    } catch {
      throw e;
    }
  }
}

/**
 * Turn the current video frame into a File, keeping its shape.
 *
 * No crop, and that is the point — see the header. A card photographed straight
 * on arrives at whatever ratio the camera produces (4:3 from most devices),
 * which sits comfortably inside the band the server checks. Cropping to square
 * would put it just outside.
 *
 * Refuses rather than returning an empty file when the video has produced no
 * frame yet: a canvas drawn from a 0x0 video is a blank image, and a blank image
 * is worse than an error because it looks like a photo of a blank card.
 */
export async function captureIdFrame(
  video: HTMLVideoElement,
  slot: string
): Promise<File> {
  const width = video.videoWidth;
  const height = video.videoHeight;

  if (!width || !height) {
    throw new Error(
      "The camera is still starting — take the picture again in a moment."
    );
  }

  const scale = Math.min(1, CAPTURE_EDGE / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser cannot process the photo");

  // Straight scale, both axes by the same factor. Anything else would shear the
  // card and make a rectangle look like a trapezoid.
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", CAPTURE_QUALITY)
  );
  if (!blob) throw new Error("That picture could not be saved. Take it again.");

  // The name is only for readability in devtools — the server sniffs the bytes,
  // not the extension. But `slot` in it makes a mis-ordered upload obvious.
  const safe = slot.replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "id";
  return new File([blob], `${safe}-camera.jpg`, { type: "image/jpeg" });
}