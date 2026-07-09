import type { UserRole } from "@prisma/client";
import { prisma } from "../client.js";

export interface UserCreateInput {
  username: string;
  display_name: string;
  password_hash: string;
  role: UserRole;
  must_change_password?: boolean;
}

export const userRepository = {
  count() {
    return prisma.user.count();
  },

  findByUsername(username: string) {
    return prisma.user.findUnique({ where: { username } });
  },

  findById(id: string) {
    return prisma.user.findUnique({ where: { id } });
  },

  create(input: UserCreateInput) {
    return prisma.user.create({
      data: {
        username: input.username,
        display_name: input.display_name,
        password_hash: input.password_hash,
        role: input.role,
        must_change_password: input.must_change_password ?? false,
      },
    });
  },

  list() {
    return prisma.user.findMany({ orderBy: { created_at: "asc" } });
  },

  recordLogin(id: string) {
    return prisma.user.update({ where: { id }, data: { last_login_at: new Date() } });
  },

  setRole(id: string, role: UserRole) {
    return prisma.user.update({ where: { id }, data: { role } });
  },

  setActive(id: string, active: boolean) {
    return prisma.user.update({ where: { id }, data: { active } });
  },

  /** Admin-initiated reset: sets a temporary hash and forces a change at next login. */
  resetPassword(id: string, password_hash: string) {
    return prisma.user.update({ where: { id }, data: { password_hash, must_change_password: true } });
  },

  /** Self-service change: clears the forced-change flag. */
  changePassword(id: string, password_hash: string) {
    return prisma.user.update({ where: { id }, data: { password_hash, must_change_password: false } });
  },
};
