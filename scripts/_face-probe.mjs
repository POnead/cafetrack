/**
 * Measure the face pipeline on real photographs.
 *
 *   npm run probe:face
 *
 * Reads every image under `face-probe-images/`, runs both engines on it in a real
 * browser through `/dev/face-probe`, and prints the numbers the thresholds are
 * supposed to be set from.
 *
 * ## Why this exists
 *
 * The previous SFace threshold came from OpenCV's generic documentation, not
 * representative captures, and the legacy value was deliberately loosened past
 * a measured impostor pair. Neither provides a security guarantee. This probe
 * reports genuine and impostor distributions so a threshold change can be
 * evaluated against representative captures; being wrong means refusing real
 * staff or admitting a stranger.
 *
 * So this prints the two distributions and the gap between them, and suggests a
 * number inside the gap. It does not set anything automatically — a measurement
 * on eight photographs is evidence, not a decision.
 *
 * ## The folder
 *
 *     face-probe-images/
 *       ana/
 *         front.jpg
 *         left.jpg
 *         right.jpg
 *         window-light.jpg
 *       ben/
 *         phone.jpg
 *
 * One directory per person; the directory name is only a label. Vary the light,
 * the distance and the angle inside each person — a set of five identical studio
 * portraits will produce a beautiful separation that says nothing about a cafe.
 * At least three people, ideally eight or more, and at least two photographs of
 * each: the whole point is the *worst* genuine pair against the *closest*
 * impostor pair.
 *
 * The folder is git-ignored. Real faces should not be committed.
 *
 * ## Why a browser
 *
 * Both engines are onnxruntime-web / tfjs and need a canvas. Running them in Node
 * would mean reimplementing the exact code under test, which is how the previous
 * tests managed to pass while the reader was embedding the room.
 */
import { chromium } from "playwright-core";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { cosineDistance } from "../src/lib/face.ts";

const BASE = process.env.BASE_URL || "http://localhost:3100";
const IMAGE_DIR = process.env.FACE_PROBE_IMAGES || "face-probe-images";
const OUT_DIR = path.join(".cache", "face-probe");

const IMAGE_TYPES = new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp"]);

/* ------------------------------------------------------------- helpers ---- */

function line(title) {
  console.log(`\n== ${title} ==`);
}

function pad(value, width) {
  return String(value).padEnd(width);
}

function fixed(value, places = 1) {
  return Number.isFinite(value) ? value.toFixed(places) : "—";
}

/**
 * Group the images by person directory.
 *
 * A file at the top level is an error rather than a person of its own: a loose
 * photograph cannot be compared with anything, and quietly treating it as one
 * person would produce a "measurement" with no genuine pairs at all.
 */
function collectImages() {
  if (!statSync(IMAGE_DIR, { throwIfNoEntry: false })?.isDirectory()) {
    return { people: new Map(), stray: [], count: 0 };
  }

  const people = new Map();
  const stray = [];
  let count = 0;

  for (const entry of readdirSync(IMAGE_DIR, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const dir = path.join(IMAGE_DIR, entry.name);
      const files = readdirSync(dir)
        .filter((f) => IMAGE_TYPES.has(path.extname(f).toLowerCase()))
        .sort();
      if (files.length > 0) {
        people.set(entry.name, files.map((f) => path.join(dir, f)));
        count += files.length;
      }
    } else if (IMAGE_TYPES.has(path.extname(entry.name).toLowerCase())) {
      stray.push(entry.name);
    }
  }

  return { people, stray, count };
}

/** All unordered pairs of an array, as index pairs. */
function pairs(n) {
  const out = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) out.push([i, j]);
  return out;
}

function summarise(distances) {
  if (distances.length === 0) return null;
  const sorted = [...distances].sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  return { min: sorted[0], max: sorted[sorted.length - 1], mean, count: sorted.length };
}

/* ---------------------------------------------------------------- main ---- */

const { people, stray, count } = collectImages();

if (count === 0) {
  console.error(`\nNo photographs found under ${path.resolve(IMAGE_DIR)}.`);
  console.error(`
Put one folder per person, with two or more photographs of each:

  ${IMAGE_DIR}/
    ana/
      front.jpg
      left.jpg
      right.jpg
    ben/
      phone.jpg
      window.jpg

Vary light, distance and angle within each person. The folder is git-ignored.
Then run this again with the dev server up:  npm run dev
`);
  process.exit(2);
}

if (stray.length > 0) {
  console.error(
    `\nIgnoring ${stray.length} photograph(s) at the top of ${IMAGE_DIR}: ` +
      `everything must sit in a person's folder so genuine pairs can be formed.`
  );
}

const withPairs = [...people.entries()].filter(([, files]) => files.length >= 2);
const singles = [...people.entries()].filter(([, files]) => files.length < 2);

