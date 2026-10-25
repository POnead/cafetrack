/**
 * Copies the face model weights into public/models/, where the browser can load
 * them.
 *
 *   npm run setup:face
 *
 * Why a script rather than committing the weights
 * ----------------------------------------------
 * The three models are ~7MB of binary. They arrive inside the @vladmandic/face-api
 * package, which is already a dependency, so copying them out is free — whereas
 * checking 7MB of binaries into git is permanent and slows every clone forever.
 *
 * The trade is that a fresh clone needs this one command before the feature runs.
 * That is stated in the README and in the setup check below, and the failure it
 * causes is not silent: the pages that need the models report "model files are
 * missing" rather than showing a camera that does nothing.
 *
 * Only these three are copied. The package ships several more (face_landmark_68_tiny,
 * face_expression, age_gender, and a dozen descriptors); none of them are used, and
 * copying them would roughly double what the browser can be asked to download.
 *
 * Detection -> landmarks -> recognition. The first two align the face so the third
 * produces a comparable vector; dropping any of them makes matching unreliable
 * rather than slightly worse.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "..", "node_modules", "@vladmandic", "face-api", "model");
const DEST = join(here, "..", "public", "models");

/** Base names, each of which ships as a manifest .json plus a .bin of weights. */
const WANTED = [
  "tiny_face_detector_model",
  "face_landmark_68_model",
  "face_recognition_model",
];

if (!existsSync(SRC)) {
  console.error(
    "The face-api models are not installed.\n" +
      "Run:  npm install @vladmandic/face-api\n" +
      "and then this script again."
  );
  process.exit(1);
}

mkdirSync(DEST, { recursive: true });

let copied = 0;
let bytes = 0;
const missing = [];

for (const base of WANTED) {
  for (const ext of ["-weights_manifest.json", ".bin"]) {
    const file = `${base}${ext}`;
    const from = join(SRC, file);
    if (!existsSync(from)) {
      missing.push(file);
      continue;
    }
    copyFileSync(from, join(DEST, file));
    copied++;
    bytes += statSync(from).size;
  }
}

if (missing.length) {
  console.error(`Missing from the package: ${missing.join(", ")}`);
  process.exit(1);
}

console.log(`Copied ${copied} files into public/models/ (${(bytes / 1024 / 1024).toFixed(1)} MB)\n`);
for (const f of readdirSync(DEST).sort()) {
  console.log(`   ${f}`);
}
console.log(
  "\nThe browser loads these from /models/. The proxy in src/proxy.ts must not\n" +
  "intercept that path, or the weights are answered with the sign-in page."
);
