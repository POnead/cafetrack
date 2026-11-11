import { strict as assert } from "node:assert";
import {
  activeProviders,
  runIdVerification,
} from "../src/lib/id-verification/index.ts";
import {
  ocrSpaceProvider,
  ocrSpaceConfigured,
  parseOcrSpaceResponse,
} from "../src/lib/id-verification/ocr-space.ts";
import { IdProviderError } from "../src/lib/id-verification/types.ts";
import { nameSignal } from "../src/lib/id-verification/name-signal.ts";
import { detectCardType } from "../src/lib/id-verification/ocr/card-type.ts";
import { idNumberSignal } from "../src/lib/id-verification/specification.ts";

function word(WordText, Left, Top, Width = WordText.length * 9, Height = 14) {
  return { WordText, Left, Top, Width, Height, WordConfidence: 96 };
}

function line(text, y) {
  const words = text.split(" ");
  let left = 10;
  const boxes = words.map((token) => {
    const result = word(token, left, y);
    left += result.Width + 6;
    return result;
  });
  return { LineText: text, Words: boxes };
}

const philsysPayload = {
  OCRExitCode: 1,
  ParsedResults: [
    {
      ParsedText:
        "REPUBLIC OF THE PHILIPPINES\nPHILIPPINE IDENTIFICATION SYSTEM\n1234-5678-9012-3456\nLAST NAME DELA CRUZ\nFIRST NAME JUAN\nMIDDLE NAME SANTOS",
      TextOverlay: {
        Lines: [
          line("REPUBLIC OF THE PHILIPPINES", 10),
          line("PHILIPPINE IDENTIFICATION SYSTEM", 34),
          line("1234-5678-9012-3456", 58),
          line("LAST NAME DELA CRUZ", 80),
          line("FIRST NAME JUAN", 120),
          line("MIDDLE NAME SANTOS", 160),
        ],
      },
    },
  ],
};

const passportPayload = {
  OCRExitCode: 1,
  ParsedResults: [
    {
      ParsedText: "PASSPORT",
      TextOverlay: { Lines: [line("PASSPORT", 10)] },
    },
  ],
};
const invalidNumberPayload = {
  OCRExitCode: 1,
  ParsedResults: [
    {
      ParsedText:
        "REPUBLIC OF THE PHILIPPINES\nPHILIPPINE IDENTIFICATION SYSTEM\n1234-5678-90",
      TextOverlay: {
        Lines: [
          line("REPUBLIC OF THE PHILIPPINES", 10),
          line("PHILIPPINE IDENTIFICATION SYSTEM", 34),
          line("1234-5678-90", 58),
        ],
      },
    },
  ],
};

assert.equal(parseOcrSpaceResponse(philsysPayload).words.length, 18);
assert.equal(detectCardType("PASSPORT").confidence, "high");

const previousFetch = globalThis.fetch;
const previousApiKey = process.env.OCR_SPACE_API_KEY;
const previousHypervergeAppId = process.env.HYPERVERGE_APP_ID;
const previousHypervergeAppKey = process.env.HYPERVERGE_APP_KEY;
process.env.OCR_SPACE_API_KEY = "test-key";
delete process.env.HYPERVERGE_APP_ID;
delete process.env.HYPERVERGE_APP_KEY;
let requestHeaders;
let requestForm;
let currentPayload = philsysPayload;
globalThis.fetch = async (url, init) => {
  assert.equal(url, "https://api.ocr.space/parse/image");
  requestHeaders = init.headers;
  requestForm = init.body;
  return Response.json(currentPayload);
};

