import type { FastifyInstance, FastifyRequest } from "fastify";
import { userRepository, type UserRole } from "@clg/database";
import { HttpError } from "../lib/http.js";
import { SESSION_COOKIE, decodeSession, encodeSession, sessionCookieOptions } from "../lib/session.js";

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
}

declare module "fastify" {
  interface FastifyRequest {
    user: AuthUser | null;
  }
}

// Reachable without a session. /auth/me is included so the web app's boot
// state machine can always ask "am I logged in?" without a 401 in the way.
const PUBLIC_PATHS = new Set([
  "/health",
  "/license/status",
  "/license/fingerprint",
  "/auth/setup-required",
  "/auth/setup",
  "/auth/login",
  "/auth/me",
]);

const ROLE_RANK: Record<UserRole, number> = { VIEWER: 0, OPERATOR: 1, ADMIN: 2 };

/** Mutating routes that need more than the default OPERATOR minimum. */
const ADMIN_ONLY_PATTERNS: RegExp[] = [
  /^\/ops\/settings$/,
  /^\/ops\/keywords$/,
  /^\/ops\/backup$/,
  /^\/ops\/restore$/,
  /^\/ops\/maintenance\//,
  /^\/ops\/storage\/clear-crawl-data$/,
  /^\/universities\/delete$/,
  /^\/users(\/|$)/,
  /^\/audit$/,
];

function hasRole(user: AuthUser, min: UserRole): boolean {
  return ROLE_RANK[user.role] >= ROLE_RANK[min];
}

/** Minimum role a request needs, given its matched route pattern + method. */
function minRoleFor(routePattern: string, method: string): UserRole {
  if (ADMIN_ONLY_PATTERNS.some((re) => re.test(routePattern))) return "ADMIN";
  if (method === "GET" || method === "HEAD") return "VIEWER";
  return "OPERATOR";
}

/**
 * Registers directly on the root app instance (like the license gate) so the
 * onRequest hook applies globally without needing fastify-plugin. Must be
 * registered AFTER the license gate — an invalid license outranks login.
 */
export function registerAuthGate(app: FastifyInstance): void {
  app.decorateRequest("user", null);

  app.addHook("onRequest", async (req, reply) => {
    const path = req.url.split("?")[0] ?? "";
    const cookie = req.cookies?.[SESSION_COOKIE];
    const session = cookie ? decodeSession(cookie) : null;

    if (session) {
      const dbUser = await userRepository.findById(session.userId);
      if (dbUser && dbUser.active) {
        req.user = { id: dbUser.id, username: dbUser.username, displayName: dbUser.display_name, role: dbUser.role };
        // Sliding renewal: every authenticated request extends the session.
        void reply.setCookie(
          SESSION_COOKIE,
          encodeSession({ userId: dbUser.id, role: dbUser.role, exp: Date.now() + 12 * 60 * 60 * 1000 }),
          sessionCookieOptions(),
        );
      }
    }

    // License activation is reachable without a session ONLY during first-run
    // setup (no user accounts yet); once an admin exists, it needs a login.
    if (path === "/license/activate") {
      if ((await userRepository.count()) === 0) return;
      if (!req.user) return reply.code(401).send({ error: { code: "AUTH_REQUIRED", message: "Please sign in to continue." } });
      if (!hasRole(req.user, "ADMIN")) {
        return reply.code(403).send({ error: { code: "FORBIDDEN", message: "Only an administrator can activate or replace the license." } });
      }
      return;
    }

    if (PUBLIC_PATHS.has(path)) return;

    if (!req.user) {
      return reply.code(401).send({ error: { code: "AUTH_REQUIRED", message: "Please sign in to continue." } });
    }

    const pattern = req.routeOptions?.url ?? path;
    const min = minRoleFor(pattern, req.method);
    if (!hasRole(req.user, min)) {
      return reply.code(403).send({ error: { code: "FORBIDDEN", message: "You don't have permission to do this." } });
    }
  });
}

/** Explicit guard for use inside a route body (e.g. distinguishing Aliff LIVE
 *  from DRY-RUN, which the static role table above can't see). */
export function requireRole(req: FastifyRequest, ...roles: UserRole[]): void {
  if (!req.user || !roles.some((r) => req.user!.role === r)) {
    throw new HttpError(403, "You don't have permission to do this.");
  }
}
