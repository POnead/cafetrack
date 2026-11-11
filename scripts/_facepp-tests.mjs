/**
 * Face++ Detect, Analyze, Search and private FaceSet request/response tests.
 *
 *   npm run test:facepp
 */
import {
  createFacePlusPlusEnrollment,
  deleteFacePlusPlusEnrollment,
  compareFacePlusPlus,
  detectFacePlusPlus,
  facePlusPlusFaceSetTokens,
  facePlusPlusMode,
  searchFacePlusPlus,
  verifyFacePlusPlusBlink,
  verifyFacePlusPlusLogin,
} from "../src/lib/facepp.ts";
import { parseFaceBlinkEvidence } from "../src/lib/face.ts";

const originalFetch = globalThis.fetch;
const originalEnv = Object.fromEntries(
  [
    "FACEPP_API_KEY",
    "FACEPP_API_SECRET",
    "FACEPP_API_REGION",
    "CAFETRACK_TEST_FACE_LIVENESS",
    "CAFETRACK_FACEPP_MIN_GAP_MS",
  ].map((key) => [key, process.env[key]])
);
// fetch is mocked here, so the production inter-request gap would only slow the
// suite down without protecting anything.
process.env.CAFETRACK_FACEPP_MIN_GAP_MS = "0";
const reference = "data:image/jpeg;base64,ZmFrZQ==";
const savedAccountPhoto = "data:image/png;base64,c2F2ZWQtYWNjb3VudC1waG90bw==";
const liveCameraPhoto = "data:image/jpeg;base64,bGl2ZS1jYW1lcmEtcGhvdG8=";
const responses = [];
const paths = [];
const requiredFields = [];
let pass = 0;
let calls = 0;
let lastRequest = null;

function check(label, condition) {
  if (!condition) throw new Error(`FAIL ${label}`);
  pass++;
  console.log(`PASS ${label}`);
}

function expect(path, response, fields = {}) {
  paths.push(path);
  requiredFields.push(fields);
  responses.push(response);
}

function eye(open, closed = 0) {
  return {
    no_glass_eye_open: open,
    no_glass_eye_close: closed,
    normal_glass_eye_open: 0,
    normal_glass_eye_close: 0,
  };
}

function analyzedFace(faceToken, left, right) {
  return {
    face_token: faceToken,
    attributes: {
      eyestatus: { left_eye_status: left, right_eye_status: right },
    },
  };
}

function detectedFace(faceToken, yawAngle = 0, eyes = null) {
  const attributes = { headpose: { yaw_angle: yawAngle } };
  if (eyes) {
    const status = eyes === "closed" ? eye(0, 98) : eye(98);
    attributes.eyestatus = {
      left_eye_status: status,
      right_eye_status: { ...status },
    };
  }
  return { face_token: faceToken, attributes };
}

function expectLoginDetections(tokens, failedIndex = -1, yawOverride = null, eyesOverride = null) {
  // The frontal frame is reused as blink-before. Login can send one or two
  // closed/open pairs; the duty-check path continues to use one pair.
  const images =
    tokens.length === 7
      ? ["bGl2ZQ==", "bGVmdA==", "cmlnaHQ=", "ZmFrZQ==", "ZmFrZQ==", "ZmFrZQ==", "ZmFrZQ=="]
      : ["bGl2ZQ==", "bGVmdA==", "cmlnaHQ=", "ZmFrZQ==", "ZmFrZQ=="];
  const yawAngles = yawOverride ?? images.map((_, index) => [0, -30, 30][index] ?? 0);
  const eyeStates =
    eyesOverride ??
    images.map((_, index) => ["open", "open", "open", "closed", "open", "closed", "open"][index]);
  for (const [index, token] of tokens.entries()) {
    expect(
      "detect",
      {
        status: 200,
        body: {
          faces:
            failedIndex === index
              ? []
              : [detectedFace(token, yawAngles[index], eyeStates[index])],
        },
      },
      { image_base64: images[index], return_attributes: "headpose,eyestatus" }
    );
  }
}

