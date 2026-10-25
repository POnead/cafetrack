/**
 * The Tesseract worker: its lifetime, its language file, and its failure modes.
 *
 * **Server-only.** This module touches `process.env`, the filesystem and a WASM
 * runtime, none of which exist in a browser. Keeping it in its own file means the
 * bundler can be told so by a single import, rather than by hoping nobody imports
 * the right thing from the wrong side.
 *
 * ## Why one long-lived worker
 *
 * Initialising a worker costs ~0.7s and holds tens of megabytes of WASM and model.
 * Paying that per verification would be the difference between a check that feels
 * instant and one that feels broken — and ID verification happens on the same
 * register machine as everything else in CafeTrack, which is not a machine anyone
 * would call fast.
 *
 * So the worker is created on first use, shared for as long as the process is
 * doing ID checks, and torn down once it has been idle for a while. The teardown
 * is not optional hygiene: a café machine that never runs another onboarding is
 * the common case, and holding a worker forever would cost memory for nothing.
 */

import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import type { OcrWord } from "./rows";

/* -------------------------------------------------------------- language -- */

/**
 * Where the language model is kept.
 *
 * Tesseract's default is the *current working directory*, which put a 5MB
 * `eng.traineddata` in the repository root the first time this ran. It is moved
 * here: still inside the app, still deleted with it, but in one named place rather
 * than scattered.
 */
export const CACHE_DIR = path.join(process.cwd(), ".cache", "tesseract");

const LANG = "eng";

/**
 * Whether the language file is already on disk.
 *
 * Checked by `available()` on the provider so that a café whose first run happened
 * without internet reports "the OCR model has not been downloaded" rather than
 * failing mid-upload. That distinction is the whole reason this is a separate
 * function and not an inline `existsSync` at the call site.
 */
export function languageModelPresent(): boolean {
  return existsSync(path.join(CACHE_DIR, `${LANG}.traineddata.gz`)) ||
    existsSync(path.join(CACHE_DIR, `${LANG}.traineddata`));
}

/* ---------------------------------------------------------------- worker -- */

/*
 * Deliberately untyped at this boundary. `tesseract.js` ships its own types, but
 * importing them pulls in a declaration that assumes a browser, and the only
 * things actually needed here are the worker and the box-with-text shape below.
 */
type Box = { x0: number; y0: number; x1: number; y1: number };

type RawWord = { text: string; confidence: number; bbox: Box };

type Worker = {
  recognize(
    image: Uint8Array,
    options?: Record<string, unknown>,
    output?: Record<string, boolean>
  ): Promise<{ data: { text: string; confidence: number; blocks: unknown } }>;
  terminate(): Promise<unknown>;
};

let worker: Worker | null = null;
let starting: Promise<Worker> | null = null;
let lastUsedAt = 0;

/**
 * The last error the worker reported, if any.
 *
 * Read by `runOcr` to turn a hung recognition into a specific failure instead of
 * a generic timeout, which is the difference between "the text reader is not
 * available" and "it took too long".
 */
let lastWorkerError: string | null = null;

/**
 * Minutes a worker survives without being asked to do anything.
 *
 * Long enough that a run of back-to-back onboarding checks reuses one worker,
 * short enough that a café which does this twice a year is not holding WASM
 * memory overnight.
 */
const IDLE_MINUTES = 10;

type TesseractModule = {
  createWorker(
    lang: string,
    oem: number,
    options: Record<string, unknown>
  ): Promise<Worker>;
};

let modulePromise: Promise<TesseractModule> | null = null;

/**
 * Load tesseract.js itself.
 *
 * Dynamic so that the ~10MB of package is not in the server bundle until an ID is
 * actually checked, and so a machine where the OCR never runs never pays for it.
 */
async function loadTesseract(): Promise<TesseractModule> {
  if (!modulePromise) {
    modulePromise = import("tesseract.js").then(
      (m) => ((m as { default?: unknown }).default ?? m) as TesseractModule
    );
  }
  return modulePromise;
}

