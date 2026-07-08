import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { userRepository } from "@clg/database";
import { HttpError } from "../lib/http.js";
import { hashPassword, verifyPassword } from "../lib/passwords.js";
import { SESSION_COOKIE, encodeSession, sessionCookieOptions, SESSION_TTL_MS } from "../lib/session.js";
import { audit } from "../lib/audit.js";
import type { AuthUser } from "../plugins/auth.js";

function toAuthUser(u: { id: string; username: string; display_name: string; role: AuthUser["role"] }): AuthUser {
  return { id: u.id, username: u.username, displayName: u.display_name, role: u.role };
}

function issueSession(reply: import("fastify").FastifyReply, userId: string, role: AuthUser["role"]) {
  reply.setCookie(SESSION_COOKIE, encodeSession({ userId, role, exp: Date.now() + SESSION_TTL_MS }), sessionCookieOptions());
}

export async function authRoutes(app: FastifyInstance) {
  app.get("/auth/setup-required", async () => ({ setupRequired: (await userRepository.count()) === 0 }));

  app.get("/auth/me", async (req) => ({ user: req.user }));

  app.post("/auth/setup", async (req, reply) => {
    if ((await userRepository.count()) > 0) {
      throw new HttpError(409, "Setup has already been completed. Please sign in.");
    }
    const parsed = z
      .object({
        username: z.string().min(2).max(64),
        displayName: z.string().min(1).max(120),
        password: z.string().min(10, "Password must be at least 10 characters."),
      })
      .safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, "Invalid setup details.", parsed.error.issues);

    const user = await userRepository.create({
      username: parsed.data.username,
      display_name: parsed.data.displayName,
      password_hash: hashPassword(parsed.data.password),
      role: "ADMIN",
    });
    await userRepository.recordLogin(user.id);
    issueSession(reply, user.id, user.role);
    audit(req, "auth.setup", `created first administrator account (${user.username})`, toAuthUser(user));
    return { user: toAuthUser(user) };
  });

  app.post(
    "/auth/login",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const parsed = z.object({ username: z.string().min(1), password: z.string().min(1) }).safeParse(req.body);
      if (!parsed.success) throw new HttpError(400, "Username and password are required.");

      const user = await userRepository.findByUsername(parsed.data.username);
      const genericError = () => { throw new HttpError(401, "Incorrect username or password."); };
      if (!user || !user.active) return genericError();
      if (!verifyPassword(parsed.data.password, user.password_hash)) return genericError();

      await userRepository.recordLogin(user.id);
      issueSession(reply, user.id, user.role);
      audit(req, "auth.login", undefined, toAuthUser(user));
      return { user: toAuthUser(user), mustChangePassword: user.must_change_password };
    },
  );

  app.post("/auth/logout", async (req, reply) => {
    if (req.user) audit(req, "auth.logout");
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.post("/auth/change-password", async (req) => {
    if (!req.user) throw new HttpError(401, "Please sign in to continue.");
    const parsed = z
      .object({ currentPassword: z.string().min(1), newPassword: z.string().min(10, "Password must be at least 10 characters.") })
      .safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, "Invalid request.", parsed.error.issues);

    const user = await userRepository.findById(req.user.id);
    if (!user || !verifyPassword(parsed.data.currentPassword, user.password_hash)) {
      throw new HttpError(401, "Current password is incorrect.");
    }
    await userRepository.changePassword(user.id, hashPassword(parsed.data.newPassword));
    audit(req, "auth.change-password");
    return { ok: true };
  });
}
