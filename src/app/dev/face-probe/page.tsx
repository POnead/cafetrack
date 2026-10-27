import { notFound } from "next/navigation";
import FaceProbe from "@/components/FaceProbe";

export const dynamic = "force-dynamic";

/**
 * `/dev/face-probe` — a measurement page, not a feature.
 *
 * Gated twice: a production build hides it unless `CAFETRACK_FACE_PROBE=1` is set
 * on the server, and even then it renders nothing but the probe. It reads no
 * database, needs no session, and cannot change any state, so leaving it reachable
 * on a staging box costs nothing.
 *
 * The reason it is a page at all: the models are onnxruntime-web and face-api,
 * both of which need a real browser with a real canvas. A Node-side test could not
 * run them without reimplementing the pipeline it is supposed to be testing.
 */
export default function Page() {
  const enabled =
    process.env.NODE_ENV !== "production" || process.env.CAFETRACK_FACE_PROBE === "1";

  if (!enabled) notFound();

  return <FaceProbe />;
}
