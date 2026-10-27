/**
 * Capture representative user-facing screens at desktop and phone sizes.
 *
 *   npm run dev:test
 *   npm run capture:ui
 *
 * This is intentionally read-only: it signs in, visits pages, and opens forms
 * and panels without submitting them. The test-target guard refuses the live DB.
 */
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { assertTestTarget } from "./_guard.mjs";

const BASE = process.env.BASE_URL || "http://localhost:3101";
const SHOTS = process.env.UI_CAPTURE_DIR || "ui-screenshots";
const DESKTOP = { width: 1440, height: 1000 };
const PHONE = { width: 390, height: 844 };

let captures = 0;
let failures = 0;
const runtimeErrors = [];

function check(label, ok, detail = "") {
  if (ok) {
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures++;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function observe(page, label) {
  page.on("console", (message) => {
    if (message.type() !== "error" || /Download the React DevTools/i.test(message.text())) {
      return;
    }
    // The shared app shell checks the admin-only settings endpoint to build
    // role-aware navigation; its 403 for staff is expected.
    if (
      label.startsWith("staff-") &&
      /status of 403 \(Forbidden\)/i.test(message.text())
    ) {
      return;
    }
    if (
      label.startsWith("staff-id-step-") &&
      /status of 401 \(Unauthorized\)/i.test(message.text())
    ) {
      return;
    }
    runtimeErrors.push(`[${label}] ${message.text().slice(0, 240)}`);
  });
  page.on("pageerror", (error) => {
    runtimeErrors.push(`[${label}] uncaught: ${error.message.slice(0, 240)}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 500) {
      runtimeErrors.push(`[${label}] HTTP ${response.status()} ${response.url()}`);
    }
  });
  page.on("requestfailed", (request) => {
    const reason = request.failure()?.errorText ?? "failed";
    if (!/ERR_ABORTED/.test(reason)) {
      runtimeErrors.push(`[${label}] ${request.method()} ${request.url()} — ${reason}`);
    }
  });
}

async function settle(page) {
  await page.locator("body").waitFor({ state: "visible" });
  await page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => {});
  await page.waitForTimeout(500);
}

async function capture(page, label, relativePath, expectedPath) {
  const response = await page.goto(`${BASE}${relativePath}`, { waitUntil: "domcontentloaded" });
  await settle(page);

  const actualPath = new URL(page.url()).pathname;
  const routeOk = response?.status() === 200 && actualPath === expectedPath;
  check(`${label} route`, routeOk, `HTTP ${response?.status() ?? "?"}, ${actualPath}`);

  const file = join(SHOTS, `${label}.png`);
  mkdirSync(dirname(file), { recursive: true });
  await hideDevOverlay(page);
  await page.screenshot({ path: file, fullPage: true, animations: "disabled" });
  captures++;
  console.log(`    ${file}`);
}

async function screenshot(page, label) {
  const file = join(SHOTS, `${label}.png`);
  mkdirSync(dirname(file), { recursive: true });
  await hideDevOverlay(page);
  await page.screenshot({ path: file, fullPage: true, animations: "disabled" });
  captures++;
  console.log(`    ${file}`);
}

async function hideDevOverlay(page) {
  await page.evaluate(() => {
    if (document.getElementById("cafetrack-capture-hide-next-dev")) return;
    const style = document.createElement("style");
    style.id = "cafetrack-capture-hide-next-dev";
    style.textContent = "nextjs-portal { display: none !important; }";
    document.head.append(style);
  });
}

async function setLoginMode(page, mode) {
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await settle(page);
  await page.getByRole("button", { name: new RegExp(`^${mode}$`, "i") }).click();
  await page.waitForTimeout(250);
}

async function signInAdmin(page) {
  await setLoginMode(page, "admin");
  await page.getByPlaceholder(/username/i).first().fill("admin");
  await page.locator('input[type="password"]').first().fill("admin123");
  await page.getByRole("button", { name: /^(login|sign in|log in)$/i }).first().click();
  await page.waitForURL(/\/dashboard(?:$|\?)/, { timeout: 20000 });
  await settle(page);
}

async function signInStaff(page, token) {
  await setLoginMode(page, "staff");
  await page.locator('input[type="password"]').first().fill("staff123");
  const code = page.locator("#staff-username").first();
  await code.fill(token);
  await code.press("Enter");
  await page.waitForURL(/\/dashboard(?:$|\?)/, { timeout: 20000 });
  await settle(page);
}

async function captureLoginModes(context, size) {
  const page = await context.newPage();
  observe(page, `login-${size}`);
  for (const mode of ["staff", "admin"]) {
    await setLoginMode(page, mode);
    await screenshot(page, `${size}/public/login-${mode}`);
  }
  await context.close();
}

async function captureRouteSet(page, size, role, paths, alertId) {
  for (const route of paths) {
    const isHome = route === "/";
    const name = isHome ? "home-redirect" : route.slice(1).replaceAll("/", "-");
    await capture(
      page,
      `${size}/${role}/${name}`,
      route,
      isHome ? "/dashboard" : route
    );
  }

  if (alertId) {
    const path = `/alerts/${alertId}`;
    await capture(page, `${size}/${role}/alerts-detail`, path, path);
  }
}

async function captureVerifyState(browser, storageState, size) {
  const context = await browser.newContext({ viewport: size === "desktop" ? DESKTOP : PHONE, storageState });
  const page = await context.newPage();
  observe(page, `verify-${size}`);
  await installCameraDenialMock(context);
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        user: { role: "staff" },
        face: {
          required: true,
          enabled: true,
          enrolled: false,
          dutyHours: 9,
          verifiedAt: null,
          nextDueAt: null,
        },
      }),
    })
  );
  await capture(page, `${size}/staff/verify-no-reference-photo`, "/verify", "/verify");
  await context.close();
}

async function installCameraDenialMock(context) {
  await context.addInitScript(() => {
    const permissions = navigator.permissions;
    const query = permissions.query.bind(permissions);
    Object.defineProperty(permissions, "query", {
      configurable: true,
      value: (descriptor) =>
        descriptor.name === "camera"
          ? Promise.resolve({ state: "denied" })
          : query(descriptor),
    });
    if (navigator.mediaDevices) {
      Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
        configurable: true,
        value: () => Promise.reject(new DOMException("Camera permission denied", "NotAllowedError")),
      });
    }
  });
}

async function installFakeCamera(context, { idCard = false, faceOnly = false, facing = "rear" } = {}) {
  await context.grantPermissions(["camera"], { origin: BASE });
  await context.addInitScript(({ showIdCard, showFace, cameraFacing }) => {
    const devices = navigator.mediaDevices;
    if (!devices) throw new Error("Camera mock requires browser mediaDevices support.");

    Object.defineProperty(devices, "getUserMedia", {
      configurable: true,
      value: async (constraints) => {
        const selectedDeviceId = constraints?.video?.deviceId?.exact;
        const selectedFacing =
          selectedDeviceId === "fake-front"
            ? "user"
            : selectedDeviceId === "fake-rear"
              ? "environment"
              : cameraFacing;
        const requestedFacing = constraints?.video?.facingMode;
        if (
          requestedFacing &&
          typeof requestedFacing === "object" &&
          requestedFacing.exact === "environment" &&
          selectedFacing !== "environment"
        ) {
          throw new DOMException("No rear camera is available.", "OverconstrainedError");
        }
        const canvas = document.createElement("canvas");
        canvas.width = showIdCard ? 800 : 640;
        canvas.height = showIdCard ? 500 : 800;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Could not create the deterministic camera preview.");

        const background = context.createLinearGradient(0, 0, 0, canvas.height);
        background.addColorStop(0, "#6e655b");
        background.addColorStop(1, "#2e2925");
        context.fillStyle = background;
        context.fillRect(0, 0, canvas.width, canvas.height);

        if (showIdCard) {
          context.fillStyle = "#f4ead1";
          context.fillRect(100, 55, 600, 390);
          context.strokeStyle = "#c3a875";
          context.lineWidth = 7;
          context.strokeRect(103, 58, 594, 384);
          context.fillStyle = "#735f43";
          context.fillRect(125, 85, 115, 130);
          context.fillStyle = "#30291f";
          context.font = "bold 24px sans-serif";
          context.fillText("REPUBLIC OF THE PHILIPPINES", 265, 112);
          context.font = "20px sans-serif";
          context.fillText("IDENTIFICATION CARD", 265, 148);
          context.font = "bold 26px sans-serif";
          context.fillText("JUAN DELA CRUZ", 265, 198);
          context.fillRect(265, 220, 325, 5);
          context.font = "18px sans-serif";
          context.fillText("Date of birth  01 JAN 1990", 265, 260);
          context.fillText("ID No.  1234 5678 9012", 265, 295);
          context.fillText("Address  Manila, Philippines", 265, 330);
          context.fillRect(265, 350, 280, 4);
          context.fillRect(265, 375, 220, 4);
          context.fillRect(265, 400, 310, 4);
        }
        if (showFace) {
          context.fillStyle = "#c99168";
          context.beginPath();
          context.ellipse(320, 300, 145, 185, 0, 0, Math.PI * 2);
          context.fill();
          context.fillStyle = "#38291f";
          context.beginPath();
          context.ellipse(270, 270, 14, 10, 0, 0, Math.PI * 2);
          context.ellipse(370, 270, 14, 10, 0, 0, Math.PI * 2);
          context.fill();
          context.strokeStyle = "#70452f";
          context.lineWidth = 9;
          context.beginPath();
          context.arc(320, 350, 45, 0.2, Math.PI - 0.2);
          context.stroke();
        }
        const stream = canvas.captureStream(15);
        for (const track of stream.getVideoTracks()) {
          const getSettings = track.getSettings.bind(track);
          Object.defineProperty(track, "getSettings", {
            configurable: true,
            value: () => ({
              ...getSettings(),
              deviceId: `fake-${selectedFacing}`,
              facingMode: selectedFacing,
            }),
          });
        }
        return stream;
      },
    });
    Object.defineProperty(devices, "enumerateDevices", {
      configurable: true,
      value: async () => [
        { kind: "videoinput", deviceId: "fake-rear", label: "Back Camera" },
        { kind: "videoinput", deviceId: "fake-front", label: "Front Camera" },
      ],
    });
  }, { showIdCard: idCard, showFace: faceOnly, cameraFacing: facing });
}

async function waitForCameraPreview(page, label) {
  const video = page.locator("video");
  await video.waitFor({ state: "visible", timeout: 30000 });
  await page.waitForFunction(
    () => {
      const element = document.querySelector("video");
      return element instanceof HTMLVideoElement && element.videoWidth > 0;
    },
    { timeout: 10000 }
  );
  check(`camera preview active (${label})`, await video.isVisible());
}

async function captureEnrollmentFace(browser, adminState, size) {
  const context = await browser.newContext({
    viewport: size === "desktop" ? DESKTOP : PHONE,
    storageState: adminState,
  });
  await installCameraDenialMock(context);
  const page = await context.newPage();
  observe(page, `admin-face-enrollment-${size}`);
  await page.goto(`${BASE}/users`, { waitUntil: "domcontentloaded" });
  await settle(page);

  const view = page.getByRole("button", { name: /^view$/i }).first();
  check(`unenrolled staff details available (${size})`, await view.isVisible());
  if (!(await view.isVisible())) {
    await context.close();
    return;
  }
  await view.click();
  await page.locator("div.fixed").filter({ hasText: /Print this label/i }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Photo options" }).click();
  const addPhoto = page.getByRole("button", { name: "Add photo", exact: true });
  check(`staff photo enrollment available (${size})`, await addPhoto.isVisible());
  if (!(await addPhoto.isVisible())) {
    await context.close();
    return;
  }
  await addPhoto.click();
  await page.getByRole("button", { name: "Take the photos", exact: true }).waitFor({ state: "visible" });
  await screenshot(page, `${size}/admin/facial-enrollment-ready`);
  await page.getByRole("button", { name: "Take the photos", exact: true }).click();
  await page.getByText(/camera is blocked for this site/i).waitFor({ state: "visible" });
  await screenshot(page, `${size}/admin/facial-enrollment-camera-denied`);
  await context.close();
}

async function captureActiveEnrollment(browser, adminState, size) {
  const context = await browser.newContext({
    viewport: size === "desktop" ? DESKTOP : PHONE,
    storageState: adminState,
  });
  await installFakeCamera(context);
  const page = await context.newPage();
  observe(page, `admin-face-enrollment-active-${size}`);
  await page.goto(`${BASE}/users`, { waitUntil: "domcontentloaded" });
  await settle(page);
  await page.getByRole("button", { name: /^view$/i }).first().click();
  await page.locator("div.fixed").filter({ hasText: /Print this label/i }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Photo options" }).click();
  await page.getByRole("button", { name: "Add photo", exact: true }).click();
  await page.getByRole("button", { name: "Take the photos", exact: true }).click();
  await waitForCameraPreview(page, `enrollment ${size}`);
  await page.waitForTimeout(600);
  await screenshot(page, `${size}/admin/facial-enrollment-camera-active`);
  await context.close();
}

async function openStaffDetails(page, username = "barista1") {
  await page.goto(`${BASE}/users`, { waitUntil: "domcontentloaded" });
  await settle(page);
  await page.getByRole("textbox", { name: "Search accounts by name or username" }).fill(username);
  const view = page.getByRole("button", { name: /^view$/i }).first();
  check(`staff details available (${username})`, await view.isVisible());
  if (!(await view.isVisible())) return false;
  await view.click();
  await page.locator("div.fixed").filter({ hasText: /Print this label/i }).waitFor({ state: "visible" });
  return true;
}

async function captureIdEnrollment(browser, adminState, size) {
  const context = await browser.newContext({
    viewport: size === "desktop" ? DESKTOP : PHONE,
    storageState: adminState,
  });
  await installCameraDenialMock(context);
  const page = await context.newPage();
  observe(page, `admin-id-enrollment-${size}`);
  if (!(await openStaffDetails(page))) {
    await context.close();
    return;
  }

  const verify = page.getByRole("button", { name: /^(verify|replace) id$/i });
  check(`ID enrollment available (${size})`, await verify.isVisible());
  if (!(await verify.isVisible())) {
    await context.close();
    return;
  }
  await verify.click();
  await page.getByRole("heading", { name: /Verify ID —/i }).waitFor({ state: "visible" });
  await screenshot(page, `${size}/admin/id-enrollment-ready`);
  const front = page.locator('section[aria-labelledby="id-front-label"]');
  await front.getByRole("button", { name: "Use camera" }).click();
  await page.getByText(/camera.*(blocked|denied)|permission.*camera/i).first().waitFor({
    state: "visible",
    timeout: 10000,
  });
  await screenshot(page, `${size}/admin/id-enrollment-camera-denied`);
  await context.close();
}

async function captureActiveIdEnrollment(browser, adminState, size, facing = "rear") {
  const context = await browser.newContext({
    viewport: size === "desktop" ? DESKTOP : PHONE,
    storageState: adminState,
  });
  await installFakeCamera(context, { idCard: true, facing });
  const page = await context.newPage();
  observe(page, `admin-id-enrollment-active-${size}`);
  if (!(await openStaffDetails(page))) {
    await context.close();
    return;
  }
  await page.getByRole("button", { name: /^(verify|replace) id$/i }).click();
  await page.getByRole("heading", { name: /Verify ID —/i }).waitFor({ state: "visible" });
  const front = page.locator('section[aria-labelledby="id-front-label"]');
  await front.getByRole("button", { name: "Use camera" }).click();
  await waitForCameraPreview(page, `ID enrollment ${size}`);
  await page.waitForTimeout(350);
  await screenshot(page, `${size}/admin/id-enrollment-camera-active`);
  if (facing === "rear" && await front.getByLabel("ID camera").isVisible()) {
    check(
      `ID enrollment lists available cameras (${size})`,
      await front.getByLabel("ID camera").locator('option[value^="fake-"]').count() === 2
    );
    await front.getByLabel("ID camera").selectOption("fake-front");
    await front.getByText(/automatic scanning is active on this camera/i).waitFor({
      state: "visible",
    });
    await front.getByLabel("ID camera").selectOption("fake-rear");
  }
  await front.getByRole("button", { name: "Use this ID", exact: true }).waitFor({
    state: "visible",
    timeout: 30000,
  });
  check(
    `ID auto-scans a ${facing} camera and pauses for confirmation (${size})`,
    await front.getByRole("button", { name: "Use this ID", exact: true }).isVisible()
  );
  await screenshot(page, `${size}/admin/id-enrollment-${facing}-capture-review`);
  await front.getByRole("button", { name: "Use this ID", exact: true }).click();
  await front.getByRole("button", { name: "Remove", exact: true }).waitFor({
    state: "visible",
    timeout: 10000,
  });
  await screenshot(page, `${size}/admin/id-enrollment-captured`);
  await context.close();
}

async function captureFrontCameraIdEnrollment(browser, adminState, size) {
  const context = await browser.newContext({
    viewport: size === "desktop" ? DESKTOP : PHONE,
    storageState: adminState,
  });
  await installFakeCamera(context, { faceOnly: true, facing: "user" });
  const page = await context.newPage();
  observe(page, `admin-id-enrollment-front-camera-${size}`);
  if (!(await openStaffDetails(page))) {
    await context.close();
    return;
  }
  await page.getByRole("button", { name: /^(verify|replace) id$/i }).click();
  const front = page.locator('section[aria-labelledby="id-front-label"]');
  await front.getByRole("button", { name: "Use camera" }).click();
  await waitForCameraPreview(page, `ID enrollment front-camera fallback ${size}`);
  await front.getByText(/automatic scanning is active on this camera/i).waitFor({
    state: "visible",
  });
  await front.getByText(/looking for the whole id card|card not detected yet/i).first().waitFor({
    state: "visible",
    timeout: 10000,
  });
  await page.waitForTimeout(7000);
  check(
    `front webcam scans but rejects a face-only frame (${size})`,
    await front.getByRole("button", { name: "Use this ID", exact: true }).count() === 0
  );
  if (await front.getByLabel("ID camera").isVisible()) {
    await front.getByLabel("ID camera").selectOption("fake-rear");
    await page.waitForTimeout(7000);
    check(
      `rear-camera face-only frame is rejected (${size})`,
      await front.getByRole("button", { name: "Use this ID", exact: true }).count() === 0
    );
    await front.getByLabel("ID camera").selectOption("fake-front");
    await front.getByText(/automatic scanning is active on this camera/i).waitFor({
      state: "visible",
    });
  }
  await front.getByRole("button", { name: "Capture manually", exact: true }).click();
  await front.getByRole("button", { name: "Use this ID", exact: true }).waitFor({
    state: "visible",
    timeout: 5000,
  });
  await screenshot(page, `${size}/admin/id-enrollment-front-camera-review`);
  await front.getByRole("button", { name: "Retake", exact: true }).click();
  await waitForCameraPreview(page, `ID enrollment retake ${size}`);
  check(
    `retake does not keep the unconfirmed face image (${size})`,
    await front.getByRole("button", { name: "Use this ID", exact: true }).count() === 0
  );
  await context.close();
}

async function captureIdReview(browser, adminState, size) {
  const context = await browser.newContext({
    viewport: size === "desktop" ? DESKTOP : PHONE,
    storageState: adminState,
  });
  const page = await context.newPage();
  observe(page, `admin-id-review-${size}`);
  let staffId = null;
  await page.route("**/api/users", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    const staff = (data.users ?? []).find((user) => user.username === "barista1");
    if (staff) {
      staffId = staff.id;
      staff.id_doc_type = "philsys";
      staff.id_doc_number = "1234 5678 9012";
      staff.verification_status = "unverified";
    }
    await route.fulfill({ response, body: JSON.stringify(data) });
  });
  await page.route("**/api/users/*/id/status", async (route) => {
    const user = {
      id: staffId,
      full_name: "Juan Dela Cruz",
      username: "barista1",
      verification_status: "unverified",
      id_doc_type: "philsys",
      id_doc_number: "1234 5678 9012",
      verification_notes: null,
      verified_at: null,
      has_front: true,
      has_back: true,
      has_photo: true,
    };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        user,
        signals: [
          {
            id: "card_aspect",
            label: "ID image",
            tone: "pass",
            detail: "1600x1000px, a shape consistent with an ID card.",
          },
          {
            id: "portrait_match",
            label: "Portrait comparison",
            tone: "warn",
            detail: "Compare the ID portrait and staff photo before deciding.",
          },
        ],
        fields: { full_name: "Juan Dela Cruz", id_number: "1234 5678 9012" },
        providers: [{ id: "local-ocr", label: "Local OCR" }],
      }),
    });
  });
  await page.route(/\/api\/users\/[^/]+\/id\?part=(front|back|photo)/, async (route) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect width="640" height="400" rx="24" fill="#f4ead1"/><rect x="28" y="28" width="584" height="344" rx="18" fill="none" stroke="#a98a58" stroke-width="8"/><rect x="55" y="70" width="135" height="170" fill="#735f43"/><text x="220" y="110" font-size="28" fill="#30291f">ID DOCUMENT</text><text x="220" y="170" font-size="25" fill="#30291f">Juan Dela Cruz</text><path d="M220 210h320M220 245h270M220 280h300" stroke="#735f43" stroke-width="8"/></svg>`;
    await route.fulfill({ status: 200, contentType: "image/svg+xml", body: svg });
  });

  await page.goto(`${BASE}/users`, { waitUntil: "domcontentloaded" });
  await settle(page);
  await page.getByRole("textbox", { name: "Search accounts by name or username" }).fill("barista1");
  await page.getByRole("button", { name: /^view$/i }).first().click();
  await page.locator("div.fixed").filter({ hasText: /Print this label/i }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "View & decide" }).click();
  await page.getByText("Scan and verification checks").waitFor({ state: "visible" });
  await screenshot(page, `${size}/admin/id-review`);
  await context.close();
}

async function captureStaffCheck(browser, size) {
  const context = await browser.newContext({
    viewport: size === "desktop" ? DESKTOP : PHONE,
  });
  await installCameraDenialMock(context);
  const page = await context.newPage();
  observe(page, `staff-face-step-${size}`);
  await page.route("**/api/auth/staff", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        step2_required: true,
        ticket: "ui-capture-ticket",
        full_name: "Demo Staff",
      }),
    })
  );
  await setLoginMode(page, "staff");
  await page.getByPlaceholder("Type username or scan barcode").fill("demo-staff");
  await page.getByPlaceholder("Password").fill("capture-only");
  await page.getByRole("button", { name: /^login$/i }).click();
  await page.getByRole("heading", { name: "Hello Demo" }).waitFor({ state: "visible" });
  await settle(page);
  await screenshot(page, `${size}/staff/facial-step-two-ready`);
  await page.getByRole("button", { name: "Open the camera" }).click();
  await page.getByText(/camera is blocked for this site/i).waitFor({ state: "visible" });
  await screenshot(page, `${size}/staff/facial-step-two-camera-denied`);
  await page.getByRole("button", { name: "ID card" }).click();
  await page.getByRole("button", { name: "Open the camera" }).click();
  await page.getByText(/camera is blocked for this site/i).waitFor({ state: "visible" });
  await screenshot(page, `${size}/staff/id-card-sign-in-camera-denied`);
  await context.close();
}

