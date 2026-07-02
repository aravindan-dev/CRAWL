"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Reorder, useDragControls } from "framer-motion";
import { api, API_URL, type Page, type University } from "../../lib/api";
import { useAutoRefresh } from "../../lib/useAutoRefresh";
import { Card, Badge, Button, Skeleton, EmptyState } from "../../components/ui";
import { ConfirmButton } from "../../components/Confirm";
import { FileDropzone } from "../../components/FileDropzone";
import { useToast } from "../../components/Toast";
import { PageHeader } from "../../components/PageHeader";
import { Reveal } from "../../components/motion";
import { UniversityUrlsDrawer } from "../../components/UniversityUrlsDrawer";
import { PipelineStepper } from "../../components/PipelineStepper";

const inputCls =
  "w-full rounded-lg border border-slate-300 bg-white/60 px-3 py-2 text-sm outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-400/30 dark:bg-white/5";
const selectCls =
  "rounded-lg border border-slate-300 bg-white/60 px-3 py-1.5 text-sm outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-400/30 dark:bg-white/5";

interface DiscoverProgress { running: boolean; done: number; total: number; found: number }

type SortKey = "manual" | "name" | "links" | "valid" | "courses";
const STATUS_OPTS = ["", "IDLE", "QUEUED", "DISCOVERING", "COMPLETED", "FAILED", "STOPPED"];

const coursesOf = (u: University) => u.verified_courses ?? u.total_courses_extracted;
const validOf = (u: University) => u.verified_valid_links ?? u.total_valid_links;

// Shared column grid so the header and every row line up (handle · select ·
// university · country · status · links · valid · courses · actions).
const GRID = "grid grid-cols-[26px_26px_minmax(150px,1fr)_92px_118px_60px_60px_92px_150px] items-center gap-2";

