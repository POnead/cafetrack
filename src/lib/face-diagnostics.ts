"use client";

/**
 * Why the camera will not open, and what to do about it.
 *
 * Every face screen in this app needs the same answer to the same question, and
 * until now each one worked it out separately: the enrolment capture, the duty
 * check, and (once it exists) sign-in. Three implementations of "can I open a
 * camera here?" produce three different explanations for the same failure, which
 * is how "it doesn't open" reaches support with no reproduction and no error.
 *
 * So the diagnosis lives here, once, and every screen asks it.
 *
 * **Why this is separate from face-client.ts.** That module is the model: weights,
 * backends, reading a face. This one is the browser's opinion about hardware, and
 * it must be answerable without loading 6.7MB of weights — a person whose camera
 * is blocked should be told in a millisecond, not after a model download.
 *
 * Everything here is split into a pure `classify*` function and the thin browser
 * wrapper around it, so the logic that decides *what a failure means* is testable
 * in Node with no camera, no browser and no permission prompt.
 */

/**
 * Why a camera cannot be used here.
 *
 * Ordered roughly from "the address is wrong" to "something is genuinely
 * missing", because that is the order a person can act on them.
 */
export type CameraProblem =
  /** Plain http to a non-localhost address. No library can work around this. */
  | "insecure-origin"
  /** `navigator.mediaDevices` is absent — older browser, or a blocked origin. */
  | "no-camera-api"
  /** The user (or the browser) refused. Chrome will not ask again. */
  | "permission-denied"
  /** Permission is fine, but the machine reports no camera at all. */
  | "no-device"
  /** A camera exists but is claimed by another app (Zoom, Teams, a video call). */
  | "device-busy"
  /** The recognition weights are not installed. */
  | "models-missing"
  /** getUserMedia failed for a reason we do not recognise. */
  | "unknown";

export type CameraDiagnosis =
  | {
      ok: true;
      /** A camera was found. Null when the browser hides labels pre-permission. */
      deviceLabel: string | null;
    }
  | {
      ok: false;
      problem: CameraProblem;
      /** One sentence, in the app's voice. */
      message: string;
      /** Concrete steps, when there are any. Null when there are none to give. */
      help: string | null;
      /**
       * Whether clicking again could plausibly change the answer.
       *
       * False for the two cases that are terminal: an insecure address will not
       * become secure by itself, and missing weights will not appear without
       * running the setup command. Showing a retry button that cannot work is
       * worse than showing none.
       */
      retryable: boolean;
    };

/* ------------------------------------------------------------------ pure -- */

/**
 * Read the real cause out of a `getUserMedia` rejection.
 *
 * DOMException `name` is the only thing available — the message text is
 * browser-specific and was historically inconsistent, so keying off it is how a
 * permission denial ends up reported as "no camera found".
 *
 * Kept separate from the call so it can be tested against every name the spec
 * defines without a camera present.
 */
export function classifyCameraError(error: unknown): CameraProblem {
  const name =
    typeof error === "object" && error !== null && "name" in error
      ? String((error as { name?: unknown }).name)
      : "";

  switch (name) {
    /*
     * The refusal case, and the one worth being precise about: NotAllowedError
     * is also what a browser returns when the *origin* is not permitted to use
     * a camera at all, which overlaps insecure-origin. The caller checks the
     * origin first, so by the time an error arrives the origin is known good and
     * this really is a permission refusal.
     */
    case "NotAllowedError":
    case "PermissionDeniedError":
    case "SecurityError":
      return "permission-denied";

    // Nothing attached, or nothing matching the requested constraints.
    case "NotFoundError":
    case "DevicesNotFoundError":
    case "OverconstrainedError":
      return "no-device";

    // Hardware is present but another process holds it.
    case "NotReadableError":
    case "TrackStartError":
      return "device-busy";

    default:
      return "unknown";
  }
}

/**
 * The wording for each problem.
 *
 * One table rather than an if-else chain at the call site, because the same
 * sentence appearing twice with different advice is exactly how the three
 * screens drift apart. `retryable` lives here too: whether a retry button makes
 * sense is a property of the problem, not of the screen showing it.
 */