/**
 * The shared worker, created on first use.
 *
 * Concurrent first calls share one initialisation: `starting` is set before the
 * await, so two verifications arriving together do not race into two workers and
 * leave one of them orphaned holding memory for ten minutes.
 */
async function getWorker(): Promise<Worker> {
  if (typeof window !== "undefined") {
    throw new Error("The OCR engine runs on the server only.");
  }

  if (worker) {
    lastUsedAt = Date.now();
    return worker;
  }

  if (!starting) {
    starting = (async () => {
      await mkdir(CACHE_DIR, { recursive: true });

      const { createWorker } = await loadTesseract();
      const created = await createWorker(LANG, 1, {
        cachePath: CACHE_DIR,
        // English only. A Philippine card mixes English and Filipino, and Filipino
        // is Latin-alphabet with the same letterforms the English model handles —
        // `eng` reads the accents on "Ñ" acceptably, and adding `fil` for it would
        // mean a second 5MB download and traineddata for a script this already
        // handles.
        langPath: "https://tessdata.projectnaptha.com/4.0.0",
        logger: () => {},
        /*
         * Errors are recorded, not discarded.
         *
         * This was `() => {}`, and that is how a `C:\ROOT\node_modules\...` module
         * resolution failure inside the worker thread went unreported: the error
         * arrived here, was thrown away, and the `recognize` promise simply never
         * settled. From the outside that is indistinguishable from an image that
         * is taking a very long time — which is exactly how it was diagnosed as
         * "OCR is slow" for far too long.
         *
         * Kept to the last error rather than logged on every call, so a hot loop
         * cannot flood the console, and kept out of the response body: a tesseract
         * error can carry absolute paths from the server's filesystem.
         */
        errorHandler: (e: unknown) => {
          lastWorkerError = e instanceof Error ? e.message : String(e);
        },
      });

      worker = created;
      lastUsedAt = Date.now();
      lastWorkerError = null;
      return created;
    })().finally(() => {
      // Cleared whether it resolved or threw, so a failed attempt does not
      // permanently poison the provider with a rejected promise.
      starting = null;
    });
  }

  return starting;
}

/**
 * Tear the worker down if it has been idle long enough.
 *
 * Never awaited by callers. The teardown is best-effort and its failure is
 * swallowed on purpose: a worker that will not die cleanly should not be able to
 * fail an ID check that already succeeded.
 */
function reapIfIdle(): void {
  if (!worker) return;

  const idleMs = Date.now() - lastUsedAt;
  if (idleMs < IDLE_MINUTES * 60_000) return;

  const doomed = worker;
  worker = null;
  void doomed.terminate().catch(() => {});
}

/** Tear the worker down immediately. For tests and for a clean shutdown. */
export async function disposeWorker(): Promise<void> {
  const current = worker;
  worker = null;
  starting = null;
  if (!current) return;

  /*
   * Bounded, because `terminate()` on a worker whose thread never started — which
   * is exactly what happens when the worker script itself cannot be resolved —
   * never settles either.
   *
   * Awaiting it unconditionally turned a 25-second timeout into a five-minute
   * hang: the timeout fired correctly, and then the catch block waited forever on
   * teardown while the request sat until the client gave up. The cap is what makes
   * the timeout mean something.
   */
  await Promise.race([
    Promise.resolve(current.terminate()).catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ]);
}

/* ------------------------------------------------------------------- run -- */

export type OcrRun = {
  text: string;
  confidence: number;
  /** Flattened from blocks→paragraphs→lines→words, carrying their boxes. */
  words: OcrWord[];
};

/**
 * Pull the word boxes out of Tesseract's nested output.
 *
 * Two things here are load-bearing and both were established by running it rather
 * than by reading the type definitions (see scripts/_ocr-shape.mjs):
 *
 *   - There is no `data.words`. In v5+ the word list lives four levels down —
 *     `blocks[].paragraphs[].lines[].words[]` — and nothing is populated unless
 *     `{ blocks: true }` is passed to `recognize`. Asking for `data.words` returns
 *     undefined and every extraction silently reads nothing.
 *   - Tesseract's own line grouping is not used, because these cards are two
 *     columns. A PhilSys front puts a name label beside a date label on what is
 *     visually a single band, and Tesseract merges them into one line, at which
 *     point "the text to the right of DATE OF BIRTH" is the applicant's name. The
 *     words are flattened and re-grouped by y-coordinate in ./rows.ts instead.
 */
