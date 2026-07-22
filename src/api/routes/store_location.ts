// Store location route (multi-tenancy Slice 2, 2026-07-22). Lets a signed-in
// account search for and save its own target Kroger store — the HTTP
// equivalent of the CLI's `recipecart set-store <zip-code>` (src/cli.ts),
// now reachable from the web app since every account needs its own store
// (kroger/store_config.ts is per-user as of this slice) and most accounts
// won't have shell/CLI access at all.
import type { FastifyInstance } from "fastify";
import { getAppToken } from "../../kroger/auth.js";
import { searchLocations } from "../../kroger/client.js";
import { loadStoreLocation, saveStoreLocation, type StoredStoreLocation } from "../../kroger/store_config.js";
import { badRequest, notFound } from "../lib/errors.js";

export default async function storeLocationRoutes(app: FastifyInstance): Promise<void> {
  // GET /store-location — the calling account's currently configured store,
  // if any.
  app.get("/store-location", async (request) => {
    const store = await loadStoreLocation(request.userId);
    if (!store) throw notFound("store location");
    return store;
  });

  // POST /store-location — searches Kroger's Locations API (app-level
  // token, not the account's own Kroger OAuth connection — matching stores
  // near a zip code needs no user auth) and saves the nearest result as
  // this account's store. Picks the first (nearest) result, same as the
  // CLI's set-store command.
  app.post("/store-location", async (request) => {
    const body = request.body as { zipCode?: string } | undefined;
    const zipCode = typeof body?.zipCode === "string" ? body.zipCode.trim() : "";
    if (!zipCode) throw badRequest("zipCode is required and must be a non-empty string.");

    const appToken = await getAppToken();
    const results = await searchLocations(zipCode, appToken.access_token);
    if (results.data.length === 0) {
      throw badRequest(`No Kroger stores found near ${zipCode}.`);
    }

    const store = results.data[0]!;
    const location: StoredStoreLocation = {
      locationId: store.locationId,
      name: store.name,
      zipCode: store.address.zipCode,
    };
    await saveStoreLocation(location, request.userId);
    return location;
  });
}