export function describeCameraProblem(problem: CameraProblem): {
  message: string;
  help: string | null;
  retryable: boolean;
} {
  switch (problem) {
    case "insecure-origin":
      return {
        message: "This address cannot use the camera.",
        help:
          "Browsers only allow a camera over https, or on localhost. This page is " +
          "on a plain http address, so the camera is refused before any script runs. " +
          "Use “Upload a photo” below, or open the app on the computer itself at " +
          "localhost to use the camera.",
        // An address does not become secure on its own. Retrying is a dead end.
        retryable: false,
      };

    case "no-camera-api":
      return {
        message: "This browser does not offer a camera to the page.",
        help:
          "Try a current version of Chrome, Edge, Safari or Firefox. If you are on a " +
          "phone, “Upload a photo” opens the phone's own camera app instead and works " +
          "without one.",
        retryable: false,
      };

    case "permission-denied":
      return {
        message: "The camera is blocked for this site.",
        help:
          "Allow the camera in your browser's site settings for this address, then " +
          "use “Check again”. Browsers do not re-ask once you have said no, so this " +
          "cannot be fixed from inside the page — and until it is, “Upload a photo” " +
          "below does exactly the same job.",
        // The setting is outside the page, so a retry is how you find out whether
        // the user has changed it yet. Worth offering.
        retryable: true,
      };

    case "no-device":
      return {
        message: "No camera was found on this device.",
        help:
          "Check that a camera is connected and not disabled in the operating " +
          "system, then “Check again”. Or use “Upload a photo” below.",
        retryable: true,
      };

    case "device-busy":
      return {
        message: "The camera is being used by another program.",
        help:
          "Close anything else that is holding the camera — a video call, another " +
          "browser tab, a meeting app — then “Check again”.",
        retryable: true,
      };

    case "models-missing":
      return {
        message: "The face model files are not installed.",
        help:
          "Run npm run setup:face on the server and reload this page. Until then no " +
          "camera can recognise a face, however good it is.",
        // They will not appear without running the command.
        retryable: false,
      };

    default:
      return {
        message: "The camera could not be opened here.",
        help: "Try again, or use “Upload a photo” below instead.",
        retryable: true,
      };
  }
}

/* ---------------------------------------------------------------- browser -- */

/**
 * Whether this origin may use a camera *at all*.
 *
 * The one check that must happen before anything else, including the permission
 * query. Over plain http to anything that is not localhost there is no
 * `navigator.mediaDevices` object at all, so both the query and `getUserMedia`
 * would fail in ways that read as "the camera is broken" rather than "this
 * address cannot have one".
 */
export function cameraOriginProblem(): CameraProblem | null {
  if (typeof window === "undefined") return "no-camera-api";
  if (!window.isSecureContext) return "insecure-origin";
  if (!navigator.mediaDevices?.getUserMedia) return "no-camera-api";
  return null;
}

/** Whether the weights are actually installed, so a capture could work. */
export async function modelsInstalled(): Promise<boolean> {
  const { modelsPresent } = await import("./face-client");
  return modelsPresent();
}

/**
 * Ask the browser whether the camera is usable, without opening it.
 *
 * Deliberately does **not** call `getUserMedia`. Opening a camera here would
 * either trigger the permission prompt (which must only ever appear after
 * someone has chosen to use the camera) or, worse, quietly start recording
 * while someone is reading a diagnostic panel.
 *
 * Answers these, in order:
 *   - is this origin allowed to have a camera at all
 *   - has the permission been refused outright
 *   - is a camera actually attached
 *
 * A `denied` permission is reported even when a device is present, because the
 * refusal is the actionable fact — "no camera" would send someone to check their
 * hardware when the real cause is a browser setting.
 */
export async function probeCamera(): Promise<CameraDiagnosis> {
  const originProblem = cameraOriginProblem();
  if (originProblem) return failure(originProblem);

  let permission: string = "unknown";
  try {
    // Not supported in every browser; "unknown" is a normal answer, not a fault.
    const status = await navigator.permissions?.query({ name: "camera" as any });
    permission = status?.state ?? "unknown";
  } catch {
    permission = "unknown";
  }

  // An outright refusal is the answer regardless of what else is true.
  if (permission === "denied") return failure("permission-denied");

  /*
   * Device labels are hidden until permission has been granted, so an empty
   * label is expected and not itself a fault. Counting the kinds is what
   * matters.
   */
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = devices.filter((d) => d.kind === "videoinput");
    if (cameras.length === 0) return failure("no-device");

    const labelled = cameras.find((d) => d.label);
    return {
      ok: true,
      deviceLabel: labelled?.label ?? null,
    };
  } catch {
    /*
     * Enumeration can fail where getUserMedia would still succeed, so this is
     * deliberately NOT treated as "no device". Answering "we cannot see a
     * camera" from a failed enumeration is a guess dressed as a fact, and it
     * would block a person whose camera works perfectly.
     */
    return { ok: true, deviceLabel: null };
  }
}

/** Build a failed diagnosis from the shared wording table. */
export function failure(problem: CameraProblem): CameraDiagnosis {
  const { message, help, retryable } = describeCameraProblem(problem);
  return { ok: false, problem, message, help, retryable };
}

/** Whether this origin can use a camera at all — the cheap synchronous check. */
export function cameraUsableHere(): boolean {
  return cameraOriginProblem() === null;
}