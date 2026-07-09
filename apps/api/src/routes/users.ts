import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { userRepository, type User } from "@clg/database";
import { HttpError } from "../lib/http.js";
import { hashPassword } from "../lib/passwords.js";
import { audit } from "../lib/audit.js";
import { getLicenseStatus } from "../plugins/license.js";

function toSafeUser(u: User) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    role: u.role,
    active: u.active,
    mustChangePassword: u.must_change_password,
    createdAt: u.created_at,
    lastLoginAt: u.last_login_at,
  };
}

async function assertUserCapNotExceeded(): Promise<void> {
  const status = getLicenseStatus();
  const cap = status.state === "valid" || status.state === "grace" ? status.payload.maxUsers : null;
  if (cap == null) return;
  const current = await userRepository.count();
  if (current + 1 > cap) {
    throw new HttpError(403, `Your license covers up to ${cap} user account(s). Contact your vendor to upgrade.`);
  }
}

/** ADMIN-only user management. Enforced centrally by the auth gate's
 *  ADMIN_ONLY_PATTERNS (/^\/users(\/|$)/); this file trusts that gate. */
export async function usersRoutes(app: FastifyInstance) {
  app.get("/users", async () => ({ users: (await userRepository.list()).map(toSafeUser) }));

  app.post("/users", async (req, reply) => {
    const parsed = z
      .object({
        username: z.string().min(2).max(64),
        displayName: z.string().min(1).max(120),
        password: z.string().min(10, "Password must be at least 10 characters."),
        role: z.enum(["ADMIN", "OPERATOR", "VIEWER"]),
      })
      .safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, "Invalid user details.", parsed.error.issues);

    if (await userRepository.findByUsername(parsed.data.username)) {
      throw new HttpError(409, "That username is already taken.");
    }
    await assertUserCapNotExceeded();

    const user = await userRepository.create({
      username: parsed.data.username,
      display_name: parsed.data.displayName,
      password_hash: hashPassword(parsed.data.password),
      role: parsed.data.role,
    });
    audit(req, "users.create", `created ${user.role} account "${user.username}"`);
    return reply.code(201).send(toSafeUser(user));
  });

  app.put("/users/:id/role", async (req) => {
    const { id } = req.params as { id: string };
    const parsed = z.object({ role: z.enum(["ADMIN", "OPERATOR", "VIEWER"]) }).safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, "Invalid role.");
    const user = await userRepository.setRole(id, parsed.data.role);
    audit(req, "users.set-role", `set "${user.username}" role to ${user.role}`);
    return toSafeUser(user);
  });

  app.post("/users/:id/active", async (req) => {
    const { id } = req.params as { id: string };
    const parsed = z.object({ active: z.boolean() }).safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, "Invalid request.");
    if (req.user?.id === id && !parsed.data.active) {
      throw new HttpError(400, "You can't deactivate your own account.");
    }
    const user = await userRepository.setActive(id, parsed.data.active);
    audit(req, parsed.data.active ? "users.activate" : "users.deactivate", `"${user.username}"`);
    return toSafeUser(user);
  });

  app.post("/users/:id/reset-password", async (req) => {
    const { id } = req.params as { id: string };
    const parsed = z.object({ temporaryPassword: z.string().min(10, "Password must be at least 10 characters.") }).safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, "Invalid request.", parsed.error.issues);
    const user = await userRepository.resetPassword(id, hashPassword(parsed.data.temporaryPassword));
    audit(req, "users.reset-password", `reset password for "${user.username}" (forced change at next login)`);
    return toSafeUser(user);
  });

  // Soft delete: deactivate rather than remove, so AuditLog rows referencing
  // this user (and its own audit trail) survive.
  app.delete("/users/:id", async (req) => {
    const { id } = req.params as { id: string };
    if (req.user?.id === id) throw new HttpError(400, "You can't delete your own account.");
    const user = await userRepository.setActive(id, false);
    audit(req, "users.delete", `deactivated "${user.username}"`);
    return { ok: true };
  });
}
