const ALERT_TITLES: Record<string, string> = {
  low_stock: "Low stock alert",
  out_of_stock: "Out of stock alert",
  near_expiry: "Expiry approaching",
  expired: "Expired stock alert",
};

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character];
  });
}

function detailMarkup(lines: string[]): string {
  const details: Array<[string, string]> = [];
  const paragraphs: string[] = [];

  for (const line of lines) {
    const text = line.trim();
    if (!text) continue;

    const detail = /^([^:]{1,60}):\s*(.*)$/.exec(text);
    if (detail) {
      details.push([detail[1], detail[2]]);
    } else {
      paragraphs.push(
        `<p style="margin:12px 0 0;font-size:14px;line-height:1.6;color:#5f5145;">${escapeHtml(text)}</p>`
      );
    }
  }

  const table = details.length
    ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;margin:8px 0 0;">
        ${details
          .map(
            ([label, value]) => `<tr>
              <td valign="top" style="padding:8px 12px 8px 0;border-bottom:1px solid #eee7dc;font-size:13px;line-height:1.5;color:#80634e;white-space:nowrap;">${escapeHtml(label)}</td>
              <td valign="top" style="padding:8px 0;border-bottom:1px solid #eee7dc;font-size:14px;line-height:1.5;color:#38261c;overflow-wrap:anywhere;">${escapeHtml(value)}</td>
            </tr>`
          )
          .join("")}
      </table>`
    : "";

  return table + paragraphs.join("");
}

function brandedEmail({
  subject,
  preview,
  eyebrow,
  heading,
  intro,
  content,
}: {
  subject: string;
  preview: string;
  eyebrow: string;
  heading: string;
  intro: string;
  content: string;
}): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light">
    <title>${escapeHtml(subject)}</title>
  </head>
  <body style="margin:0;padding:24px 12px;background-color:#f5f1e9;font-family:Arial,Helvetica,sans-serif;color:#38261c;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(preview)}</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;border-collapse:collapse;">
      <tr>
        <td align="center" style="padding:0;">
          <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:600px;border-collapse:collapse;margin:0 auto;">
            <tr>
              <td align="center" style="padding:0 12px 18px;">
                <img src="cid:merrylane-logo" width="220" height="87" alt="Merrylane Cafe" style="display:block;width:220px;max-width:80%;height:auto;margin:0 auto 10px;">
                <div style="font-size:11px;font-weight:bold;letter-spacing:2px;color:#80634e;">CAFETRACK INVENTORY SYSTEM</div>
              </td>
            </tr>
            <tr>
              <td style="padding:28px 32px;background-color:#ffffff;border:1px solid #e8dfd1;border-radius:16px;">
                <div style="font-size:11px;font-weight:bold;letter-spacing:1.5px;color:#9a6d4c;">${escapeHtml(eyebrow)}</div>
                <h1 style="margin:10px 0 8px;font-size:24px;line-height:1.3;color:#38261c;">${escapeHtml(heading)}</h1>
                <p style="margin:0 0 20px;font-size:15px;line-height:1.65;color:#716255;">${escapeHtml(intro)}</p>
                ${content}
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:18px 12px 0;font-size:12px;line-height:1.6;color:#8a7a68;">
                Merrylane Cafe Foodhub<br>
                This is an automated CafeTrack message.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export function renderSmtpVerificationHtml(): string {
  return brandedEmail({
    subject: "CafeTrack: your email is set up",
    preview: "Your CafeTrack email connection is working.",
    eyebrow: "EMAIL SETUP",
    heading: "Email is connected",
    intro: "This is a test message from CafeTrack.",
    content: `<div style="padding:16px 18px;background-color:#f8f4ec;border:1px solid #eee4d5;border-radius:10px;font-size:14px;line-height:1.6;color:#5f5145;">
      If you are reading it, email notifications are working. Nothing else was sent — no alerts, no summary.
    </div>`,
  });
}

export function renderPasswordRecoveryHtml(code: string): string {
  return brandedEmail({
    subject: "CafeTrack admin password reset code",
    preview: "Your CafeTrack password reset code is ready. It expires in 10 minutes.",
    eyebrow: "ACCOUNT SECURITY",
    heading: "Admin password reset",
    intro: "Use this one-time code to verify your password reset.",
    content: `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;background-color:#f8f4ec;border:1px solid #eee4d5;border-radius:12px;">
      <tr><td align="center" style="padding:18px 12px;">
        <div style="font-size:11px;font-weight:bold;letter-spacing:2px;color:#80634e;">YOUR VERIFICATION CODE</div>
        <div style="margin-top:8px;font-size:34px;font-weight:bold;letter-spacing:9px;color:#38261c;">${escapeHtml(code)}</div>
      </td></tr>
    </table>
    <p style="margin:16px 0 0;text-align:center;font-size:13px;line-height:1.6;color:#716255;">Expires in <strong style="color:#38261c;">10 minutes</strong> and can only be used once.</p>
    <div style="margin-top:22px;padding:14px 16px;background-color:#fff8e9;border-left:4px solid #c88955;border-radius:8px;">
      <div style="font-size:13px;font-weight:bold;color:#65472f;">Didn't request this?</div>
      <p style="margin:6px 0 0;font-size:13px;line-height:1.6;color:#715d48;">You can ignore this email. Your password will not change unless this code is verified and the reset is completed. Never share this code with anyone.</p>
    </div>`,
  });
}

export function renderQueuedEmailHtml(kind: string, subject: string, body: string): string {
  const lines = String(body ?? "").slice(0, 20_000).split(/\r?\n/);
  const firstLine = lines.shift()?.trim() ?? "";
  const alertTitle = ALERT_TITLES[kind];

  if (alertTitle) {
    return brandedEmail({
      subject,
      preview: firstLine || alertTitle,
      eyebrow: "INVENTORY ALERT",
      heading: alertTitle,
      intro: firstLine || "An inventory alert needs your attention.",
      content: detailMarkup(lines),
    });
  }

  if (kind === "daily_summary") {
    return brandedEmail({
      subject,
      preview: "Your daily CafeTrack inventory and activity summary.",
      eyebrow: "DAILY OVERVIEW",
      heading: "Your daily summary",
      intro: "A quick look at today's movements, open alerts, and sign-in activity.",
      content: detailMarkup([firstLine, ...lines]),
    });
  }

  if (kind === "failed_login") {
    const action = lines[lines.length - 1]?.trim();
    const details = action?.startsWith("If this was not you,")
      ? lines.slice(0, -1)
      : lines;

    return brandedEmail({
      subject,
      preview: "CafeTrack recorded a rejected sign-in attempt.",
      eyebrow: "ACCOUNT SECURITY",
      heading: "Sign-in security alert",
      intro: firstLine || "A sign-in attempt was rejected.",
      content: `${detailMarkup(details)}
        ${
          action
            ? `<div style="margin-top:20px;padding:14px 16px;background-color:#fff8e9;border-left:4px solid #c88955;border-radius:8px;font-size:13px;line-height:1.6;color:#65472f;">${escapeHtml(action)}</div>`
            : ""
        }`,
    });
  }

  if (kind === "report" || kind === "reports") {
    return brandedEmail({
      subject,
      preview: "Your CafeTrack stock report is attached as a PDF.",
      eyebrow: "STOCK REPORT",
      heading: "Your stock report",
      intro: "The complete inventory and movement report is attached as a PDF.",
      content: `<div style="padding:14px 16px;background-color:#f8f4ec;border:1px solid #eee4d5;border-radius:10px;">
        ${detailMarkup([firstLine, ...lines])}
      </div>`,
    });
  }

  return brandedEmail({
    subject,
    preview: firstLine || subject,
    eyebrow: "CAFETRACK NOTIFICATION",
    heading: subject || "CafeTrack notification",
    intro: firstLine || "You have a new CafeTrack notification.",
    content: detailMarkup(lines),
  });
}
