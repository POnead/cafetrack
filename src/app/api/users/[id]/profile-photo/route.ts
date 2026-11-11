import { db } from "@/lib/supabase";
import { audit } from "@/lib/audit";
import { badId, fail, handler, ok, clientIp, dbFail } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { readFaceImage } from "@/lib/face-image";

export const runtime = "nodejs";

export const GET = handler(
  async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
    await requireAdmin();
    const { id } = await params;
    const malformed = badId(id, "user");
    if (malformed) return malformed;

    const { data, error } = await db()
      .from("users")
      .select("profile_photo_data")
      .eq("id", id)
      .maybeSingle();

    if (error) return dbFail(error);
    if (!data) return fail("User not found", 404);

    const stored = String(data.profile_photo_data ?? "");
    const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(stored);
    if (!match) return fail("No staff profile photo uploaded", 404);

    return new Response(Buffer.from(match[2], "base64"), {
      headers: {
        "Content-Type": match[1],
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
);

export const POST = handler(
  async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const admin = await requireAdmin();
    const { id } = await params;
    const malformed = badId(id, "user");
    if (malformed) return malformed;

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return fail("Choose a JPEG, PNG or WebP profile photo and try again.", 400);
    }

    const image = await readFaceImage(form.get("photo"), {
      maxBytes: 2 * 1024 * 1024,
      purpose: "profile photo",
    });
    if (!image.ok) return fail(image.message, 400);

    const updatedAt = new Date().toISOString();
    const { data, error } = await db()
      .from("users")
      .update({
        profile_photo_data: image.dataUrl,
        profile_photo_updated_at: updatedAt,
      })
      .eq("id", id)
      .select("id, username, full_name")
      .maybeSingle();

    if (error) return dbFail(error);
    if (!data) return fail("User not found", 404);

    await audit(
      admin,
      "STAFF_PROFILE_PHOTO_UPLOAD",
      "user",
      id,
      { username: data.username, full_name: data.full_name, bytes: image.bytes },
      { ip: clientIp(req) }
    );

    return ok({
      profile_photo_url: `/api/users/${id}/profile-photo?v=${encodeURIComponent(updatedAt)}`,
      profile_photo_updated_at: updatedAt,
    });
  }
);

export const DELETE = handler(
  async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const admin = await requireAdmin();
    const { id } = await params;
    const malformed = badId(id, "user");
    if (malformed) return malformed;

    const { data, error } = await db()
      .from("users")
      .update({ profile_photo_data: null, profile_photo_updated_at: null })
      .eq("id", id)
      .select("id, username, full_name")
      .maybeSingle();

    if (error) return dbFail(error);
    if (!data) return fail("User not found", 404);

    await audit(
      admin,
      "STAFF_PROFILE_PHOTO_REMOVE",
      "user",
      id,
      { username: data.username, full_name: data.full_name },
      { ip: clientIp(req) }
    );

    return ok({ profile_photo_url: null });
  }
);
