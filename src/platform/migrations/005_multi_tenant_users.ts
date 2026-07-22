// Multi-tenancy Slice 1 (2026-07-21 — see files/phases.md's Phase 7
// "Architecture: multi-tenancy" entry). Gives `users` real per-person
// identity fields for Google sign-in, replacing the single hardcoded
// DEFAULT_USER_ID as the only account that can ever exist.
//
// `recipes` deliberately does NOT get its own `user_id` column here —
// `recipes.id === jobs.id` always, by construction (see routes/recipes.ts's
// header comment: a job's id and its eventual recipe's id are the same
// value), and `jobs.user_id` already exists and is already correct. Adding
// a second, redundant tenant column on `recipes` would just be a second
// thing that could drift out of sync with `jobs.user_id` for no benefit —
// every recipe-scoping query joins through `jobs` instead (see
// api/lib/ownership.ts).
import { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("users")
    // Google's stable, permanent per-account identifier (the OIDC `sub`
    // claim) — NOT email, which some providers let a user change or reuse.
    // Nullable: the existing seeded DEFAULT_USER_ID row has none until it's
    // claimed by the owner's first real Google login (see
    // api/routes/google_auth.ts).
    .addColumn("google_sub", "text", (c) => c.unique())
    .addColumn("email", "text")
    .addColumn("name", "text")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("users").dropColumn("google_sub").execute();
  await db.schema.alterTable("users").dropColumn("email").execute();
  await db.schema.alterTable("users").dropColumn("name").execute();
}
