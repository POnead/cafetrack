/**
 * Camera screens, driven through a real browser with a synthetic camera.
 *
 *   npm run dev                (terminal 1)
 *   npm run test:camera        (terminal 2)
 *
 * ## Why this suite exists at all
 *
 * Every camera screen in this app has at some point opened a camera, lit its
 * indicator, and shown nothing — the stream was assigned to a ref that no
 * element pointed at, or to an element that had not mounted yet. From the
 * outside that is indistinguishable from a broken camera: a green light and a
 * black rectangle. An HTTP test cannot see it, because the whole thing happens
 * in the page, and an assertion of "no console errors" passes happily while the
 * video renders nothing.
 *
 * So this drives the real UI and then asks the only question that matters:
 *
 *     is the video element actually producing frames?
 *
 * `videoWidth > 0` and `readyState >= 2` are the answer. They are false in
 * exactly the case that has bitten this app three times — element present,
 * stream attached to nothing — and true once the browser has decoded a frame.
 *
 * ## The synthetic camera
 *
 * Chrome's `--use-fake-device-for-media-stream` provides a camera without
 * hardware, and `--use-fake-ui-for-media-stream` grants the permission without a
 * prompt. Together they make this testable on a machine with no webcam, which is
 * every machine that matters here — and they remove the permission prompt from
 * the path entirely, so a run is deterministic.
 *
 * That also means this suite does NOT cover the permission-refused branch. The
 * wording for that lives in lib/face-diagnostics.ts and is unit-tested there
 * (npm run test:face-diagnostics); what is tested here is the happy path and the
 * wiring, which is where the bugs actually were.
 */
import { chromium } from "playwright-core";
import { assertTestTarget } from "./_guard.mjs";

const BASE = process.env.BASE_URL || "http://localhost:3100";

let pass = 0;
let fail = 0;
const failures = [];

