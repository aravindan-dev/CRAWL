"use client";

import { useCallback, useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { api, artifactUrl, type Page, type CourseCriteria } from "../../lib/api";
import { useAutoRefresh } from "../../lib/useAutoRefresh";
import { Card, Badge, Button, ConfidenceBadge } from "../../components/ui";
import { PageHeader } from "../../components/PageHeader";

const STATUS_FILTERS = ["", "PENDING", "LOW_CONFIDENCE", "NEEDS_REVIEW", "APPROVED", "REJECTED"];
const selectCls = "rounded-lg border border-slate-300 bg-white/60 px-3 py-1.5 text-sm outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-400/30 dark:bg-white/5";

export default function CriteriaReviewPage() {
  const [items, setItems] = useState<CourseCriteria[]>([]);
  const [focus, setFocus] = useState(0);
  const [statusFilter, setStatusFilter] = useState("");
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = statusFilter ? `?review_status=${statusFilter}&take=100` : "?take=100";
      const page = await api.get<Page<CourseCriteria>>(`/criteria${qs}`);
      setItems(page.items);
      setFocus(0);
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    void load();
  }, [load]);
  // Focus-only refresh (no timer) so returning to this page shows new criteria
  // without interrupting active keyboard review.
  useAutoRefresh(load, 0);

  const act = useCallback(
    async (id: string, action: "approve" | "reject" | "needs-review") => {
      await api.post(`/criteria/${id}/${action}`);
      setItems((prev) => prev.filter((r) => r.id !== id));
      setFocus((f) => Math.max(0, Math.min(f, items.length - 2)));
    },
    [items.length],
  );

  // Keyboard shortcuts: A=approve, E=edit, R=reject, N=needs review.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (editing || (e.target as HTMLElement)?.tagName === "INPUT" || (e.target as HTMLElement)?.tagName === "TEXTAREA") return;
      const current = items[focus];
      if (!current) return;
      const k = e.key.toLowerCase();
      if (k === "a") void act(current.id, "approve");
      else if (k === "r") void act(current.id, "reject");
      else if (k === "n") void act(current.id, "needs-review");
      else if (k === "e") setEditing(true);
      else if (k === "j") setFocus((f) => Math.min(f + 1, items.length - 1));
      else if (k === "k") setFocus((f) => Math.max(f - 1, 0));
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items, focus, editing, act]);

  const current = items[focus];
  const Key = ({ children }: { children: React.ReactNode }) => (
    <kbd className="rounded-md border border-slate-300 bg-white/70 px-1.5 py-0.5 font-mono text-[11px] text-slate-600 shadow-sm dark:border-white/15 dark:bg-white/5 dark:text-slate-300">{children}</kbd>
  );

  return (
    <div>
      <PageHeader
        eyebrow="Review · Quality"
        title="Criteria Review"
        subtitle={
          <span className="flex flex-wrap items-center gap-1.5">
            Keys: <Key>A</Key> approve · <Key>E</Key> edit · <Key>R</Key> reject · <Key>N</Key> needs review · <Key>J/K</Key> next/prev
          </span>
        }
        actions={
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className={selectCls}>
            {STATUS_FILTERS.map((s) => (
              <option key={s} value={s}>{s || "All statuses"}</option>
            ))}
          </select>
        }
      />

      <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Record list */}
        <Card className="col-span-1 max-h-[75vh] overflow-y-auto p-0">
          {loading && <div className="p-4 text-sm text-slate-400">Loading…</div>}
          {!loading && items.length === 0 && <div className="p-4 text-sm text-slate-400">No records.</div>}
          {items.map((r, i) => (
            <button
              key={r.id}
              onClick={() => { setFocus(i); setEditing(false); }}
              className={`relative block w-full border-b border-slate-100 px-4 py-3 text-left transition-colors last:border-0 dark:border-white/5 ${i === focus ? "bg-brand-50/80 dark:bg-brand-500/15" : "hover:bg-slate-50 dark:hover:bg-white/5"}`}
            >
              {i === focus && <span className="absolute left-0 top-1/2 h-7 w-1 -translate-y-1/2 rounded-r-full bg-gradient-to-b from-brand-400 to-brand-600" />}
              <div className="flex items-center justify-between">
                <span className="truncate text-sm font-medium text-slate-800">{r.course_name}</span>
                <ConfidenceBadge score={r.confidence_score} />
              </div>
              <div className="mt-1 flex items-center gap-2">
                <Badge value={r.review_status} />
                <span className="truncate text-xs text-slate-400">{r.university_name}</span>
              </div>
            </button>
          ))}
        </Card>

        {/* Focused detail */}
        <div className="lg:col-span-2">
          <AnimatePresence mode="wait">
            {current ? (
              <motion.div
                key={current.id}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.25, ease: [0.22, 0.7, 0.2, 1] }}
              >
                <DetailCard record={current} editing={editing} setEditing={setEditing} onAction={act} onSaved={load} />
              </motion.div>
            ) : (
              <Card className="p-8 text-center text-slate-400">Select a record to review.</Card>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

function DetailCard({
  record,
  editing,
  setEditing,
  onAction,
  onSaved,
}: {
  record: CourseCriteria;
  editing: boolean;
  setEditing: (v: boolean) => void;
  onAction: (id: string, a: "approve" | "reject" | "needs-review") => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState({ course_name: record.course_name, criteria: record.criteria ?? "" });
  useEffect(() => setDraft({ course_name: record.course_name, criteria: record.criteria ?? "" }), [record.id]);

  const screenshot = artifactUrl(record.discovered_link?.screenshot_path);
  const editCls = "w-full rounded-lg border border-slate-300 bg-white/60 px-3 py-2 text-sm outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-400/30 dark:bg-white/5";

  async function save() {
    await api.put(`/criteria/${record.id}`, { course_name: draft.course_name, criteria: draft.criteria });
    setEditing(false);
    onSaved();
  }

  return (
    <Card spotlight className="p-6">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="eyebrow">{record.university_name}</div>
          {editing ? (
            <input value={draft.course_name} onChange={(e) => setDraft({ ...draft, course_name: e.target.value })} className={`mt-1 text-lg font-semibold ${editCls}`} />
          ) : (
            <h2 className="mt-0.5 font-display text-xl font-bold tracking-tight text-slate-900">{record.course_name}</h2>
          )}
        </div>
        <div className="text-right">
          <ConfidenceBadge score={record.confidence_score} />
          <div className="mt-1"><Badge value={record.review_status} /></div>
        </div>
      </div>

      <Field label="Criteria">
        {editing ? (
          <textarea value={draft.criteria} onChange={(e) => setDraft({ ...draft, criteria: e.target.value })} rows={4} className={editCls} />
        ) : (
          <p className="text-sm leading-relaxed text-slate-700">{record.criteria ?? <span className="italic text-orange-600 dark:text-orange-400">No criteria (needs review)</span>}</p>
        )}
      </Field>

      <div className="grid grid-cols-2 gap-4">
        <Field label="Degree level"><span className="text-sm">{record.degree_level}</span></Field>
        <Field label="Parser"><span className="text-sm">{record.parser_type}</span></Field>
        <Field label="Minimum marks"><span className="text-sm">{record.minimum_marks ?? "—"}</span></Field>
        <Field label="Entrance exam"><span className="text-sm">{record.entrance_exam ?? "—"}</span></Field>
        <Field label="English requirement"><span className="text-sm">{record.english_requirement ?? "—"}</span></Field>
        <Field label="Language"><span className="text-sm">{record.source_language}</span></Field>
        <Field label="Required subjects"><span className="text-sm">{record.required_subjects?.join(", ") || "—"}</span></Field>
      </div>

      <Field label="Criteria URL (exact source)">
        <a href={record.criteria_url} target="_blank" rel="noreferrer" className="break-all text-sm text-brand-600 hover:underline">{record.criteria_url}</a>
      </Field>

      <Field label="Source snippet (verbatim proof)">
        <blockquote className="rounded-r-lg border-l-4 border-brand-400/60 bg-slate-50 p-3 text-sm italic text-slate-600 dark:bg-white/5">{record.source_snippet}</blockquote>
      </Field>

      {screenshot && (
        <Field label="Screenshot">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={screenshot} alt="page screenshot" className="max-h-72 w-full rounded-xl border border-slate-200 object-cover object-top dark:border-white/10" />
        </Field>
      )}

      <div className="mt-5 flex flex-wrap gap-2">
        {editing ? (
          <>
            <Button onClick={save}>Save</Button>
            <Button variant="secondary" onClick={() => setEditing(false)}>Cancel</Button>
          </>
        ) : (
          <>
            <Button onClick={() => onAction(record.id, "approve")}>Approve (A)</Button>
            <Button variant="secondary" onClick={() => setEditing(true)}>Edit (E)</Button>
            <Button variant="danger" onClick={() => onAction(record.id, "reject")}>Reject (R)</Button>
            <Button variant="ghost" onClick={() => onAction(record.id, "needs-review")}>Needs review (N)</Button>
            <a href={record.criteria_url} target="_blank" rel="noreferrer" className="inline-flex items-center rounded-lg px-3 py-1.5 text-sm font-medium text-brand-600 transition-colors hover:bg-brand-50 dark:hover:bg-brand-500/10">Open original ↗</a>
          </>
        )}
      </div>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</div>
      {children}
    </div>
  );
}