function expectLoginBlinkAnalyze(tokens, states = ["open", "closed", "open"]) {
  const eyes = states.map((state) => (state === "closed" ? eye(3, 95) : eye(95)));
  expect(
    "face/analyze",
    {
      status: 200,
      body: {
        faces: tokens.map((token, index) =>
          analyzedFace(token, eyes[index], { ...eyes[index] })
        ),
      },
    },
    { face_tokens: tokens.join(","), return_attributes: "eyestatus" }
  );
}

try {
  const blinkFrame = "data:image/jpeg;base64,ZmFrZQ==";
  check(
    "login evidence parser rejects a single blink when two are required",
    parseFaceBlinkEvidence(
      { before: blinkFrame, closed: blinkFrame, after: blinkFrame },
      true
    ) === null
  );
  check(
    "login evidence parser accepts two complete blink cycles",
    parseFaceBlinkEvidence(
      {
        before: blinkFrame,
        closed: blinkFrame,
        after: blinkFrame,
        closedAgain: blinkFrame,
        afterAgain: blinkFrame,
      },
      true
    ) !== null
  );
  check(
    "login evidence parser rejects an incomplete second blink",
    parseFaceBlinkEvidence(
      {
        before: blinkFrame,
        closed: blinkFrame,
        after: blinkFrame,
        closedAgain: blinkFrame,
      },
      true
    ) === null
  );

  process.env.FACEPP_API_KEY = "test-key";
  process.env.FACEPP_API_SECRET = "test-secret";
  process.env.FACEPP_API_REGION = "US";
  delete process.env.CAFETRACK_TEST_FACE_LIVENESS;

  globalThis.fetch = async (url, options) => {
    calls++;
    const parsed = new URL(url);
    lastRequest = {
      href: parsed.href,
      method: options?.method ?? "GET",
      contentType: new Headers(options?.headers).get("content-type"),
    };
    const path = parsed.pathname.replace("/facepp/v3/", "");
    check(`requests the expected ${path} endpoint`, paths.shift() === path);
    const body = new URLSearchParams(options.body);
    check(
      "keeps credentials in the server-side request body",
      body.get("api_key") === "test-key" && body.get("api_secret") === "test-secret"
    );
    const fields = requiredFields.shift();
    check(
      `${path} sends the expected request fields`,
      Object.entries(fields).every(([key, value]) => body.get(key) === value)
    );
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body), { status: next.status });
  };

  check("configured credentials enable Face++", facePlusPlusMode() === "enabled");
  check(
    "FaceSet cleanup tokens are de-duplicated",
    JSON.stringify(facePlusPlusFaceSetTokens("current", ["current", "old", 4])) ===
      JSON.stringify(["current", "old"])
  );

  expect(
    "detect",
    { status: 200, body: { faces: [detectedFace("live-face-token")] } },
    { image_base64: "ZmFrZQ==", return_attributes: "headpose,eyestatus" }
  );
  const detected = await detectFacePlusPlus(reference);
  check(
    "Detect returns the token from exactly one face",
    "faceToken" in detected &&
      detected.faceToken === "live-face-token" &&
      detected.yawAngle === 0
  );
  // The preceding mock consumed both checks; inspect the request fields directly
  // in a second Detect so that this assertion is independent of test ordering.
  expect(
    "detect",
    { status: 200, body: { faces: [detectedFace("verified-token", -27, "closed")] } },
    { image_base64: "ZmFrZQ==", return_attributes: "headpose,eyestatus" }
  );
  const fieldCheck = await detectFacePlusPlus(reference);
  check(
    "Detect returns yaw and eye state from the same call",
    "faceToken" in fieldCheck &&
      fieldCheck.faceToken === "verified-token" &&
      fieldCheck.yawAngle === -27 &&
      fieldCheck.eyeState === "closed" &&
      calls === 2
  );

  expect("face/analyze", {
    status: 200,
    body: {
      faces: [
        analyzedFace("live-face-token", eye(96), eye(94)),
        analyzedFace("closed-token", eye(3, 95), eye(4, 94)),
        analyzedFace("verified-token", eye(92), eye(96)),
      ],
    },
  }, {
    face_tokens: "live-face-token,closed-token,verified-token",
    return_attributes: "eyestatus",
  });
  const blink = await verifyFacePlusPlusBlink([
    detected.faceToken,
    "closed-token",
    fieldCheck.faceToken,
  ]);
  check("Analyze accepts open, closed, open eyes", blink.status === "matched");

  expect("face/analyze", {
    status: 200,
    body: {
      faces: [
        analyzedFace("before", eye(95), eye(96)),
        analyzedFace("still-open", eye(92), eye(90)),
        analyzedFace("after", eye(94), eye(95)),
      ],
    },
  }, {
    face_tokens: "before,still-open,after",
    return_attributes: "eyestatus",
  });
  check(
    "Analyze rejects a sequence with no closed-eye frame",
    (await verifyFacePlusPlusBlink(["before", "still-open", "after"])).status === "rejected"
  );

  expect(
    "search",
    { status: 200, body: { results: [{ confidence: 90 }] } },
    { face_token: "query-token", faceset_token: "private-faceset", return_result_count: "1" }
  );
  check(
    "Search matches a face above the threshold",
    (await searchFacePlusPlus("query-token", "private-faceset")).status === "matched"
  );

  expect(
    "search",
    { status: 200, body: { results: [{ confidence: 79.9 }] } },
    { face_token: "query-token", faceset_token: "private-faceset", return_result_count: "1" }
  );
  check(
    "Search rejects a face below the threshold",
    (await searchFacePlusPlus("query-token", "private-faceset")).status === "rejected"
  );

  expect(
    "compare",
    { status: 200, body: { confidence: 77.5 } },
    {
      image_base64_1: "c2F2ZWQtYWNjb3VudC1waG90bw==",
      image_base64_2: "bGl2ZS1jYW1lcmEtcGhvdG8=",
    }
  );
  const compareMatch = await compareFacePlusPlus(savedAccountPhoto, liveCameraPhoto);
  check(
    "Compare sends the saved account image first and the live camera image second",
    compareMatch.status === "matched"
  );
  check(
    "Compare POSTs to https://api-us.faceplusplus.com/facepp/v3/compare",
    lastRequest?.href === "https://api-us.faceplusplus.com/facepp/v3/compare" &&
      lastRequest?.method === "POST"
  );
  check(
    "Compare sends url-encoded form data",
    lastRequest?.contentType === "application/x-www-form-urlencoded"
  );

  expect(
    "compare",
    { status: 200, body: { confidence: 74.9 } },
    { image_base64_1: "ZmFrZQ==", image_base64_2: "ZmFrZQ==" }
  );
  check(
    "Compare rejects a score below the login threshold",
    (await compareFacePlusPlus(reference, reference)).status === "rejected"
  );

  expectLoginDetections(["front", "left", "right", "closed", "after"]);
  expectLoginBlinkAnalyze(["front", "closed", "after"]);
  expect(
    "compare",
    { status: 200, body: { confidence: 90 } },
    { image_base64_1: "ZmFrZQ==", image_base64_2: "bGl2ZQ==" }
  );
  const login = await verifyFacePlusPlusLogin({
    referenceImage: reference,
    frontImage: "data:image/jpeg;base64,bGl2ZQ==",
    leftImage: "data:image/jpeg;base64,bGVmdA==",
    rightImage: "data:image/jpeg;base64,cmlnaHQ=",
    blinkEvidence: {
      // The capture reuses the frontal frame as the blink's "before" frame, so
      // the login path spends five Detect calls on this shape, not six.
      before: "data:image/jpeg;base64,bGl2ZQ==",
      closed: reference,
      after: reference,
    },
  });
  check(
    "login uses Analyze to verify captured blink frames before matching the saved and live images",
    login.status === "matched" &&
      Object.values(login.steps).every((step) => step === "passed")
  );

  expectLoginDetections(
    ["front-near-threshold", "left-near-threshold", "right-near-threshold", "closed-near-threshold", "after-near-threshold"],
    -1,
    [0, -16, 16, 0, 0]
  );
  expectLoginBlinkAnalyze([
    "front-near-threshold",
    "closed-near-threshold",
    "after-near-threshold",
  ]);
  expect(
    "compare",
    { status: 200, body: { confidence: 90 } },
    { image_base64_1: "ZmFrZQ==", image_base64_2: "bGl2ZQ==" }
  );
  const nearThresholdLogin = await verifyFacePlusPlusLogin({
    referenceImage: reference,
    frontImage: "data:image/jpeg;base64,bGl2ZQ==",
    leftImage: "data:image/jpeg;base64,bGVmdA==",
    rightImage: "data:image/jpeg;base64,cmlnaHQ=",
    blinkEvidence: {
      before: "data:image/jpeg;base64,bGl2ZQ==",
      closed: reference,
      after: reference,
    },
  });
  check(
    "login accepts clearly opposite 16-degree side readings despite provider angle variation",
    nearThresholdLogin.status === "matched" &&
      nearThresholdLogin.poseChecks?.left === true &&
      nearThresholdLogin.poseChecks?.right === true
  );

  expectLoginDetections(
    ["front-below-threshold", "left-below-threshold", "right-below-threshold", "closed-below-threshold", "after-below-threshold"],
    -1,
    [0, -14, 14, 0, 0]
  );
  expectLoginBlinkAnalyze([
    "front-below-threshold",
    "closed-below-threshold",
    "after-below-threshold",
  ]);
  expect(
    "compare",
    { status: 200, body: { confidence: 90 } },
    { image_base64_1: "ZmFrZQ==", image_base64_2: "bGl2ZQ==" }
  );
  const belowThresholdLogin = await verifyFacePlusPlusLogin({
    referenceImage: reference,
    frontImage: "data:image/jpeg;base64,bGl2ZQ==",
    leftImage: "data:image/jpeg;base64,bGVmdA==",
    rightImage: "data:image/jpeg;base64,cmlnaHQ=",
    blinkEvidence: {
      before: "data:image/jpeg;base64,bGl2ZQ==",
      closed: reference,
      after: reference,
    },
  });
  check(
    "login still refuses side readings below the minimum angle",
    belowThresholdLogin.status === "rejected" &&
      belowThresholdLogin.reason === "pose_not_verified" &&
      belowThresholdLogin.poseChecks?.left === false &&
      belowThresholdLogin.poseChecks?.right === false
  );

  const callsBeforeMissingBlink = calls;
  const missingSecondBlink = await verifyFacePlusPlusLogin({
    referenceImage: reference,
    frontImage: "data:image/jpeg;base64,bGl2ZQ==",
    leftImage: "data:image/jpeg;base64,bGVmdA==",
    rightImage: "data:image/jpeg;base64,cmlnaHQ=",
    blinkEvidence: {
      before: "data:image/jpeg;base64,bGl2ZQ==",
      closed: reference,
      after: reference,
    },
    requireDoubleBlink: true,
  });
  check(
    "login refuses a missing second blink without calling Face++",
    missingSecondBlink.status === "rejected" &&
      missingSecondBlink.reason === "blink_not_verified" &&
      calls === callsBeforeMissingBlink
  );

  expectLoginDetections(["front-double", "left-double", "right-double", "closed-1", "open-1", "closed-2", "open-2"]);
  expectLoginBlinkAnalyze(
    ["front-double", "closed-1", "open-1", "closed-2", "open-2"],
    ["open", "closed", "open", "closed", "open"]
  );
  expect(
    "compare",
    { status: 200, body: { confidence: 90 } },
    { image_base64_1: "ZmFrZQ==", image_base64_2: "bGl2ZQ==" }
  );
  const doubleBlinkLogin = await verifyFacePlusPlusLogin({
    referenceImage: reference,
    frontImage: "data:image/jpeg;base64,bGl2ZQ==",
    leftImage: "data:image/jpeg;base64,bGVmdA==",
    rightImage: "data:image/jpeg;base64,cmlnaHQ=",
    blinkEvidence: {
      before: "data:image/jpeg;base64,bGl2ZQ==",
      closed: reference,
      after: reference,
      closedAgain: reference,
      afterAgain: reference,
    },
    requireDoubleBlink: true,
  });
  check(
    "login requires and verifies two open/closed/open blink cycles",
    doubleBlinkLogin.status === "matched" &&
      Object.values(doubleBlinkLogin.steps).every((step) => step === "passed")
  );

  expectLoginDetections(
    ["front-bad-double", "left-bad-double", "right-bad-double", "closed-1-bad", "open-1-bad", "closed-2-bad", "open-2-bad"],
    -1,
    null,
    ["open", "open", "open", "closed", "open", "open", "open"]
  );
  expectLoginBlinkAnalyze(
    ["front-bad-double", "closed-1-bad", "open-1-bad", "closed-2-bad", "open-2-bad"],
    ["open", "closed", "open", "open", "open"]
  );
  expect(
    "compare",
    { status: 200, body: { confidence: 90 } },
    { image_base64_1: "ZmFrZQ==", image_base64_2: "bGl2ZQ==" }
  );
  const secondBlinkRejected = await verifyFacePlusPlusLogin({
    referenceImage: reference,
    frontImage: "data:image/jpeg;base64,bGl2ZQ==",
    leftImage: "data:image/jpeg;base64,bGVmdA==",
    rightImage: "data:image/jpeg;base64,cmlnaHQ=",
    blinkEvidence: {
      before: "data:image/jpeg;base64,bGl2ZQ==",
      closed: reference,
      after: reference,
      closedAgain: reference,
      afterAgain: reference,
    },
    requireDoubleBlink: true,
  });
  check(
    "login rejects two frames that do not show two closed/open cycles",
    secondBlinkRejected.status === "rejected" &&
      secondBlinkRejected.reason === "blink_not_verified" &&
      secondBlinkRejected.steps.blink === "failed"
  );

  // Both side frames must be turns in the direction their slot asked for. A
  // second frame that merely shows *some* side is not left+right evidence.
  expectLoginDetections(
    ["front-wrong", "left-wrong", "right-wrong", "closed-wrong", "after-wrong"],
    -1,
    [0, 30, 30, 0, 0]
  );
  expectLoginBlinkAnalyze(["front-wrong", "closed-wrong", "after-wrong"]);
  expect(
    "compare",
    { status: 200, body: { confidence: 40 } },
    { image_base64_1: "ZmFrZQ==", image_base64_2: "bGl2ZQ==" }
  );
  const wrongDirection = await verifyFacePlusPlusLogin({
    referenceImage: reference,
    frontImage: "data:image/jpeg;base64,bGl2ZQ==",
    leftImage: "data:image/jpeg;base64,bGVmdA==",
    rightImage: "data:image/jpeg;base64,cmlnaHQ=",
    blinkEvidence: {
      before: "data:image/jpeg;base64,bGl2ZQ==",
      closed: reference,
      after: reference,
    },
  });
  check(
    "login checks blink and identity even when a side pose fails",
    wrongDirection.status === "rejected" &&
      wrongDirection.reason === "pose_not_verified" &&
      wrongDirection.steps.blink === "passed" &&
      wrongDirection.steps.compare === "failed" &&
      wrongDirection.poseChecks?.left === false &&
      wrongDirection.poseChecks?.right === true
  );

  expectLoginDetections(
    ["front-2", "left-2", "right-2", "closed-2", "after-2"],
    -1,
    null,
    ["open", "open", "open", "open", "open"]
  );
  expectLoginBlinkAnalyze(["front-2", "closed-2", "after-2"], ["open", "open", "open"]);
  expect(
    "compare",
    { status: 200, body: { confidence: 90 } },
    { image_base64_1: "ZmFrZQ==", image_base64_2: "bGl2ZQ==" }
  );
  const blinkRejectedLogin = await verifyFacePlusPlusLogin({
    referenceImage: reference,
    frontImage: "data:image/jpeg;base64,bGl2ZQ==",
    leftImage: "data:image/jpeg;base64,bGVmdA==",
    rightImage: "data:image/jpeg;base64,cmlnaHQ=",
    blinkEvidence: {
      before: "data:image/jpeg;base64,bGl2ZQ==",
      closed: reference,
      after: reference,
    },
  });
  check(
    "login still calls Compare when the blink frames read as open",
    blinkRejectedLogin.status === "rejected" &&
      blinkRejectedLogin.reason === "blink_not_verified" &&
      blinkRejectedLogin.steps.blink === "failed" &&
      blinkRejectedLogin.steps.compare === "passed"
  );

  expectLoginDetections(
    ["front-3", "left-3", "right-3", "closed-3", "after-3"],
    1
  );
  const faceRejectedLogin = await verifyFacePlusPlusLogin({
    referenceImage: reference,
    frontImage: "data:image/jpeg;base64,bGl2ZQ==",
    leftImage: "data:image/jpeg;base64,bGVmdA==",
    rightImage: "data:image/jpeg;base64,cmlnaHQ=",
    blinkEvidence: {
      before: "data:image/jpeg;base64,bGl2ZQ==",
      closed: reference,
      after: reference,
    },
  });
  check(
    "login skips blink and Compare when Detect cannot find a face",
    faceRejectedLogin.status === "rejected" &&
      faceRejectedLogin.reason === "face_not_detected" &&
      faceRejectedLogin.steps.detect === "failed" &&
      faceRejectedLogin.steps.blink === "not_run" &&
      faceRejectedLogin.steps.compare === "not_run"
  );

  expect(
    "detect",
    { status: 200, body: { faces: [] } },
    { image_base64: "ZmFrZQ==", return_attributes: "headpose,eyestatus" }
  );
  check("Detect rejects an image without a face", (await detectFacePlusPlus(reference)).status === "rejected");

  const beforeInvalid = calls;
  check(
    "invalid image data is rejected before making a request",
    (await detectFacePlusPlus("not-an-image")).status === "rejected" && calls === beforeInvalid
  );

  expect(
    "detect",
    { status: 200, body: { faces: [detectedFace("enrolled-token")] } },
    { image_base64: "ZmFrZQ==", return_attributes: "headpose,eyestatus" }
  );
  expect("faceset/create", { status: 200, body: { faceset_token: "private-faceset" } });
  expect(
    "faceset/addface",
    { status: 200, body: { face_added: 1 } },
    { faceset_token: "private-faceset", face_tokens: "enrolled-token" }
  );
  const enrollment = await createFacePlusPlusEnrollment("user-id", reference);
  check(
    "enrollment builds a private FaceSet from the account reference",
    "facesetToken" in enrollment &&
      enrollment.facesetToken === "private-faceset" &&
      enrollment.faceToken === "enrolled-token"
  );

  expect(
    "faceset/delete",
    { status: 200, body: { faceset_token: "private-faceset" } },
    { faceset_token: "private-faceset", check_empty: "0" }
  );
  check(
    "revocation removes the complete FaceSet",
    (await deleteFacePlusPlusEnrollment("private-faceset")).status === "matched"
  );

  expect(
    "search",
    { status: 400, body: { error_message: "INVALID_FACESET_TOKEN: invalid" } },
    { face_token: "query-token", faceset_token: "private-faceset", return_result_count: "1" }
  );
  const providerFailure = await searchFacePlusPlus("query-token", "private-faceset");
  check(
    "provider errors fail closed without exposing provider messages",
    providerFailure.status === "unavailable" &&
      providerFailure.code === "invalid_faceset_token"
  );

  // The concurrency throttle is retryable: one rejected attempt, then success.
  expect(
    "detect",
    { status: 403, body: { error_message: "CONCURRENCY_LIMIT_EXCEEDED" } },
    { image_base64: "ZmFrZQ==", return_attributes: "headpose,eyestatus" }
  );
  expect(
    "detect",
    { status: 200, body: { faces: [detectedFace("retry-token")] } },
    { image_base64: "ZmFrZQ==", return_attributes: "headpose,eyestatus" }
  );
  const retried = await detectFacePlusPlus(reference);
  check(
    "a concurrency-throttled call is retried and then succeeds",
    "faceToken" in retried && retried.faceToken === "retry-token"
  );

  // Exhausting the retries must preserve the specific code rather than collapse
  // it into "provider_error", so the route can tell throttling from an outage.
  for (let attempt = 0; attempt < 4; attempt++) {
    expect(
      "detect",
      { status: 403, body: { error_message: "CONCURRENCY_LIMIT_EXCEEDED" } },
      { image_base64: "ZmFrZQ==", return_attributes: "headpose,eyestatus" }
    );
  }
  const throttled = await detectFacePlusPlus(reference);
  check(
    "an exhausted concurrency throttle reports its own code",
    throttled.status === "unavailable" &&
      throttled.code === "concurrency_limit_exceeded"
  );

  expect(
    "detect",
    new Error("network unavailable"),
    { image_base64: "ZmFrZQ==", return_attributes: "headpose,eyestatus" }
  );
  const networkFailure = await detectFacePlusPlus(reference);
  check(
    "network errors fail closed",
    networkFailure.status === "unavailable" && networkFailure.code === "network_error"
  );

  console.log(`\n${pass} Face++ checks passed.`);
} finally {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