async function captureActiveStaffCheck(browser, size) {
  const context = await browser.newContext({
    viewport: size === "desktop" ? DESKTOP : PHONE,
  });
  await installFakeCamera(context);
  const page = await context.newPage();
  observe(page, `staff-face-step-active-${size}`);
  await page.route("**/api/auth/staff", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        step2_required: true,
        ticket: "ui-capture-ticket",
        full_name: "Demo Staff",
      }),
    })
  );
  await setLoginMode(page, "staff");
  await page.getByPlaceholder("Type username or scan barcode").fill("demo-staff");
  await page.getByPlaceholder("Password").fill("capture-only");
  await page.getByRole("button", { name: /^login$/i }).click();
  await page.getByRole("heading", { name: "Hello Demo" }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Open the camera" }).click();
  await waitForCameraPreview(page, `sign-in ${size}`);
  await page.waitForTimeout(600);
  await screenshot(page, `${size}/staff/facial-step-two-camera-active`);
  await context.close();
}

async function captureIdStaffCheck(browser, size) {
  const context = await browser.newContext({
    viewport: size === "desktop" ? DESKTOP : PHONE,
  });
  await installFakeCamera(context, { idCard: true });
  const page = await context.newPage();
  observe(page, `staff-id-step-${size}`);
  let confirmAttempts = 0;
  await page.route("**/api/auth/staff", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        step2_required: true,
        ticket: "ui-capture-ticket",
        full_name: "Demo Staff",
      }),
    })
  );
  await page.route("**/api/auth/staff/id-image?*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ image: null }),
    })
  );
  await page.route("**/api/auth/staff/confirm", (route) => {
    confirmAttempts++;
    return route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ error: "That did not match." }),
    });
  });

  await setLoginMode(page, "staff");
  await page.getByPlaceholder("Type username or scan barcode").fill("demo-staff");
  await page.getByPlaceholder("Password").fill("capture-only");
  await page.getByRole("button", { name: /^login$/i }).click();
  await page.getByRole("heading", { name: "Hello Demo" }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "ID card" }).click();
  await page.getByRole("button", { name: "Open the camera" }).click();
  await waitForCameraPreview(page, `ID sign-in ${size}`);
  await page.getByRole("progressbar", { name: "ID steadiness" }).waitFor({ state: "visible" });
  await page.waitForTimeout(250);
  await screenshot(page, `${size}/staff/id-card-sign-in-camera-active`);
  await page.getByRole("button", { name: "Capture ID now" }).waitFor({
    state: "visible",
    timeout: 15000,
  });
  await page.getByText(/That did not match\./).waitFor({
    state: "visible",
    timeout: 15000,
  });
  await page.waitForTimeout(500);
  check(`ID sign-in submits one scan (${size})`, confirmAttempts === 1, `${confirmAttempts} submission(s)`);
  await screenshot(page, `${size}/staff/id-card-sign-in-retry`);
  await context.close();
}

