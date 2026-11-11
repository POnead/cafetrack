import { db } from "@/lib/supabase";
import { handler, ok, fail, dbFail, clientIp } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import {
  deleteFacePlusPlusEnrollment,
  facePlusPlusFaceSetTokens,
} from "@/lib/facepp";

export const runtime = "nodejs";

export const DELETE = handler(async (req: Request) => {
  const user = await requireUser();

  const { data: before, error: lookupError } = await db()
    .from("users")
    .select("facepp_faceset_token, facepp_retired_facesets")
    .eq("id", user.id)
    .maybeSingle();
  if (lookupError) return dbFail(lookupError, { status: 503, context: "identity erase lookup" });
  if (!before) return fail("User not found", 404);

  const faceSets = facePlusPlusFaceSetTokens(
    before.facepp_faceset_token,
    before.facepp_retired_facesets
  );
  const deletedFaceSets = await Promise.all(faceSets.map(deleteFacePlusPlusEnrollment));
  const undeletedFaceSet = deletedFaceSets.find((result) => result.status === "unavailable");
  if (undeletedFaceSet?.status === "unavailable") {
    console.error(
      `Face++ could not remove a privacy-erased FaceSet (${undeletedFaceSet.code}).`
    );
    return fail(
      "Face++ could not remove the stored face reference. Identity data was not erased; try again later.",
      503
    );
  }

  const { error } = await db()
    .from("users")
    .update({
      id_doc_front: null,
      id_doc_back: null,
      id_photo: null,
      id_doc_number: null,
      id_doc_expiry: null,
      id_fields: null,
      id_signals: null,
      face_image: null,
      face_embedding: null,
      facepp_faceset_token: null,
      facepp_face_token: null,
      facepp_retired_facesets: [],
      face_enabled: false,
      verification_status: "unverified",
      verification_notes: null,
      verified_at: null,
      verified_by: null,
      identity_data_erased_at: new Date().toISOString(),
    })
    .eq("id", user.id);
  if (error) return dbFail(error);

  await db().from("user_face_samples").delete().eq("user_id", user.id);
  await audit(
    user,
    "IDENTITY_DATA_ERASE",
    "user",
    user.id,
    { source: "subject_request" },
    { ip: clientIp(req) }
  );
  return ok({ erased: true });
});
