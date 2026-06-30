"use client";

import { useRef, useState, type DragEvent } from "react";
import { Button } from "./ui";

function UploadIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-7 w-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M7 9l5-5 5 5" />
      <path d="M12 4v12" />
    </svg>
  );
}
function FileIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </svg>
  );
}

/**
 * Premium drag-and-drop file picker. Replaces the native "Choose File" control.
 * `onUpload` should perform the upload and return a result message.
 */
export function FileDropzone({
  accept = ".xlsx,.csv",
  templateUrl,
  onUpload,
}: {
  accept?: string;
  templateUrl?: string;
  onUpload: (file: File) => Promise<string>;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const choose = (f: File | null | undefined) => { if (f) { setFile(f); setMsg(""); } };
  const onDrop = (e: DragEvent) => { e.preventDefault(); setDrag(false); choose(e.dataTransfer.files?.[0]); };

  const upload = async () => {
    if (!file) return;
    setBusy(true);
    setMsg("");
    try {
      const result = await onUpload(file);
      setMsg(result);
      setFile(null);
      if (inputRef.current) inputRef.current.value = "";
    } catch (e) {
      setMsg(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && inputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
        className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-4 py-7 text-center transition-all ${
          drag
            ? "border-brand-400 bg-brand-50/60 dark:bg-brand-500/10"
            : "border-slate-300/80 hover:border-brand-400 hover:bg-slate-50 dark:border-white/15 dark:hover:bg-white/5"
        }`}
      >
        <div className={`mb-2 rounded-full p-2.5 transition-colors ${drag ? "bg-brand-100 text-brand-600 dark:bg-brand-500/20" : "bg-slate-100 text-slate-400 dark:bg-white/10"}`}>
          <UploadIcon />
        </div>
        {file ? (
          <div className="flex items-center gap-2 text-sm font-medium text-slate-700">
            <FileIcon /> {file.name}
          </div>
        ) : (
          <>
            <div className="text-sm font-medium text-slate-700">Drag &amp; drop, or <span className="text-brand-600">browse</span></div>
            <div className="mt-0.5 text-xs text-slate-400">Excel (.xlsx) or CSV</div>
          </>
        )}
        <input ref={inputRef} type="file" accept={accept} className="hidden" onChange={(e) => choose(e.target.files?.[0])} />
      </div>

      <div className="mt-3 flex items-center gap-3">
        <Button onClick={upload} disabled={!file || busy}>{busy ? "Importing…" : "Upload & import"}</Button>
        {templateUrl && <a className="text-xs text-brand-600 hover:underline" href={templateUrl} download>Download template</a>}
      </div>
      {msg && <div className="mt-2 text-sm text-slate-600">{msg}</div>}
    </div>
  );
}
