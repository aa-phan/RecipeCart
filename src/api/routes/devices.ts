// Device management routes (Slice 2 of the per-device-token architecture
// fix). Lists and revokes the authenticated user's device_tokens rows —
// lets a user see which devices carry a live token and revoke one (e.g. a
// lost phone) without invalidating every other device, which the old
// single-slot `users.device_token_hash` design couldn't do.
import type { FastifyInstance } from "fastify";
import { getDb } from "../../platform/database.js";
import type { DeviceDto } from "../lib/dto.js";
import { notFound } from "../lib/errors.js";

function toDto(row: {
  id: string;
  device_name: string;
  created_at: Date;
  last_used_at: Date | null;
}): DeviceDto {
  return {
    id: row.id,
    deviceName: row.device_name,
    createdAt: row.created_at.toISOString(),
    lastUsedAt: row.last_used_at ? row.last_used_at.toISOString() : null,
  };
}

export default async function devicesRoutes(app: FastifyInstance): Promise<void> {
  app.get("/devices", async (request) => {
    const rows = await getDb()
      .selectFrom("device_tokens")
      .select(["id", "device_name", "created_at", "last_used_at"])
      .where("user_id", "=", request.userId)
      .orderBy("created_at", "desc")
      .execute();

    return rows.map(toDto);
  });

  app.delete("/devices/:id", async (request, reply) => {
    const { id } = request.params as { id: string };

    const deleted = await getDb()
      .deleteFrom("device_tokens")
      .where("id", "=", id)
      .where("user_id", "=", request.userId)
      .returning("id")
      .executeTakeFirst();

    if (!deleted) throw notFound("Device");

    reply.status(204);
    return null;
  });
}
