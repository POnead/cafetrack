import { GET as itemsGET } from "@/app/api/items/route";
import { GET as transactionsGET } from "@/app/api/transactions/route";
import DashboardClient, {
  type Item,
  type Txn,
} from "./DashboardClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The dashboard's first paint.
 *
 * The interactive half is a client component that used to sit behind a
 * full-screen spinner while the browser downloaded its JavaScript and then
 * fetched the two read paths it needs. Here the same two requests — the very
 * same handlers, called in-process rather than over HTTP — run during the
 * server render, and their answers are embedded in the HTML the browser
 * paints. There is exactly one definition of what an item list or a movement
 * history is (the route handlers), so the snapshot cannot drift from the API.
 *
 * If either call fails the page still renders: the client simply falls back
 * to fetching for itself, exactly as it did before — the snapshot is an
 * optimisation, never a requirement.
 */
export default async function DashboardPage() {
  const snapshot = await loadSnapshot();
  return <DashboardClient {...snapshot} />;
}

type Snapshot = {
  initialItems?: Item[];
  initialTransactions?: Txn[];
};

async function loadSnapshot(): Promise<Snapshot> {
  try {
    const [itemsRes, txnsRes] = await Promise.all([
      itemsGET(new Request("http://localhost/api/items")),
      transactionsGET(
        new Request("http://localhost/api/transactions?limit=200")
      ),
    ]);

    if (!itemsRes.ok || !txnsRes.ok) {
      console.error(
        `dashboard snapshot unavailable (items ${itemsRes.status}, transactions ${txnsRes.status})`
      );
      return {};
    }

    const [items, txns] = await Promise.all([
      itemsRes.json(),
      txnsRes.json(),
    ]);

    if (!Array.isArray(items?.items) || !Array.isArray(txns?.transactions)) {
      console.error("dashboard snapshot returned an unexpected shape");
      return {};
    }

    return {
      initialItems: items.items,
      initialTransactions: txns.transactions,
    };
  } catch (error) {
    console.error("dashboard snapshot failed:", error);
    return {};
  }
}