export default function UniversitiesPage() {
  const [items, setItems] = useState<University[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ name: "", country: "", base_url: "", notes: "" });
  const [discover, setDiscover] = useState<DiscoverProgress | null>(null);
  const [findingId, setFindingId] = useState<string | null>(null);

  // UX state: search, status filter, sort, selection, drag-suppression, drawer.
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "manual", dir: "asc" });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const suppressUntil = useRef(0); // pause poll-overwrite briefly after a drag
  const orderRef = useRef<University[]>([]);
  const toast = useToast();

  async function load(showSpinner = true) {
    if (showSpinner) setLoading(true);
    try {
      const page = await api.get<Page<University>>("/universities?take=200");
      // Keep the optimistic order right after a drag until the server catches up.
      if (Date.now() < suppressUntil.current && items.length > 0) return;
      setItems(page.items);
      orderRef.current = page.items;
    } finally {
      setLoading(false);
    }
  }
  // Auto-refresh (interval + on focus) so deletes/imports/discovery on any page
  // are reflected here without a manual reload. Silent (no skeleton flash).
  useAutoRefresh(() => load(false), 5000);

  const missingCount = items.filter((u) => !u.base_url).length;

  // While websites are being auto-found, poll progress + refresh the list so
  // links appear live as they're discovered.
  useEffect(() => {
    if (!discover?.running && missingCount === 0) return;
    const t = setInterval(async () => {
      try {
        const p = await api.get<DiscoverProgress>("/universities/discover-progress");
        setDiscover(p);
        await load(false);
        if (!p.running) { clearInterval(t); }
      } catch { clearInterval(t); }
    }, 2500);
    return () => clearInterval(t);
  }, [discover?.running, missingCount]);

  async function addUniversity(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api.post("/universities", form);
      const noUrl = !form.base_url.trim();
      setForm({ name: "", country: "", base_url: "", notes: "" });
      toast(noUrl ? "University added — finding its website…" : "University added.", "success");
      if (noUrl) setDiscover({ running: true, done: 0, total: 1, found: 0 });
      await load(false);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to add", "error");
    }
  }

  async function findWebsite(id: string) {
    setFindingId(id);
    try {
      const r = await api.post<{ base_url: string }>(`/universities/${id}/discover-url`);
      toast(r.base_url ? `Found: ${r.base_url}` : "No official website found — add it manually.", r.base_url ? "success" : "info");
      await load(false);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Search failed", "error");
    } finally {
      setFindingId(null);
    }
  }

  async function findAllMissing() {
    const r = await api.post<{ started: boolean; total: number }>("/universities/discover-missing");
    if (r.started) { setDiscover({ running: true, done: 0, total: r.total, found: 0 }); toast(`Finding websites for ${r.total} universities…`, "info"); }
    else toast("No missing websites to find.", "info");
  }

  // --- Selective crawl --------------------------------------------------------
  async function crawlOne(id: string) {
    try {
      await api.post(`/universities/${id}/crawl`);
      toast("Queued for crawl. Make sure the engine is running on the Crawl page.", "success");
      await load(false);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to queue crawl", "error");
    }
  }

  async function crawlSelected() {
    const ids = [...selected];
    if (ids.length === 0) return;
    try {
      const r = await api.post<{ started: number; skippedNoUrl: number }>("/universities/crawl-selected", { ids });
      toast(
        r.started > 0
          ? `Queued ${r.started} universit${r.started === 1 ? "y" : "ies"}${r.skippedNoUrl ? ` · ${r.skippedNoUrl} skipped (no website)` : ""}. Engine must be running.`
          : "Nothing queued — selected universities have no website.",
        r.started > 0 ? "success" : "info",
      );
      setSelected(new Set());
      await load(false);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to queue crawl", "error");
    }
  }

  async function deleteSelected() {
    const ids = [...selected];
    if (ids.length === 0) return;
    const names = items.filter((u) => selected.has(u.id)).map((u) => u.name);
    const preview = names.slice(0, 5).join(", ") + (names.length > 5 ? `, +${names.length - 5} more` : "");
    // Destructive + irreversible: it also removes that university's crawled links,
    // snapshots and extracted criteria. Confirm before deleting.
    if (!window.confirm(`Delete ${ids.length} universit${ids.length === 1 ? "y" : "ies"} and all their crawled data?\n\n${preview}\n\nThis cannot be undone.`)) return;
    try {
      const r = await api.post<{ deleted: number }>("/universities/delete", { ids });
      toast(`Deleted ${r.deleted} universit${r.deleted === 1 ? "y" : "ies"}.`, "success");
      setSelected(new Set());
      await load(false);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to delete", "error");
    }
  }

  // --- Reorder ---------------------------------------------------------------
  function persistOrder(list: University[]) {
    suppressUntil.current = Date.now() + 2500;
    api.put("/universities/reorder", { ids: list.map((u) => u.id) }).catch((err) =>
      toast(err instanceof Error ? err.message : "Failed to save order", "error"),
    );
  }
  function handleReorder(next: University[]) {
    setItems(next);
    orderRef.current = next;
  }

  // --- Derived list (search + status filter + sort) ---------------------------
  const displayed = useMemo(() => {
    let list = items;
    const s = search.trim().toLowerCase();
    if (s) list = list.filter((u) => u.name.toLowerCase().includes(s) || (u.country ?? "").toLowerCase().includes(s) || (u.base_url ?? "").toLowerCase().includes(s));
    if (statusFilter) list = list.filter((u) => u.crawl_status === statusFilter);
    if (sort.key !== "manual") {
      const val = (u: University): string | number =>
        sort.key === "name" ? u.name.toLowerCase() : sort.key === "links" ? u.total_links_found : sort.key === "valid" ? validOf(u) : coursesOf(u);
      list = [...list].sort((a, b) => {
        const av = val(a), bv = val(b);
        const c = av < bv ? -1 : av > bv ? 1 : 0;
        return sort.dir === "asc" ? c : -c;
      });
    }
    return list;
  }, [items, search, statusFilter, sort]);

  // Drag is only meaningful for the full, manually-ordered list.
  const canDrag = sort.key === "manual" && !search.trim() && !statusFilter;

  const allSelected = displayed.length > 0 && displayed.every((u) => selected.has(u.id));
  function toggleAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) displayed.forEach((u) => next.delete(u.id));
      else displayed.forEach((u) => next.add(u.id));
      return next;
    });
  }
  function toggleOne(id: string) {
    setSelected((prev) => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; });
  }

  function sortBy(key: SortKey) {
    setSort((prev) => prev.key === key
      ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
      : { key, dir: key === "name" ? "asc" : "desc" });
  }
  const caret = (key: SortKey) => (sort.key !== key ? "" : sort.dir === "asc" ? " ▲" : " ▼");

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Data · Sources"
        title="Universities"
        subtitle={<>Add and import the universities to extract eligibility/criteria URLs for. Select rows to crawl just those, drag to set the crawl order, or open a row to see its verified URLs.</>}
        actions={
          <div className="flex items-center gap-2">
            {(missingCount > 0 || discover?.running) && (
              <Button variant="secondary" disabled={discover?.running} onClick={findAllMissing}>
                {discover?.running ? `Finding ${discover.done}/${discover.total}…` : `Find ${missingCount} website${missingCount === 1 ? "" : "s"}`}
              </Button>
            )}
            <Button variant="secondary" onClick={async () => { const r = await api.post<{ universities: number }>("/ops/backup"); toast(`Backed up ${r.universities} universities. Restore anytime.`, "success"); }}>Backup</Button>
            <ConfirmButton
              label="Restore"
              variant="secondary"
              title="Restore from the latest backup?"
              message="This re-adds the universities (and your manual coverage decisions + keywords) from the most recent backup. Existing entries are kept; duplicates are skipped."
              confirmLabel="Restore latest"
              onConfirm={async () => { const r = await api.post<{ restored: number; total: number }>("/ops/restore"); toast(`Restored ${r.restored} universities (now ${r.total} total).`, "success"); await load(); }}
            />
            <ConfirmButton
              label="Delete all data"
              title="Delete ALL universities and data?"
              message="This permanently removes every university plus all crawled links, snapshots and logs. A backup is taken automatically first, and your exported files on disk are NOT affected — but this still clears the live database."
              confirmLabel="Delete everything"
              confirmPhrase="DELETE"
              onConfirm={async () => { await api.post("/ops/maintenance/reset-all"); toast("All universities and crawl data deleted (an automatic backup was saved).", "success"); await load(); }}
            />
          </div>
        }
      />

      <Reveal><PipelineStepper current={1} /></Reveal>

      {discover?.running && (
        <Reveal>
          <Card className="flex items-center gap-3 border-brand-200/70 bg-brand-50/70 p-3 text-sm text-brand-800 dark:bg-brand-500/10 dark:text-brand-200">
            <span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand-400 opacity-70" /><span className="relative inline-flex h-2 w-2 rounded-full bg-brand-500" /></span>
            Auto-finding official websites — {discover.done}/{discover.total} checked, {discover.found} found. Links appear below as they're discovered.
          </Card>
        </Reveal>
      )}

      {!discover?.running && missingCount > 0 && (
        <Reveal>
          <Card className="flex flex-wrap items-center gap-3 border-amber-300/70 bg-amber-50/80 p-3 text-sm text-amber-900 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-200">
            <svg viewBox="0 0 24 24" className="h-5 w-5 flex-none" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /></svg>
            <span className="flex-1">
              <b>{missingCount}</b> universit{missingCount === 1 ? "y has" : "ies have"} no website yet. A website is <b>required</b> for every university before it can be crawled — auto-find them, or add each manually below (<span className="text-amber-700 dark:text-amber-300">+ Find website</span> on each row).
            </span>
            <Button variant="secondary" onClick={findAllMissing}>Find {missingCount} now</Button>
          </Card>
        </Reveal>
      )}

      <Reveal>
        <div className="grid gap-5 md:grid-cols-3">
          <Card hover spotlight className="p-6 md:col-span-2">
            <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold text-slate-700">
              <svg viewBox="0 0 24 24" className="h-4 w-4 text-brand-500" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
              Add a university
            </h2>
            <p className="mb-3 text-xs text-slate-500">Only the <b>name</b> is required. Leave the website blank and we'll find the official site automatically.</p>
            <form onSubmit={addUniversity} className="grid grid-cols-2 gap-3">
              <input required placeholder="Name (required)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputCls} />
              <input placeholder="Country (optional)" value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })} className={inputCls} />
              <input placeholder="Website (optional — auto-found if blank)" value={form.base_url} onChange={(e) => setForm({ ...form, base_url: e.target.value })} className={`col-span-2 ${inputCls}`} />
              <input placeholder="Notes (optional)" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} className={`col-span-2 ${inputCls}`} />
              <div className="col-span-2"><Button type="submit">Add university</Button></div>
            </form>
          </Card>

          <Card hover spotlight className="p-6">
            <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-slate-700">
              <svg viewBox="0 0 24 24" className="h-4 w-4 text-accent-500" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M7 9l5-5 5 5M12 4v12" /></svg>
              Bulk import
            </h2>
            <p className="mb-3 text-xs text-slate-500">Any Excel/CSV works — we auto-detect the columns. A <b>university/college name</b> is all you need; <code className="rounded bg-slate-100 px-1 dark:bg-white/10">country</code> and <code className="rounded bg-slate-100 px-1 dark:bg-white/10">website</code> are optional and the website is found for you.</p>
            <FileDropzone
              templateUrl={`${API_URL}/universities/template.csv`}
              onUpload={async (file) => {
                const fd = new FormData();
                fd.append("file", file);
                const res = await fetch(`${API_URL}/universities/bulk`, { method: "POST", body: fd });
                const json = (await res.json()) as { inserted?: number; parsed?: number; discovering?: number; errors?: unknown[] };
                if ((json.discovering ?? 0) > 0) setDiscover({ running: true, done: 0, total: json.discovering ?? 0, found: 0 });
                await load(false);
                const errN = json.errors?.length ?? 0;
                const summary =
                  `Imported ${json.inserted ?? 0} of ${json.parsed ?? 0} rows` +
                  ((json.discovering ?? 0) > 0 ? ` · finding ${json.discovering} website${json.discovering === 1 ? "" : "s"}…` : "") +
                  (errN > 0 ? ` (${errN} skipped)` : "");
                toast(summary, (json.inserted ?? 0) > 0 ? "success" : "error");
                return summary;
              }}
            />
          </Card>
        </div>
      </Reveal>

      {/* Toolbar: search · status filter · selection actions */}
      <Reveal>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[220px] flex-1">
            <svg viewBox="0 0 24 24" className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, country or website…" className={`${inputCls} pl-8`} />
          </div>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className={selectCls}>
            {STATUS_OPTS.map((s) => <option key={s} value={s}>{s === "" ? "All statuses" : s}</option>)}
          </select>
          <select value={sort.key} onChange={(e) => setSort({ key: e.target.value as SortKey, dir: e.target.value === "name" ? "asc" : e.target.value === "manual" ? "asc" : "desc" })} className={selectCls} title="Sort">
            <option value="manual">Manual order (drag)</option>
            <option value="name">Sort: Name</option>
            <option value="courses">Sort: Courses</option>
            <option value="valid">Sort: Valid</option>
            <option value="links">Sort: Links</option>
          </select>
          {selected.size > 0 && (
            <>
              <span className="text-sm text-slate-500">{selected.size} selected</span>
              <Button onClick={crawlSelected}>Crawl selected</Button>
              <Button variant="danger" onClick={deleteSelected}>Delete selected</Button>
              <Button variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
            </>
          )}
        </div>
      </Reveal>

      <Reveal>
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <div className="min-w-[760px]">
              {/* Header */}
              <div className={`${GRID} border-b border-slate-200 bg-slate-50/60 px-4 py-3 text-xs uppercase tracking-wide text-slate-500 dark:bg-white/5`}>
                <span title={canDrag ? "Drag rows to set the crawl order" : "Switch to Manual order to drag"} className="text-center text-slate-400">⋮⋮</span>
                <input type="checkbox" aria-label="Select all" checked={allSelected} onChange={toggleAll} className="h-4 w-4 cursor-pointer accent-brand-500" />
                <button onClick={() => sortBy("name")} className="text-left uppercase tracking-wide hover:text-slate-700">University{caret("name")}</button>
                <span>Country</span>
                <span>Status</span>
                <button onClick={() => sortBy("links")} className="text-left uppercase tracking-wide hover:text-slate-700">Links{caret("links")}</button>
                <button onClick={() => sortBy("valid")} className="text-left uppercase tracking-wide hover:text-slate-700">Valid{caret("valid")}</button>
                <button onClick={() => sortBy("courses")} className="text-left uppercase tracking-wide hover:text-slate-700">Courses{caret("courses")}</button>
                <span className="text-right">Actions</span>
              </div>

              {/* Body */}
              {loading && (
                <div className="divide-y divide-slate-100 dark:divide-white/5">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <div key={i} className={`${GRID} px-4 py-3`}>
                      <span /><span />
                      <Skeleton className="h-4 w-40" /><Skeleton className="h-4 w-16" /><Skeleton className="h-5 w-20 rounded-full" />
                      <Skeleton className="h-4 w-8" /><Skeleton className="h-4 w-8" /><Skeleton className="h-4 w-8" /><Skeleton className="h-7 w-28" />
                    </div>
                  ))}
                </div>
              )}

              {!loading && displayed.length === 0 && (
                <EmptyState
                  icon={<svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M3 9.5 12 4l9 5.5" /><path d="M5 10v8h14v-8" /></svg>}
                  title={items.length === 0 ? "No universities yet" : "No matches"}
                  hint={items.length === 0 ? "Add one on the left, or bulk-import an Excel/CSV. Then head to the Crawl page." : "Try a different search or status filter."}
                />
              )}

              {!loading && displayed.length > 0 && (
                canDrag ? (
                  <Reorder.Group axis="y" values={displayed} onReorder={handleReorder} as="div" className="divide-y divide-slate-100 dark:divide-white/5">
                    {displayed.map((u) => (
                      <DraggableRow
                        key={u.id} u={u}
                        selected={selected.has(u.id)}
                        finding={findingId === u.id || !!discover?.running}
                        onToggle={() => toggleOne(u.id)}
                        onCrawl={() => crawlOne(u.id)}
                        onFind={() => findWebsite(u.id)}
                        onOpen={() => setDrawerId(u.id)}
                        onDragEnd={() => persistOrder(orderRef.current)}
                      />
                    ))}
                  </Reorder.Group>
                ) : (
                  <div className="divide-y divide-slate-100 dark:divide-white/5">
                    {displayed.map((u) => (
                      <div key={u.id} className={`${GRID} px-4 py-3 transition-colors hover:bg-slate-50/60 dark:hover:bg-white/5`}>
                        <span className="text-center text-slate-300" title="Switch to Manual order to drag">⋮⋮</span>
                        <input type="checkbox" checked={selected.has(u.id)} onChange={() => toggleOne(u.id)} className="h-4 w-4 cursor-pointer accent-brand-500" />
                        <RowCells u={u} finding={findingId === u.id || !!discover?.running} onFind={() => findWebsite(u.id)} onCrawl={() => crawlOne(u.id)} onOpen={() => setDrawerId(u.id)} />
                      </div>
                    ))}
                  </div>
                )
              )}
            </div>
          </div>
        </Card>
      </Reveal>

      <UniversityUrlsDrawer universityId={drawerId} onClose={() => setDrawerId(null)} />
    </div>
  );
}