if (withPairs.length < 2) {
  console.error(
    `\nNeed at least two people with two or more photographs each to measure a ` +
      `threshold; found ${withPairs.length}.`
  );
  process.exit(2);
}

mkdirSync(OUT_DIR, { recursive: true });

// Fail early and clearly if the dev server is not up, rather than letting
// Playwright time out with "net::ERR_CONNECTION_REFUSED" 40 lines later.
try {
  const ping = await fetch(`${BASE}/dev/face-probe`);
  if (!ping.ok) throw new Error(`HTTP ${ping.status}`);
} catch (e) {
  console.error(
    `\nCannot reach ${BASE}/dev/face-probe (${e.message}).\n` +
      `Start the dev server first:  npm run dev\n`
  );
  process.exit(2);
}

const browser = await chromium.launch({ channel: "chrome", headless: true });

try {
  const page = await browser.newPage();
  // The first call downloads and compiles ~20MB of models in a wasm backend.
  page.setDefaultTimeout(300_000);

  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const text = m.text();
    // ONNX prints one warning per initializer in the int8 model as it loads —
    // dozens of lines that say nothing about this run and bury a real error.
    if (/DevTools|Download the React|onnxruntime|Initializer /i.test(text)) return;
    console.error(`  [browser] ${text}`);
  });

  await page.goto(`${BASE}/dev/face-probe`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__faceProbeReady === true);

  line(`reading ${count} photograph(s) from ${withPairs.length} people`);
  console.log("The first read loads both model sets, so it is slow. The rest are not.");

  const rows = [];

  for (const [person, files] of people) {
    for (const file of files) {
      const bytes = readFileSync(file);
      const ext = path.extname(file).toLowerCase();
      const mime =
        ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : ext === ".bmp" ? "image/bmp" : "image/jpeg";
      const dataUrl = `data:${mime};base64,${bytes.toString("base64")}`;

      process.stdout.write(`  ${pad(person, 16)} ${pad(path.basename(file), 24)}`);
      const started = Date.now();

      let result;
      try {
        result = await page.evaluate((url) => window.__faceProbe(url), dataUrl);
      } catch (e) {
        console.log(`FAILED  ${e.message}`);
        rows.push({ person, file, failed: String(e) });
        continue;
      }

      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      const pose = result.sface.ok ? result.sface.headPose : null;
      const tag = result.sface.ok
        ? `${fixed(pose?.yaw)}° yaw  ${result.sface.pose ?? "between"}  ${seconds}s`
        : `sface: ${result.sface.reason}`;
      console.log(tag);

      rows.push({ person, file, seconds: Number(seconds), ...result });
    }
  }

  /* ------------------------------------------------------ pose summary ---- */

  line("head pose, as measured");

  const posed = rows.filter((r) => r.sface?.ok && r.sface.headPose);
  if (posed.length === 0) {
    console.log("No pose could be measured — no face was detected in any photograph.");
  } else {
    console.log(
      `${pad("person", 16)}${pad("file", 24)}${pad("yaw", 9)}${pad("pitch", 9)}${pad("roll", 9)}` +
        `${pad("residual", 10)}pose`
    );
    for (const r of posed) {
      const p = r.sface.headPose;
      console.log(
        `${pad(r.person, 16)}${pad(path.basename(r.file), 24)}` +
          `${pad(fixed(p.yaw) + "°", 9)}${pad(fixed(p.pitch) + "°", 9)}${pad(fixed(p.roll) + "°", 9)}` +
          `${pad(fixed(p.residual, 2) + "px", 10)}${r.sface.pose ?? "between"}`
      );
    }
    /*
     * The residual is the honest quality signal here. A fit that cannot explain
     * the landmarks is a fit whose angle means nothing, and a large residual on a
     * photograph that clearly shows a face is evidence the 3D model does not suit
     * that face — which is exactly what these photographs are for.
     */
    const residuals = posed.map((r) => r.sface.headPose.residual).sort((a, b) => a - b);
    console.log(
      `\nreprojection residual: median ${fixed(residuals[Math.floor(residuals.length / 2)], 2)}px, ` +
        `worst ${fixed(residuals[residuals.length - 1], 2)}px`
    );
  }

  /* -------------------------------------------------- distance matrix ---- */

  for (const engine of ["sface", "legacy"]) {
    line(`${engine} — same person vs different people`);

    const usable = rows.filter((r) => r[engine]?.ok && Array.isArray(r[engine].embedding) && r[engine].embedding.length > 0);
    const skipped = rows.length - usable.length;
    if (skipped > 0) {
      const reasons = rows
        .filter((r) => !(r[engine]?.ok && r[engine].embedding?.length > 0))
        .map((r) => `${path.basename(r.file)}: ${r[engine]?.reason ?? "failed"}`);
      console.log(`${skipped} photograph(s) not usable by this engine — ${reasons.join(", ")}`);
    }

    if (usable.length < 4) {
      console.log("Not enough usable photographs to measure this engine.");
      continue;
    }

    const same = [];
    const different = [];

    for (const [i, j] of pairs(usable.length)) {
      const a = usable[i];
      const b = usable[j];
      const d = cosineDistance(a[engine].embedding, b[engine].embedding);
      if (!Number.isFinite(d)) continue;
      if (a.person === b.person) same.push({ d, a, b });
      else different.push({ d, a, b });
    }

    const sameStats = summarise(same.map((x) => x.d));
    const diffStats = summarise(different.map((x) => x.d));

    if (!sameStats || !diffStats) {
      console.log("Need at least one genuine pair and one impostor pair; try more photographs.");
      continue;
    }

    console.log(
      `same person      n=${sameStats.count}   min ${fixed(sameStats.min, 4)}   ` +
        `mean ${fixed(sameStats.mean, 4)}   max ${fixed(sameStats.max, 4)}`
    );
    console.log(
      `different people n=${diffStats.count}   min ${fixed(diffStats.min, 4)}   ` +
        `mean ${fixed(diffStats.mean, 4)}   max ${fixed(diffStats.max, 4)}`
    );

    const gap = diffStats.min - sameStats.max;
    console.log(
      `\nseparation: ${fixed(gap, 4)}  ` +
        `(worst genuine ${fixed(sameStats.max, 4)} → closest impostor ${fixed(diffStats.min, 4)})`
    );

    if (gap <= 0) {
      console.log(
        "OVERLAP. At least one pair of different people is closer than a pair of the\n" +
          "same person. No threshold can separate them; the engine is not the problem —\n" +
          "check that the photographs are actually of different people, and that each\n" +
          "person's folder really holds one person."
      );
    } else {
      // One third of the way up from the worst genuine pair: closer to the
      // genuine side than the middle, because refusing a real member of staff is
      // the worse failure at a till with a queue.
      const suggested = sameStats.max + gap / 3;
      console.log(
        `\nsuggested threshold: ${fixed(suggested, 3)}  ` +
          `(worst genuine + one third of the gap)`
      );
      console.log(`  strict (midpoint):  ${fixed((sameStats.max + diffStats.min) / 2, 3)}`);
      console.log(`  loose (near impostor): ${fixed(sameStats.min > 0 ? diffStats.min - gap / 3 : diffStats.min, 3)}`);
    }

    const worstSame = same.sort((x, y) => y.d - x.d).slice(0, 5);
    const closestDiff = different.sort((x, y) => x.d - y.d).slice(0, 5);
    console.log("\nworst genuine pairs");
    for (const x of worstSame) {
      console.log(`  ${fixed(x.d, 4)}  ${path.basename(x.a.file)} ↔ ${path.basename(x.b.file)}`);
    }
    console.log("closest impostor pairs");
    for (const x of closestDiff) {
      console.log(`  ${fixed(x.d, 4)}  ${x.a.person}/${path.basename(x.a.file)} ↔ ${x.b.person}/${path.basename(x.b.file)}`);
    }
  }

  /* -------------------------------------------------------------- save ---- */

  const summary = rows.map((r) => ({
    person: r.person,
    file: r.file,
    seconds: r.seconds,
    sface: r.sface?.ok
      ? {
          ok: true,
          headPose: r.sface.headPose,
          pose: r.sface.pose,
          score: r.sface.score,
          brightness: r.sface.brightness,
          box: r.sface.box,
          points: r.sface.points,
          embedding: r.sface.embedding,
        }
      : r.sface,
    legacy: r.legacy?.ok
      ? {
          ok: true,
          headPose: r.legacy.headPose,
          pose: r.legacy.pose,
          score: r.legacy.score,
          box: r.legacy.box,
          detector: r.legacy.detector,
          embedding: r.legacy.embedding,
        }
      : r.legacy,
  }));

  const jsonPath = path.join(OUT_DIR, "results.json");
  writeFileSync(jsonPath, JSON.stringify({ base: BASE, takenAt: new Date().toISOString(), rows: summary }, null, 2));

  // The annotated frames, so "it found the right face" can be checked by eye.
  let saved = 0;
  for (const r of rows) {
    if (!r.annotated) continue;
    const name = `${r.person}__${path.basename(r.file).replace(/\.[^.]+$/, "")}.jpg`;
    const data = r.annotated.split(",")[1];
    if (!data) continue;
    writeFileSync(path.join(OUT_DIR, name), Buffer.from(data, "base64"));
    saved++;
  }

  line("saved");
  console.log(`${jsonPath}  (${summary.length} readings)`);
  if (saved > 0) console.log(`${path.join(OUT_DIR, "*.jpg")}  (${saved} annotated frames)`);
  if (singles.length > 0) {
    console.log(
      `\nNote: ${singles.map(([p]) => p).join(", ")} had only one photograph and ` +
        `contributed no genuine pairs.`
    );
  }
} finally {
  await browser.close();
}
