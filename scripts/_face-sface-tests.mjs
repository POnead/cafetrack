/**
 * The arithmetic behind the SFace engine, with no model and no browser.
 *
 *   npm run test:sface
 *
 * Three of these assertions exist because the code was wrong first:
 *
 *   - the rotation sign of the similarity transform (every crop came out
 *     upside down, which looks exactly like a broken recognition model);
 *   - the inverse of that transform (every face produced an identical crop,
 *     because the translation was used in the wrong units);
 *   - the two-axis scale when the detection frame is square and the source is
 *     not (landmarks marched up the frame the further they were from the origin).
 *
 * None of them are subtle once they are named, and all of them are invisible in
 * a screenshot of a face.
 */
import {
  ARCFACE_REFERENCE,
  SFACE_INPUT,
  SFACE_MATCH_THRESHOLD,
  YUNET_INPUT,
  YUNET_SCORE_THRESHOLD,
  alignCrop,
  decodeYunet,
  headTurnSignal5,
  isSfaceMatch,
  normalizeSfaceEmbedding,
  nonMaximumSuppression,
  similarityTransform,
} from "../src/lib/face-sface.ts";
import {
  DEFAULT_MATCH_THRESHOLD,
  MAX_SFACE_MATCH_THRESHOLD,
  MIN_SFACE_MATCH_THRESHOLD,
  matchThresholdBand,
  parseEmbedding,
} from "../src/lib/face.ts";

let pass = 0;
let fail = 0;