async function captureEnrolledVerify(browser, storageState, size) {
  const context = await browser.newContext({
    viewport: size === "desktop" ? DESKTOP : PHONE,
    storageState,
  });
  await installCameraDenialMock(context);
  const page = await context.newPage();
  observe(page, `verify-enrolled-${size}`);
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        user: { role: "staff" },
        face: {
          required: true,
          enabled: true,
          enrolled: true,
          dutyHours: 9,
          verifiedAt: null,
          nextDueAt: null,
        },
      }),
    })
  );
  await capture(page, `${size}/staff/verify-enrolled-ready`, "/verify", "/verify");
  await page.getByRole("button", { name: /turn on the camera/i }).click();
  await page.getByText(/this browser will not ask again once it is blocked/i).waitFor({ state: "visible" });
  await screenshot(page, `${size}/staff/verify-enrolled-camera-denied`);
  await context.close();
}

async function captureActiveVerify(browser, storageState, size) {
  const context = await browser.newContext({
    viewport: size === "desktop" ? DESKTOP : PHONE,
    storageState,
  });
  await installFakeCamera(context);
  const page = await context.newPage();
  observe(page, `verify-enrolled-active-${size}`);
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        user: { role: "staff" },
        face: {
          required: true,
          enabled: true,
          enrolled: true,
          dutyHours: 9,
          verifiedAt: null,
          nextDueAt: null,
        },
      }),
    })
  );
  await page.goto(`${BASE}/verify`, { waitUntil: "domcontentloaded" });
  await settle(page);
  await page.getByRole("button", { name: /turn on the camera/i }).click();
  await waitForCameraPreview(page, `duty check ${size}`);
  await page.waitForTimeout(600);
  await screenshot(page, `${size}/staff/verify-enrolled-camera-active`);
  await context.close();
}