function check(label, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`  PASS  ${label}${detail ? "  " + detail : ""}`);
  } else {
    fail++;
    failures.push(label);
    console.log(`  FAIL  ${label}${detail ? "  " + detail : ""}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

await assertTestTarget(BASE);

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    // Grants the camera to the origin without a prompt, for the same reason as
    // the flag above. Derived from BASE so this suite works unchanged against
    // the isolated test server on :3101 as well as the dev server on :3100.
    `--unsafely-treat-insecure-origin-as-secure=${BASE}`,
  ],
});

try {
  const context = await browser.newContext({ permissions: ["camera"] });

  /* ---------------------------------------------------------------- ID -- */

  section("ID verification — camera capture");

  const idPage = await context.newPage();

  await idPage.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await idPage.getByRole("button", { name: /admin/i }).click();
  await idPage.getByPlaceholder(/username/i).first().fill("admin");
  await idPage.locator('input[type="password"]').first().fill("admin123");
  await idPage.getByRole("button", { name: /^(login|sign in|log in)$/i }).first().click();
  await idPage.waitForURL(/dashboard/, { timeout: 15000 });

  // A staff account to attach an ID to. Created here rather than relying on the
  // seeded barista1, because this suite must not assume a particular roster.
  const suffix = Date.now().toString(36).slice(-6);
  const username = `cam${suffix}`;

  await idPage.goto(`${BASE}/users`, { waitUntil: "networkidle" });
  await idPage.getByRole("button", { name: /add account/i }).first().click();

  // By id, not by label. The second name field reads "Surname", not "Last name",
  // and a text selector is far cheaper to correct than a whole flow is to
  // rediscover.
  await idPage.locator("#u-first").fill("Camera");
  await idPage.locator("#u-last").fill(`Test${suffix}`);
  await idPage.locator("#u-username").fill(username);
  await idPage.locator("#u-password").fill("cameratest123");
  await idPage.getByRole("button", { name: /^create account$/i }).first().click();
  await idPage.waitForTimeout(1500);

  // Open the account's details, then the ID modal.
  const creationDetailsClose = idPage.getByRole("button", { name: "Close" });
  if (await creationDetailsClose.count()) await creationDetailsClose.first().click();
  await idPage.getByRole("button", { name: /^view$/i }).first().click();
  await idPage.waitForTimeout(400);
  const verifyBtn = idPage.getByRole("button", { name: /verify id|replace id/i }).first();
  const hasVerify = await verifyBtn.count();

  check("the Verify ID control is reachable", hasVerify > 0);

  if (hasVerify > 0) {
    await verifyBtn.click();
    await idPage.waitForTimeout(1500);

    check(
      "the ID modal offers a camera for the front of the ID",
      (await idPage.getByRole("button", { name: /use camera/i }).count()) > 0
    );

    check(
      "the file input is a capture input, so a phone opens its camera app",
      await idPage.locator('input#id-front[capture="environment"]').count() > 0
    );

    await idPage.getByRole("button", { name: /use camera/i }).first().click();

    // The camera needs a moment to produce its first frame.
    await idPage.waitForTimeout(2500);

    const video = idPage.locator("video").first();
    const count = await video.count();

    check("a video element is mounted when the camera opens", count > 0);

    if (count > 0) {
      const state = await video.evaluate((v) => ({
        width: v.videoWidth,
        height: v.videoHeight,
        readyState: v.readyState,
        paused: v.paused,
        hasStream: !!v.srcObject,
      }));

      /*
       * This is the assertion the whole suite exists for.
       *
       * `hasStream` alone is the trap: a stream can be attached to an element
       * that is mounted but not yet playing, and the element then reports zero
       * width forever. Frames are the only proof the camera is actually visible
       * to the person using it.
       */
      check(
        "the video element is actually showing frames, not just a black rectangle",
        state.width > 0 && state.readyState >= 2 && !state.paused,
        `${state.width}x${state.height} readyState=${state.readyState} paused=${state.paused}`
      );
      check("the video has a live stream attached", state.hasStream);

      // The ID front is held for review before it enters the slot.
      await idPage.getByRole("button", { name: /capture manually|take the picture/i }).first().click();
      await idPage.waitForTimeout(2500);

      const pendingPreview = await idPage
        .locator('img[alt="Captured ID photo pending confirmation"]')
        .count();
      check("the captured picture is shown for review", pendingPreview > 0);
      check(
        "the captured picture requires confirmation",
        (await idPage.getByRole("button", { name: "Use this ID" }).count()) > 0
      );
    }
  }

  /* -------------------------------------------------------------- face -- */

  section("face sign-in — camera capture");

  const facePage = await context.newPage();
  await facePage.goto(`${BASE}/login`, { waitUntil: "networkidle" });

  // Only meaningful when the cafe has switched the feature on.
  const probe = await facePage.evaluate(() =>
    fetch("/api/auth/face-login").then((r) => r.json()).catch(() => null)
  );

  if (probe?.enabled !== true) {
    console.log("  SKIP  face sign-in is switched off on this database");
  } else {
    await facePage.getByPlaceholder(/barcode|username/i).first().fill("barista1");
    await facePage.getByRole("button", { name: /use my face instead/i }).first().click();
    await facePage.waitForTimeout(500);

    /*
     * Click "Take a picture" first — the camera does not open by itself.
     *
     * And this step also downloads the ~7MB recognition weights before it will
     * open a camera at all, so a fixed sleep is not an option here: far too short
     * on a cold cache, or half a minute wasted on a warm one. Waiting for the
     * element itself is both faster and the thing actually being asserted.
     */
    await facePage.getByRole("button", { name: /take a picture/i }).first().click();

    let fc = 0;
    try {
      await facePage
        .locator("video")
        .first()
        .waitFor({ state: "attached", timeout: 60000 });
      fc = 1;
    } catch {
      fc = 0;
    }
    check("the sign-in camera mounts a video", fc > 0);

    if (fc > 0) {
      // Give the first frame a moment to decode before measuring.
      await facePage.waitForTimeout(1500);
      const s = await facePage.locator("video").first().evaluate((v) => ({
        width: v.videoWidth,
        readyState: v.readyState,
        paused: v.paused,
        hasStream: !!v.srcObject,
      }));
      check(
        "the sign-in camera is showing frames",
        s.width > 0 && s.readyState >= 2 && !s.paused,
        `${s.width}px readyState=${s.readyState} paused=${s.paused}`
      );
      check("the sign-in camera has a live stream", s.hasStream);
    }
  }

  /* ----------------------------------------------------------- tidy up -- */

  /*
   * Park the account this suite created.
   *
   * /api/users/:id has no DELETE — it only answers PATCH — so a run cannot
   * remove what it made. The account is deactivated instead, which takes it out
   * of every active list and is the state a real off-boarding leaves behind.
   *
   * Worth knowing for anyone extending this suite: the existing
   * _id-verification-tests.mjs cleanup calls DELETE on this route too, and gets
   * a 405. It does not fail that suite because the call is unchecked.
   */
  try {
    await idPage.goto(`${BASE}/users`, { waitUntil: "networkidle" });
    const parked = await idPage.evaluate(async (u) => {
      const res = await fetch("/api/users");
      if (!res.ok) return "lookup refused " + res.status;
      const { users } = await res.json();
      const me = users.find((x) => x.username === u);
      if (!me) return "already gone";
      const off = await fetch(`/api/users/${me.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          is_active: false,
          deactivation_reason: "Created by the camera test suite",
        }),
      });
      return `deactivated ${off.status}`;
    }, username);
    console.log(`\n  cleanup: ${username} -> ${parked}`);
  } catch (e) {
    console.log(`\n  cleanup failed for ${username}: ${e.message}`);
  }
} finally {
  await browser.close();
}

console.log(`\n----------------------------------------------`);
console.log(`${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log(`\nFailures:`);
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(fail > 0 ? 1 : 0);