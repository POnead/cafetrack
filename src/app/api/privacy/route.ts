import { db } from "@/lib/supabase";
import { handler, ok, fail, readBody, dbFail } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";

export const GET = handler(async () => {
  const user = await requireUser();
  const { data: notice, error } = await db()
    .from("privacy_notices")
    .select("version,title,notice_text,purpose,recipients,storage_period,published_at")
    .order("published_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return dbFail(error);
  const { data: subject } = await db()
    .from("users")
    .select("identity_notice_version,identity_notice_acknowledged_at,identity_processing_basis,identity_basis_reviewed_at,identity_retention_until,identity_data_erased_at,id_doc_type,id_doc_expiry,id_fields,verification_status,verified_at")
    .eq("id", user.id)
    .maybeSingle();

  return ok({
    notice: notice ?? null,
    acknowledgement: subject ?? null,
    identity: subject ? {
      documentType: subject.id_doc_type,
      documentExpiry: subject.id_doc_expiry,
      extractedFields: subject.id_fields,
      verificationStatus: subject.verification_status,
      verifiedAt: subject.verified_at,
      hasIdDocument: Boolean(subject.id_doc_type),
    } : null,
  });
});

export const POST = handler(async (req: Request) => {
  const user = await requireUser();
  const body = await readBody(req);
  const noticeVersion = String(body.noticeVersion ?? "").trim();
  const basis = String(body.basis ?? "").trim();
  const allowed = new Set(["consent", "contract", "legal_obligation", "public_interest", "legitimate_interest"]);

  if (!noticeVersion || !allowed.has(basis)) {
    return fail("Provide a notice version and lawful basis");
  }

  const { data: notice } = await db()
    .from("privacy_notices")
    .select("version")
    .eq("version", noticeVersion)
    .maybeSingle();
  if (!notice) return fail("Unknown privacy notice version", 404);

  const now = new Date().toISOString();
  const { error } = await db()
    .from("users")
    .update({
      identity_notice_version: noticeVersion,
      identity_notice_acknowledged_at: now,
      identity_processing_basis: basis,
      identity_basis_reviewed_at: now,
      identity_retention_until: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    })
    .eq("id", user.id);

  if (error) return dbFail(error);
  await audit(
    user,
    "IDENTITY_PRIVACY_ACKNOWLEDGE",
    "user",
    user.id,
    { notice_version: noticeVersion, lawful_basis: basis },
    { ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null }
  );
  return ok({ acknowledged: true, noticeVersion, basis });
});