function check(label, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`  PASS  ${label}${detail ? "  " + detail : ""}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? "  " + detail : ""}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

function atCosine(unit, distance) {
  const index = unit.reduce(
    (best, value, i, values) => Math.abs(value) < Math.abs(values[best]) ? i : best,
    0
  );
  const basis = unit.map((value, i) => (i === index ? 1 : 0) - unit[index] * value);
  const norm = Math.hypot(...basis);
  const orthogonal = basis.map((value) => value / norm);
  const cosine = 1 - distance;
  const sine = Math.sqrt(1 - cosine * cosine);
  return unit.map((value, i) => cosine * value + sine * orthogonal[i]);
}

/** Apply a transform the way the browser code does: forward, y' = b*x + a*y + ty. */
function apply(t, p) {
  return {
    x: t.a * p.x - t.b * p.y + t.tx,
    y: t.b * p.x + t.a * p.y + t.ty,
  };
}

/* ----------------------------------------------------- similarity transform -- */

section("similarityTransform — recovers a known scale and rotation");

const SQUARE = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 100 },
  { x: 0, y: 100 },
  { x: 50, y: 50 },
];

// Rotate by 30 degrees, scale by 2, then shift.
const THETA = Math.PI / 6;
const KNOWN = {
  a: 2 * Math.cos(THETA),
  b: 2 * Math.sin(THETA),
  tx: 17,
  ty: -9,
};
const ROTATED = SQUARE.map((p) => apply(KNOWN, p));

const recovered = similarityTransform(SQUARE, ROTATED);
check(
  "the rotation comes back with the right sign",
  Math.abs(recovered.a - KNOWN.a) < 1e-9 && Math.abs(recovered.b - KNOWN.b) < 1e-9,
  `a=${recovered.a.toFixed(4)} b=${recovered.b.toFixed(4)} expected a=${KNOWN.a.toFixed(4)} b=${KNOWN.b.toFixed(4)}`
);
check(
  "every point maps back onto its target",
  SQUARE.every((p, i) => {
    const mapped = apply(recovered, p);
    return Math.abs(mapped.x - ROTATED[i].x) < 1e-6 && Math.abs(mapped.y - ROTATED[i].y) < 1e-6;
  })
);

const mirrored = SQUARE.map((p) => ({ x: -p.x, y: p.y }));
const mirroredFit = similarityTransform(SQUARE, mirrored);
const mirroredResidual = Math.max(
  ...SQUARE.map((p, i) => {
    const mapped = apply(mirroredFit, p);
    return Math.hypot(mapped.x - mirrored[i].x, mapped.y - mirrored[i].y);
  })
);
check(
  "a mirror is fitted as a rotation with a large residual, not exactly",
  mirroredResidual > 5,
  `worst residual ${mirroredResidual.toFixed(1)}px — the caller must sanity-check the fit`
);

const identity = similarityTransform(SQUARE, SQUARE);
check(
  "identical point sets give the identity",
  Math.abs(identity.a - 1) < 1e-9 &&
    Math.abs(identity.b) < 1e-9 &&
    Math.abs(identity.tx) < 1e-9 &&
    Math.abs(identity.ty) < 1e-9
);

check(
  "five coincident points do not divide by zero",
  JSON.stringify(similarityTransform(SQUARE.map(() => ({ x: 3, y: 4 })), ARCFACE_REFERENCE)) ===
    JSON.stringify({ a: 1, b: 0, tx: 0, ty: 0 })
);

section("similarityTransform — the shape it is actually used on");

// A face 100px wide needs about 112/100 of scale to fill the crop.
const facePoints = [
  { x: 40, y: 50 },
  { x: 90, y: 49 },
  { x: 66, y: 72 },
  { x: 48, y: 92 },
  { x: 84, y: 91 },
];
/*
 * An exact similarity of the reference — the canonical layout scaled, rotated and
 * moved. The fit must recover it to floating-point precision; if it cannot, the
 * estimator is wrong rather than the input being awkward.
 */
const exScale = 2;
const exTheta = (10 * Math.PI) / 180;
const exact = ARCFACE_REFERENCE.map((p) => ({
  x: exScale * (Math.cos(exTheta) * p.x - Math.sin(exTheta) * p.y) + 300,
  y: exScale * (Math.sin(exTheta) * p.x + Math.cos(exTheta) * p.y) + 120,
}));
const exactFit = similarityTransform(exact, ARCFACE_REFERENCE);
const exactResidual = Math.max(
  ...exact.map((p, i) => {
    const mapped = apply(exactFit, p);
    return Math.hypot(mapped.x - ARCFACE_REFERENCE[i].x, mapped.y - ARCFACE_REFERENCE[i].y);
  })
);
check(
  "an exact similarity is recovered to the last digit",
  exactResidual < 1e-6,
  `worst residual ${exactResidual.toExponential(1)}px`
);
check(
  "including its scale",
  Math.abs(Math.hypot(exactFit.a, exactFit.b) - 0.5) < 1e-9,
  `scale ${Math.hypot(exactFit.a, exactFit.b).toFixed(4)} (expected 0.5)`
);
check(
  "and its rotation, opposite to the one applied to the source",
  Math.abs((Math.atan2(exactFit.b, exactFit.a) * 180) / Math.PI + 10) < 1e-6,
  `${((Math.atan2(exactFit.b, exactFit.a) * 180) / Math.PI).toFixed(3)} degrees`
);

// Five real landmarks are not exactly similar to the reference — two people are
// not the same shape — so a small residual is the correct outcome, and a large
// one means the fit is nonsense.
const fit = similarityTransform(facePoints, ARCFACE_REFERENCE);
const fitResidual = Math.max(
  ...facePoints.map((p, i) => {
    const mapped = apply(fit, p);
    return Math.hypot(mapped.x - ARCFACE_REFERENCE[i].x, mapped.y - ARCFACE_REFERENCE[i].y);
  })
);
check(
  "a real face fits closely but not exactly",
  fitResidual > 0.1 && fitResidual < 8,
  `worst residual ${fitResidual.toFixed(1)}px`
);
check(
  "the fit has a real, positive scale",
  Math.hypot(fit.a, fit.b) > 0 && Number.isFinite(fit.a) && Number.isFinite(fit.b),
  `scale ${Math.hypot(fit.a, fit.b).toFixed(3)}`
);
check(
  "and left roughly upright",
  Math.abs((Math.atan2(fit.b, fit.a) * 180) / Math.PI) < 15,
  `${((Math.atan2(fit.b, fit.a) * 180) / Math.PI).toFixed(1)} degrees`
);

/* ---------------------------------------------------------------- alignCrop -- */

section("alignCrop — the inverse mapping");

/** A 64x64 image whose red channel is its x coordinate. */
function gradientImage(size) {
  const rgb = new Uint8Array(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 3;
      rgb[i] = x;
      rgb[i + 1] = y;
      rgb[i + 2] = 0;
    }
  }
  return rgb;
}

const gradient = gradientImage(128);

// A 1:1 transform shifted right: the crop should be the right part, x rising.
const shifted = { a: 1, b: 0, tx: -16, ty: 0 };
const cropA = alignCrop(gradient, 128, 128, shifted, SFACE_INPUT);

check(
  "an unchanged scale samples the region it was pointed at",
  cropA[0] === 16 && cropA[(SFACE_INPUT - 1) * 3] === 16 + SFACE_INPUT - 1,
  `first ${cropA[0]}, last ${cropA[(SFACE_INPUT - 1) * 3]}`
);

// The bug: two transforms with different translations produced the same crop.
const cropB = alignCrop(gradient, 128, 128, { a: 1, b: 0, tx: 0, ty: 0 }, SFACE_INPUT);
check(
  "different translations give different crops",
  cropA[0] !== cropB[0],
  `${cropA[0]} vs ${cropB[0]}`
);

// Scaling by 2 should halve the span of x values seen across the crop.
const cropC = alignCrop(gradient, 128, 128, { a: 2, b: 0, tx: 0, ty: 0 }, SFACE_INPUT);
check(
  "scaling shrinks the portion of the image sampled",
  cropC[(SFACE_INPUT - 1) * 3] - cropC[0] < cropB[(SFACE_INPUT - 1) * 3] - cropB[0],
  `span ${cropC[(SFACE_INPUT - 1) * 3] - cropC[0]} vs ${cropB[(SFACE_INPUT - 1) * 3] - cropB[0]}`
);

check(
  "a degenerate transform produces black rather than NaN",
  alignCrop(gradient, 128, 128, { a: 0, b: 0, tx: 0, ty: 0 }, 4).every((v) => v === 0)
);

/* --------------------------------------------------------------- decodeYunet -- */

section("decodeYunet — synthetic heads");

/** Build the four tensors for one stride with a single detection in one cell. */
function heads({ cols = 8, stride = 8, cell = 0, score = 0.9, box = [0, 0, 0, 0] } = {}) {
  const n = cols * cols;
  const cls = new Float32Array(n);
  const obj = new Float32Array(n);
  const bbox = new Float32Array(n * 4);
  const kps = new Float32Array(n * 10);

  cls[cell] = score * score;
  obj[cell] = 1;
  bbox.set(box, cell * 4);
  for (let k = 0; k < 5; k++) {
    kps[cell * 10 + k * 2] = 0.5 + k * 0.01;
    kps[cell * 10 + k * 2 + 1] = 0.5;
  }

  return {
    [`cls_${stride}`]: { data: cls, dims: [1, n, 1] },
    [`obj_${stride}`]: { data: obj, dims: [1, n, 1] },
    [`bbox_${stride}`]: { data: bbox, dims: [1, n, 4] },
    [`kps_${stride}`]: { data: kps, dims: [1, n, 10] },
  };
}

const square = decodeYunet(heads({ cols: 8, stride: 8, cell: 0 }), 64);
check("one detection is decoded", square.length === 1, `${square.length}`);
check(
  "its box is the anchor's cell",
  square[0].x1 === -4 && square[0].y1 === -4 && square[0].x2 === 4 && square[0].y2 === 4,
  `(${square[0].x1},${square[0].y1})-(${square[0].x2},${square[0].y2})`
);
check(
  "its landmarks sit at the cell centre",
  Math.abs(square[0].points[0].x - 4) < 1e-6 && Math.abs(square[0].points[0].y - 4) < 1e-6,
  `${square[0].points[0].x},${square[0].points[0].y}`
);
check("it keeps five landmarks", square[0].points.length === 5);

const cellAt = decodeYunet(heads({ cols: 8, stride: 8, cell: 9 }), 64);
check(
  "a detection in another cell lands in that cell",
  cellAt[0].x1 === 4 && cellAt[0].y1 === 4,
  `(${cellAt[0].x1},${cellAt[0].y1})`
);

const weak = decodeYunet(heads({ cols: 8, stride: 8, cell: 0, score: YUNET_SCORE_THRESHOLD - 0.05 }), 64);
check("a weak detection is dropped", weak.length === 0);

const expanded = decodeYunet(heads({ cols: 8, stride: 8, cell: 0, box: [0, 0, Math.log(2), Math.log(2)] }), 64);
check(
  "the size channels are exponential",
  Math.abs(expanded[0].x2 - expanded[0].x1 - 16) < 1e-4,
  `${expanded[0].x2 - expanded[0].x1}`
);

check("a missing stride is skipped rather than thrown on", decodeYunet({}, 64).length === 0);

/* --------------------------------------------------------------------- nms -- */

section("nonMaximumSuppression");

const box = (x1, y1, x2, y2, score) => ({ x1, y1, x2, y2, score, points: [] });

const overlapping = nonMaximumSuppression([box(0, 0, 10, 10, 0.9), box(1, 1, 11, 11, 0.8)]);
check("two boxes over the same face keep one", overlapping.length === 1);
check("and it is the higher scoring one", overlapping[0].score === 0.9);

const apart = nonMaximumSuppression([box(0, 0, 10, 10, 0.9), box(50, 50, 60, 60, 0.8)]);
check("two separate faces keep both", apart.length === 2);

const touching = nonMaximumSuppression([box(0, 0, 10, 10, 0.9), box(9, 0, 19, 10, 0.8)]);
check("a small overlap is not a duplicate", touching.length === 2);

/* ---------------------------------------------------------- headTurnSignal5 -- */

section("headTurnSignal5 — the five-point proxy");

const frontal = [
  { x: 40, y: 40 },
  { x: 80, y: 40 },
  { x: 60, y: 60 },
  { x: 45, y: 80 },
  { x: 75, y: 80 },
];
check("a symmetric face reads as no turn", Math.abs(headTurnSignal5(frontal)) < 1e-12);

const turned = frontal.map((p, i) => (i === 2 ? { x: 70, y: 60 } : p));
check(
  "a nose towards the person's left eye is a positive turn",
  headTurnSignal5(turned) > 0,
  String(headTurnSignal5(turned))
);
check(
  "and the mirror is negative",
  headTurnSignal5(frontal.map((p, i) => (i === 2 ? { x: 50, y: 60 } : p))) < 0
);

check("too few points is not a pose", headTurnSignal5(frontal.slice(0, 2)) === null);
check("no points is not a pose", headTurnSignal5(null) === null);

/* -------------------------------------------------------------- thresholds -- */

section("the threshold belongs to the model, not to the app");

const unit = (seed) => {
  const v = new Float32Array(128);
  let state = seed >>> 0;
  let norm = 0;
  for (let i = 0; i < 128; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    v[i] = ((state >>> 0) / 0xffffffff) * 2 - 1;
    norm += v[i] * v[i];
  }
  for (let i = 0; i < 128; i++) v[i] /= Math.sqrt(norm);
  return v;
};

const a = unit(7);
const b = unit(8);
check("an embedding matches itself", isSfaceMatch(a, a));
check("two unrelated embeddings do not", !isSfaceMatch(a, b));
check("the closest observed impostor distance is refused", !isSfaceMatch(a, atCosine(a, 0.14)));

section("normalizeSfaceEmbedding — output accepted by the shared parser");

const rawSface = new Array(128).fill(0.25);
const normalizedSface = normalizeSfaceEmbedding(rawSface);
check("normalizes model output to unit length", normalizedSface !== null &&
  Math.abs(Math.hypot(...normalizedSface) - 1) < 1e-12);
check("normalized output passes the shared embedding parser", parseEmbedding(normalizedSface) !== null);
check("wrong-sized model output is refused", normalizeSfaceEmbedding([1, 2]) === null);
check("a zero model output is refused", normalizeSfaceEmbedding(new Array(128).fill(0)) === null);

// The documented danger of a model swap: each engine keeps its own strict band.
check(
  "the SFace ceiling is stricter than its previous unmeasured threshold",
  SFACE_MATCH_THRESHOLD === 0.1 && SFACE_MATCH_THRESHOLD < 0.637
);
check(
  "the legacy and SFace thresholds remain engine-specific",
  DEFAULT_MATCH_THRESHOLD === 0.033 && DEFAULT_MATCH_THRESHOLD < SFACE_MATCH_THRESHOLD
);
check(
  "runtime and settings API share the security-first SFace range",
  matchThresholdBand("sface").min === MIN_SFACE_MATCH_THRESHOLD &&
    matchThresholdBand("sface").max === MAX_SFACE_MATCH_THRESHOLD &&
    matchThresholdBand("sface").fallback === SFACE_MATCH_THRESHOLD
);

console.log(`\n${"-".repeat(46)}`);
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
