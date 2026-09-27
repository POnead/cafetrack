import { handler, ok, badId } from "@/lib/api";
import { deleteRef } from "@/lib/ref-delete";

export const runtime = "nodejs";

// Next 15 delivers route `params` as a Promise, so it is awaited once here and
// the resolved id is used for the rest of the handler.
export const DELETE = handler(
  async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;

    const malformed = badId(id, "category");
    if (malformed) return malformed;

    const failed = await deleteRef({
      table: "categories",
      column: "category_id",
      id,
      label: "category",
      noun: "category",
      action: "CATEGORY_DELETE",
    });
    if (failed) return failed;

    return ok({ ok: true });
  }
);
