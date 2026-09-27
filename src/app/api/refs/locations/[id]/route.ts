import { handler, ok, badId } from "@/lib/api";
import { deleteRef } from "@/lib/ref-delete";

export const runtime = "nodejs";

export const DELETE = handler(
  async (_req: Request, { params }: { params: { id: string } }) => {
    const malformed = badId(params.id, "location");
    if (malformed) return malformed;

    const failed = await deleteRef({
      table: "locations",
      column: "location_id",
      id: params.id,
      label: "location",
      noun: "location",
      action: "LOCATION_DELETE",
    });
    if (failed) return failed;

    return ok({ ok: true });
  }
);