async function captureAddItemDialog(page, size) {
  await page.goto(`${BASE}/items`, { waitUntil: "domcontentloaded" });
  await settle(page);
  const add = page.getByRole("button", { name: /^add item$/i }).first();
  check(`items add form available (${size})`, await add.isVisible());
  if (!(await add.isVisible())) return;
  await add.click();
  await page.getByRole("heading", { name: /^add item$/i }).waitFor({ state: "visible" });
  await screenshot(page, `${size}/admin/items-add-form`);

  const modal = page
    .locator("div.fixed.inset-0")
    .filter({ has: page.getByRole("heading", { name: /^add item$/i }) })
    .first();
  const { scrollHeight, clientHeight } = await modal.evaluate((element) => ({
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
  }));
  let part = 1;
  for (let top = clientHeight; top < scrollHeight; top += clientHeight) {
    await modal.evaluate((element, scrollTop) => element.scrollTo(0, scrollTop), top);
    await page.waitForTimeout(200);
    part++;
    await screenshot(
      page,
      `${size}/admin/items-add-form-part-${String(part).padStart(2, "0")}`
    );
  }
}

async function captureUserDetails(page, size) {
  await page.goto(`${BASE}/users`, { waitUntil: "domcontentloaded" });
  await settle(page);
  const view = page.getByRole("button", { name: /^view$/i }).first();
  check(`user details available (${size})`, await view.isVisible());
  if (!(await view.isVisible())) return;
  await view.click();
  await page.locator("div.fixed").filter({ hasText: /Print this label/i }).waitFor({ state: "visible" });
  await screenshot(page, `${size}/admin/users-details`);
}