try {
  const matchingResult = await ocrSpaceProvider.verify({
    front: { bytes: new Uint8Array([1, 2, 3]), type: "image/jpeg" },
    docType: "philsys",
    expectedName: "Juan Santos Dela Cruz",
  });

  assert.equal(requestHeaders.apikey, "test-key");
  assert.equal(requestForm.get("isOverlayRequired"), "true");
  assert.equal(requestForm.get("OCREngine"), "2");
  assert.equal(matchingResult.detectedDocType, "philsys");
  assert.equal(
    matchingResult.signals.find((signal) => signal.id === "ocr_space_doc_type")?.tone,
    "pass"
  );
  assert.ok(matchingResult.signals.some((signal) => signal.id === "ocr_space_id_number"));
  assert.equal(matchingResult.fields.full_name, "DELA CRUZ, JUAN SANTOS");
  assert.equal(matchingResult.fields.id_number, "1234-5678-9012-3456");
  assert.equal(
    nameSignal(matchingResult.fields.full_name, "Juan Santos Dela Cruz").tone,
    "pass"
  );
  assert.ok(
    !matchingResult.signals.some((signal) => signal.id.endsWith("date_of_expiry")),
    "PhilSys has no expiry status signal"
  );

  currentPayload = invalidNumberPayload;
  const invalidNumberResult = await ocrSpaceProvider.verify({
    front: { bytes: new Uint8Array([1, 2, 3]), type: "image/jpeg" },
    docType: "philsys",
    expectedName: "Juan Santos Dela Cruz",
  });
  assert.equal(invalidNumberResult.fields.id_number, "1234-5678-90");
  assert.equal(
    idNumberSignal(invalidNumberResult.fields.id_number, "philsys")?.tone,
    "warn"
  );

  currentPayload = passportPayload;
  const mismatchedResult = await ocrSpaceProvider.verify({
    front: { bytes: new Uint8Array([1, 2, 3]), type: "image/jpeg" },
    docType: "philsys",
    expectedName: "Juan Santos Dela Cruz",
  });
  assert.equal(mismatchedResult.detectedDocType, "passport");
  assert.equal(
    mismatchedResult.signals.find((signal) => signal.id === "ocr_space_doc_type")?.tone,
    "fail"
  );

  currentPayload = philsysPayload;
  const verificationInput = {
    front: { bytes: new Uint8Array([1, 2, 3]), type: "image/jpeg" },
    docType: "philsys",
    expectedName: "Juan Santos Dela Cruz",
  };
  assert.equal(ocrSpaceConfigured(), true);
  assert.ok(activeProviders().some((provider) => provider.id === "ocr_space"));

  const verificationResult = await runIdVerification(verificationInput);
  assert.ok(verificationResult.provider.includes("ocr_space"));
  assert.ok(!verificationResult.provider.includes("local_ocr"));
  assert.ok(
    !verificationResult.signals.some((signal) => signal.id.startsWith("provider_local_ocr")),
    "staff ID verification does not select local OCR"
  );
  assert.ok(
    verificationResult.signals.some((signal) => signal.id === "front_shape"),
    "local document-shape checks remain supplemental"
  );

  globalThis.fetch = async () => {
    throw new Error("mock OCR.space outage");
  };
  const failedOcrResult = await runIdVerification(verificationInput);
  assert.ok(
    failedOcrResult.signals.some((signal) => signal.id === "provider_ocr_space"),
    "OCR.space failures are surfaced to the upload route"
  );

  delete process.env.OCR_SPACE_API_KEY;
  assert.equal(ocrSpaceConfigured(), false);
  await assert.rejects(
    runIdVerification(verificationInput),
    (error) => error instanceof IdProviderError && error.provider === "ocr_space"
  );
} finally {
  globalThis.fetch = previousFetch;
  if (previousApiKey === undefined) delete process.env.OCR_SPACE_API_KEY;
  else process.env.OCR_SPACE_API_KEY = previousApiKey;
  if (previousHypervergeAppId === undefined) delete process.env.HYPERVERGE_APP_ID;
  else process.env.HYPERVERGE_APP_ID = previousHypervergeAppId;
  if (previousHypervergeAppKey === undefined) delete process.env.HYPERVERGE_APP_KEY;
  else process.env.HYPERVERGE_APP_KEY = previousHypervergeAppKey;
}

console.log("OCR.space provider tests passed.");
