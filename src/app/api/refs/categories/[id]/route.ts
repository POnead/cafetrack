import { handler, ok, badId } from "@/lib/api";
import { deleteRef } from "@/lib/ref-delete";

export const runtime = "nodejs";

export const DELETE = handler(
  async (_req: Request, { params }: { params: { id: string } }) => {
    const malformed = badId(params.id, "category");
    if (malformed) return malformed;

    const failed = await deleteRef({
      table: "categories",
      column: "category_id",
      id: params.id,
      label: "category",
      noun: "category",
      action: "CATEGORY_DELETE",
    });
    if (failed) return failed;

    return ok({ ok: true });
  }
);
