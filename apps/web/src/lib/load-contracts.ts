import "server-only";
import { api, dataOrThrow } from "./api";
import type { Contract } from "./api-types";

// The dashboards need every milestone of every contract. listContracts returns summaries
// only, so this follows the cursor and then reads each contract: 1 + N calls. Fine for a
// demo-sized account; the contracted answer is GET /inbox (005), which does not exist yet.
const MAX_PAGES = 10;

export async function loadAllContracts(): Promise<Contract[]> {
  const client = await api();
  const ids: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const list = dataOrThrow(await client.GET("/contracts", { params: { query: { cursor } } }));
    ids.push(...list.items.map((c) => c.id));
    if (list.nextCursor == null) break;
    cursor = list.nextCursor;
  }
  return Promise.all(ids.map(async (contractId) => dataOrThrow(await client.GET("/contracts/{contractId}", { params: { path: { contractId } } }))));
}