async function captureEmailRecipientForm(page, size) {
  await page.goto(`${BASE}/email`, { waitUntil: "domcontentloaded" });
  await settle(page);
  const add = page.getByRole("button", { name: /^add recipient$/i }).first();
  check(`email recipient form available (${size})`, await add.isVisible());
  if (!(await add.isVisible())) return;
  await add.click();
  await page.getByRole("heading", { name: /^add recipient$/i }).waitFor({ state: "visible" });
  await screenshot(page, `${size}/admin/email-add-recipient`);
}

async function captureMobileMenu(page, role) {
  await page.goto(`${BASE}/dashboard`, { waitUntil: "domcontentloaded" });
  await settle(page);
  const menu = page.getByRole("button", { name: "Open menu" });
  check(`${role} phone menu available`, await menu.isVisible());
  if (!(await menu.isVisible())) return;
  await menu.click();
  await page.getByRole("button", { name: "Close menu" }).waitFor({ state: "visible" });
  await screenshot(page, `mobile/${role}/menu-open`);
}

await assertTestTarget(BASE);

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  console.log(`Capturing CafeTrack UI against ${BASE}`);

  await captureLoginModes(await browser.newContext({ viewport: DESKTOP }), "desktop");
  await captureLoginModes(await browser.newContext({ viewport: PHONE }), "mobile");

  const adminContext = await browser.newContext({ viewport: DESKTOP });
  const adminPage = adminContext.pages()[0] ?? (await adminContext.newPage());
  observe(adminPage, "admin-desktop");
  await signInAdmin(adminPage);

  const seedData = await adminPage.evaluate(async () => {
    const [usersResponse, alertsResponse] = await Promise.all([
      fetch("/api/users"),
      fetch("/api/alerts?status=all&limit=1"),
    ]);
    const [users, alerts] = await Promise.all([usersResponse.json(), alertsResponse.json()]);
    return {
      staff: (users.users ?? []).find((user) => user.username === "barista1" && user.is_active),
      alertId: alerts.alerts?.[0]?.id ?? null,
    };
  });
  check("seeded active staff account available", Boolean(seedData.staff?.qr_token));
  check("alert detail record available", Boolean(seedData.alertId));

  const adminState = await adminContext.storageState();
  const adminPhoneContext = await browser.newContext({ viewport: PHONE, storageState: adminState });
  const adminPhone = await adminPhoneContext.newPage();
  observe(adminPhone, "admin-mobile");

  const adminRoutes = [
    "/",
    "/dashboard",
    "/checkout",
    "/items",
    "/approvals",
    "/alerts",
    "/reports",
    "/users",
    "/settings",
    "/audit",
    "/email",
    "/history",
  ];
  await captureRouteSet(adminPage, "desktop", "admin", adminRoutes, seedData.alertId);
  await captureRouteSet(adminPhone, "mobile", "admin", adminRoutes, seedData.alertId);

  await captureAddItemDialog(adminPage, "desktop");
  await captureAddItemDialog(adminPhone, "mobile");
  await captureUserDetails(adminPage, "desktop");
  await captureUserDetails(adminPhone, "mobile");
  await captureEmailRecipientForm(adminPage, "desktop");
  await captureEmailRecipientForm(adminPhone, "mobile");
  await captureMobileMenu(adminPhone, "admin");
  await captureVerifyState(browser, adminState, "desktop");
  await captureVerifyState(browser, adminState, "mobile");
  await captureEnrollmentFace(browser, adminState, "desktop");
  await captureEnrollmentFace(browser, adminState, "mobile");
  await captureActiveEnrollment(browser, adminState, "desktop");
  await captureActiveEnrollment(browser, adminState, "mobile");
  await captureIdEnrollment(browser, adminState, "desktop");
  await captureIdEnrollment(browser, adminState, "mobile");
  await captureActiveIdEnrollment(browser, adminState, "desktop");
  await captureActiveIdEnrollment(browser, adminState, "mobile");
  await captureActiveIdEnrollment(browser, adminState, "desktop", "user");
  await captureActiveIdEnrollment(browser, adminState, "mobile", "unknown");
  await captureFrontCameraIdEnrollment(browser, adminState, "desktop");
  await captureFrontCameraIdEnrollment(browser, adminState, "mobile");
  await captureIdReview(browser, adminState, "desktop");
  await captureIdReview(browser, adminState, "mobile");
  await captureEnrolledVerify(browser, adminState, "desktop");
  await captureEnrolledVerify(browser, adminState, "mobile");
  await captureActiveVerify(browser, adminState, "desktop");
  await captureActiveVerify(browser, adminState, "mobile");
  await captureStaffCheck(browser, "desktop");
  await captureStaffCheck(browser, "mobile");
  await captureActiveStaffCheck(browser, "desktop");
  await captureActiveStaffCheck(browser, "mobile");
  await captureIdStaffCheck(browser, "desktop");
  await captureIdStaffCheck(browser, "mobile");

  const staffContext = await browser.newContext({ viewport: DESKTOP });
  const staffPage = await staffContext.newPage();
  observe(staffPage, "staff-desktop");
  if (seedData.staff?.qr_token) {
    await signInStaff(staffPage, seedData.staff.qr_token);
    const staffState = await staffContext.storageState();
    const staffPhoneContext = await browser.newContext({ viewport: PHONE, storageState: staffState });
    const staffPhone = await staffPhoneContext.newPage();
    observe(staffPhone, "staff-mobile");

    const staffRoutes = [
      "/dashboard",
      "/checkout",
      "/items",
      "/approvals",
      "/alerts",
      "/reports",
      "/history",
    ];
    await captureRouteSet(staffPage, "desktop", "staff", staffRoutes, seedData.alertId);
    await captureRouteSet(staffPhone, "mobile", "staff", staffRoutes, seedData.alertId);
    await captureMobileMenu(staffPhone, "staff");
    await staffPhoneContext.close();
  }
  await staffContext.close();

  if (runtimeErrors.length) {
    failures += runtimeErrors.length;
    console.error("\nBrowser errors and failed requests:");
    for (const error of runtimeErrors) console.error(`  ${error}`);
  }

  console.log(`\n${captures} screenshots captured; ${failures} issue(s).`);
  if (failures > 0) process.exitCode = 1;
} finally {
  await browser.close();
}
