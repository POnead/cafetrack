import {
  renderPasswordRecoveryHtml,
  renderQueuedEmailHtml,
  renderSmtpVerificationHtml,
} from "../src/lib/email-templates.ts";

let passed = 0;
let failed = 0;

function check(label, condition) {
  if (condition) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}`);
  }
}

function checkBrandedLayout(label, html) {
  check(
    `${label} uses the responsive branded email layout`,
    /role="presentation"/i.test(html) &&
      /width:100%;max-width:600px/i.test(html) &&
      /font-family:Arial,Helvetica,sans-serif/i.test(html) &&
      /cid:merrylane-logo/i.test(html) &&
      /CAFETRACK INVENTORY SYSTEM/i.test(html)
  );
}

checkBrandedLayout("SMTP verification", renderSmtpVerificationHtml());
checkBrandedLayout("password recovery", renderPasswordRecoveryHtml("123456"));
checkBrandedLayout(
  "low-stock alert",
  renderQueuedEmailHtml("low_stock", "CafeTrack: Low Stock", "Coffee <beans> are low")
);
checkBrandedLayout(
  "out-of-stock alert",
  renderQueuedEmailHtml("out_of_stock", "CafeTrack: Out of Stock", "Coffee is out of stock")
);
checkBrandedLayout(
  "near-expiry alert",
  renderQueuedEmailHtml("near_expiry", "CafeTrack: Near Expiry", "Milk expires soon")
);
checkBrandedLayout(
  "expired-stock alert",
  renderQueuedEmailHtml("expired", "CafeTrack: Expired", "Milk has expired")
);
checkBrandedLayout(
  "daily summary",
  renderQueuedEmailHtml("daily_summary", "CafeTrack daily summary", "Movements: 3")
);
checkBrandedLayout(
  "failed-login warning",
  renderQueuedEmailHtml("failed_login", "CafeTrack: rejected sign-in attempt", "A sign-in attempt was rejected.")
);
checkBrandedLayout(
  "automated stock report",
  renderQueuedEmailHtml("report", "CafeTrack Stock Report", "Items included: 4")
);
checkBrandedLayout(
  "unknown queued system message",
  renderQueuedEmailHtml("future_kind", "CafeTrack notification", "A system update")
);

check(
  "stock alerts retain the item message and supplier contact details",
  renderQueuedEmailHtml(
    "low_stock",
    "CafeTrack: Low Stock",
    "Beans are low (low_stock)\n\nSupplier: Merrylane Supply\n  phone: 09170000000"
  ).includes("Merrylane Supply") &&
    renderQueuedEmailHtml(
      "low_stock",
      "CafeTrack: Low Stock",
      "Beans are low (low_stock)\n\nSupplier: Merrylane Supply\n  phone: 09170000000"
    ).includes("09170000000")
);
check(
  "the daily summary retains its movement and open-alert counts",
  renderQueuedEmailHtml(
    "daily_summary",
    "CafeTrack daily summary",
    "Movements: 3\n  checked out: 2\nStill open: 1"
  ).includes("checked out") &&
    renderQueuedEmailHtml(
      "daily_summary",
      "CafeTrack daily summary",
      "Movements: 3\n  checked out: 2\nStill open: 1"
    ).includes("Still open")
);
check(
  "the failed-login alert retains the reason and recommended action",
  renderQueuedEmailHtml(
    "failed_login",
    "CafeTrack: rejected sign-in attempt",
    "A sign-in attempt was rejected.\n  method: admin_login\n  reason: invalid password\n\nIf this was not you, change the password for that account."
  ).includes("invalid password") &&
    renderQueuedEmailHtml(
      "failed_login",
      "CafeTrack: rejected sign-in attempt",
      "A sign-in attempt was rejected.\n  method: admin_login\n  reason: invalid password\n\nIf this was not you, change the password for that account."
    ).includes("change the password")
);
check(
  "the automated report retains its filters and PDF attachment notice",
  renderQueuedEmailHtml(
    "report",
    "CafeTrack Stock Report",
    "Filters: dates and category\nThe complete inventory and movement report is attached as a PDF."
  ).includes("dates and category") &&
    renderQueuedEmailHtml(
      "report",
      "CafeTrack Stock Report",
      "Filters: dates and category\nThe complete inventory and movement report is attached as a PDF."
    ).includes("attached as a PDF")
);

const escapedAlert = renderQueuedEmailHtml(
  "low_stock",
  "CafeTrack: <stock>",
  'Milk <script>alert("x")</script> & cream are low\n\nSupplier: <b>One & Co</b>'
);
check(
  "user-provided alert and supplier values are HTML-escaped",
  escapedAlert.includes("Milk &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; cream") &&
    escapedAlert.includes("&lt;b&gt;One &amp; Co&lt;/b&gt;") &&
    !escapedAlert.includes("<script>") &&
    !escapedAlert.includes("<b>One")
);

const escapedReport = renderQueuedEmailHtml(
  "report",
  "CafeTrack <report>",
  "Staff: Ana <Admin>\nFilters: category & movement"
);
check(
  "automated report details and subject are HTML-escaped",
  escapedReport.includes("Ana &lt;Admin&gt;") &&
    escapedReport.includes("category &amp; movement") &&
    escapedReport.includes("CafeTrack &lt;report&gt;")
);

const escapedCode = renderPasswordRecoveryHtml("<123456>");
check(
  "password recovery code is HTML-escaped",
  escapedCode.includes("&lt;123456&gt;") && !escapedCode.includes("<123456>")
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