// --- Row pieces --------------------------------------------------------------

function DraggableRow({
  u, selected, finding, onToggle, onCrawl, onFind, onOpen, onDragEnd,
}: {
  u: University; selected: boolean; finding: boolean;
  onToggle: () => void; onCrawl: () => void; onFind: () => void; onOpen: () => void; onDragEnd: () => void;
}) {
  const controls = useDragControls();
  return (
    <Reorder.Item
      value={u} as="div" dragListener={false} dragControls={controls} onDragEnd={onDragEnd}
      className={`${GRID} bg-white px-4 py-3 transition-colors hover:bg-slate-50/60 dark:bg-transparent dark:hover:bg-white/5`}
    >
      <span
        onPointerDown={(e) => controls.start(e)}
        className="cursor-grab touch-none select-none text-center text-slate-400 hover:text-slate-600 active:cursor-grabbing"
        title="Drag to reorder (crawl order)"
      >⋮⋮</span>
      <input type="checkbox" checked={selected} onChange={onToggle} className="h-4 w-4 cursor-pointer accent-brand-500" />
      <RowCells u={u} finding={finding} onFind={onFind} onCrawl={onCrawl} onOpen={onOpen} />
    </Reorder.Item>
  );
}

/** The 7 content cells shared by draggable + plain rows (handle + checkbox precede). */
function RowCells({
  u, finding, onFind, onCrawl, onOpen,
}: {
  u: University; finding: boolean; onFind: () => void; onCrawl: () => void; onOpen: () => void;
}) {
  const courses = coursesOf(u);
  const verified = u.verified_courses != null;
  return (
    <>
      <div className="min-w-0">
        <button onClick={onOpen} className="block max-w-full truncate text-left font-medium text-slate-800 hover:text-brand-600 hover:underline" title="View verified URLs">{u.name}</button>
        {u.base_url ? (
          <a href={u.base_url} target="_blank" rel="noreferrer" className="block truncate text-xs text-brand-600 hover:underline">{u.base_url}</a>
        ) : finding ? (
          <span className="text-xs text-slate-400">finding website…</span>
        ) : (
          <button onClick={onFind} className="text-xs font-medium text-accent-600 hover:underline dark:text-accent-300">+ Find website</button>
        )}
      </div>
      <div className="truncate text-slate-600">{u.country}</div>
      <div><Badge value={u.crawl_status} /></div>
      <div className="tnum text-slate-600">{u.total_links_found}</div>
      <div className="tnum text-slate-600">{validOf(u)}</div>
      <div className="tnum font-semibold text-brand-600" title={verified ? "Verified count from the validated export" : "Live estimate — run Revalidate for the verified count"}>
        {courses}
        {verified && (
          <span className="ml-1 align-middle text-emerald-500" title="Verified from the validated export">
            <svg viewBox="0 0 24 24" className="inline h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
          </span>
        )}
      </div>
      <div className="flex items-center justify-end gap-1.5">
        <Button variant="ghost" onClick={onOpen}>URLs</Button>
        <Button variant="secondary" onClick={onCrawl} disabled={!u.base_url}>Crawl</Button>
      </div>
    </>
  );
}