function flattenWords(blocks: unknown): OcrWord[] {
  const out: OcrWord[] = [];

  if (!Array.isArray(blocks)) return out;

  for (const block of blocks as Array<{ paragraphs?: unknown }>) {
    for (const paragraph of (block?.paragraphs ?? []) as Array<{ lines?: unknown }>) {
      for (const line of (paragraph?.lines ?? []) as Array<{ words?: unknown }>) {
        for (const word of (line?.words ?? []) as RawWord[]) {
          const box = word?.bbox;
          if (!box || typeof word?.text !== "string") continue;

          out.push({
            text: word.text,
            confidence: typeof word.confidence === "number" ? word.confidence : 0,
            x0: box.x0,
            y0: box.y0,
            x1: box.x1,
            y1: box.y1,
          });
        }
      }
    }
  }

  return out;
}

/**
 * Read the text off one image.
 *
 * Throws rather than returning null, because every caller is the provider's
 * `verify()`, and the orchestrator already turns a thrown `IdProviderError` into an
 * `unknown` signal that keeps the rest of the run alive. Failing quietly here
 * instead would produce a review screen that looks complete and is not.
 */
/**
 * How long a single recognition may take before it is abandoned.
 *
 * This is not defensive padding, it is a fix. Tesseract is given an image to
 * chew on with no way to tell it to stop, and on a degenerate input — a 1x1 pixel,
 * which is exactly what the HTTP test suite uploads — it never returns at all. The
 * request then sits until the client gives up, which on undici's default is five
 * minutes. An admin whose browser timed out would simply see "something went
 * wrong", having learned nothing.
 *
 * Real cards take well under a second, so twenty-five seconds is generous by an
 * order of magnitude. Anything still running at that point is not going to
 * produce a reading, and the provider degrades to the face and shape checks.
 */
export const OCR_TIMEOUT_MS = 25_000;

/**
 * Below this, OCR is not attempted at all.
 *
 * An ID card is 85.6mm wide and has to be legible enough to read a name off. A
 * thumbnail cannot be, and handing one to Tesseract is the case above.
 */
export const MIN_OCR_WIDTH = 240;

export async function runOcr(bytes: Uint8Array): Promise<OcrRun> {
  const w = await getWorker();

  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    /*
     * The worker has no cancel of its own, so the timeout is enforced here and the
     * worker is torn down underneath it. `disposeWorker` in the catch does exactly
     * that — the abandoned recognition dies with the process it was running in,
     * rather than occupying the single shared worker and blocking every later
     * request behind it.
     */
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // Surface the worker's own complaint if it made one, because "it hung" and
        // "its worker script is missing" need different fixes and the second is
        // the one that actually happens.
        reject(
          new Error(
            lastWorkerError
              ? `The text reader failed: ${lastWorkerError}`
              : `The text reader did not finish within ${OCR_TIMEOUT_MS / 1000}s.`
          )
        );
      }, OCR_TIMEOUT_MS);
    });

    const { data } = await Promise.race([
      w.recognize(bytes, {}, { blocks: true }),
      timeout,
    ]);
    lastUsedAt = Date.now();

    return {
      text: data.text ?? "",
      confidence: typeof data.confidence === "number" ? data.confidence : 0,
      words: flattenWords(data.blocks),
    };
  } catch (cause) {
    /*
     * Teardown is started but not awaited. The worker has died, hung or been
     * abandoned, and this is the error path — the one place where blocking on
     * `terminate()` used to turn a bounded failure into an unbounded hang.
     * `disposeWorker` caps itself, so this cannot outlive the route by much.
     */
    void disposeWorker();
    throw cause;
  } finally {
    if (timer) clearTimeout(timer);
    reapIfIdle();
  }
}
