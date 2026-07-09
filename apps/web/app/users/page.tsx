"use client";

import { useState } from "react";
import { useAutoRefresh } from "../../lib/useAutoRefresh";
import { api, ApiError, type UserRole } from "../../lib/api";
import { Card, Button, Badge } from "../../components/ui";
import { PageHeader } from "../../components/PageHeader";
import { ConfirmButton } from "../../components/Confirm";
import { useToast } from "../../components/Toast";

interface SafeUser {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  active: boolean;
  mustChangePassword: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

const ROLES: UserRole[] = ["ADMIN", "OPERATOR", "VIEWER"];

function CreateUserForm({ onCreated }: { onCreated: () => void }) {
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<UserRole>("OPERATOR");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const valid = username.trim().length >= 2 && displayName.trim().length >= 1 && password.length >= 10;

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    setError("");
    try {
      await api.post("/users", { username: username.trim(), displayName: displayName.trim(), password, role });
      setUsername("");
      setDisplayName("");
      setPassword("");
      setRole("OPERATOR");
      toast("User created.", "success");
      onCreated();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const fieldCls =
    "w-full rounded-lg border border-slate-300 bg-white/60 px-3 py-2 text-sm outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-400/30 dark:bg-white/5";

  return (
    <Card className="p-6">
      <h2 className="text-sm font-semibold text-slate-900">Add a team member</h2>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <input placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} className={fieldCls} />
        <input placeholder="Display name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} className={fieldCls} />
        <input placeholder="Temporary password (10+ chars)" type="password" value={password} onChange={(e) => setPassword(e.target.value)} className={fieldCls} />
        <select value={role} onChange={(e) => setRole(e.target.value as UserRole)} className={fieldCls}>
          {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
      </div>
      {error && <p className="mt-2 text-sm text-rose-600 dark:text-rose-400">{error}</p>}
      <div className="mt-3">
        <Button onClick={submit} disabled={!valid} loading={busy}>Create account</Button>
      </div>
    </Card>
  );
}

function ResetPasswordButton({ userId, username }: { userId: string; username: string }) {
  const [password, setPassword] = useState("");
  const toast = useToast();
  return (
    <ConfirmButton
      label="Reset password"
      variant="secondary"
      title={`Reset password for ${username}`}
      confirmLabel="Reset"
      message={
        <div className="mt-2">
          <input
            type="password"
            placeholder="Temporary password (10+ chars)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-400/30 dark:bg-white/5"
          />
          <p className="mt-1.5 text-xs text-slate-500">The user must change it at next login.</p>
        </div>
      }
      onConfirm={async () => {
        if (password.length < 10) throw new Error("Password must be at least 10 characters.");
        await api.post(`/users/${userId}/reset-password`, { temporaryPassword: password });
        toast("Password reset.", "success");
      }}
    />
  );
}

export default function UsersPage() {
  const [users, setUsers] = useState<SafeUser[]>([]);
  const [me, setMe] = useState<{ id: string; role: UserRole } | null>(null);
  const toast = useToast();

  const load = () => {
    api.get<{ users: SafeUser[] }>("/users").then((r) => setUsers(r.users)).catch(() => {});
    api.get<{ user: { id: string; role: UserRole } | null }>("/auth/me").then((r) => setMe(r.user)).catch(() => {});
  };
  useAutoRefresh(load, 15000);

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Advanced" title="Team accounts" subtitle="Everyone signs in with their own account. ADMIN can manage users, settings, and licensing; OPERATOR can run the pipeline; VIEWER is read-only." />

      <CreateUserForm onCreated={load} />

      <Card className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-400 dark:border-white/10">
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Role</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Last login</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-b border-slate-100 last:border-0 dark:border-white/5">
                <td className="px-4 py-3">
                  <div className="font-medium text-slate-900">{u.displayName}</div>
                  <div className="text-xs text-slate-500">@{u.username}{u.mustChangePassword && " · must change password"}</div>
                </td>
                <td className="px-4 py-3">
                  <select
                    value={u.role}
                    disabled={u.id === me?.id}
                    onChange={(e) =>
                      api.put(`/users/${u.id}/role`, { role: e.target.value }).then(load).catch((err) => toast(String(err), "error"))
                    }
                    className="rounded-lg border border-slate-300 bg-white/60 px-2 py-1 text-xs outline-none dark:bg-white/5"
                  >
                    {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                </td>
                <td className="px-4 py-3"><Badge value={u.active ? "APPROVED" : "STOPPED"} /></td>
                <td className="px-4 py-3 text-slate-500">{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : "Never"}</td>
                <td className="px-4 py-3">
                  <div className="flex justify-end gap-2">
                    <ResetPasswordButton userId={u.id} username={u.username} />
                    {u.id !== me?.id && (
                      <Button
                        variant={u.active ? "secondary" : "primary"}
                        onClick={() =>
                          api.post(`/users/${u.id}/active`, { active: !u.active }).then(load).catch((err) => toast(String(err), "error"))
                        }
                      >
                        {u.active ? "Deactivate" : "Activate"}
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
