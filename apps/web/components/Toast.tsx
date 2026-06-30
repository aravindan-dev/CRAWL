"use client";

import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";

type ToastType = "success" | "error" | "info";
interface Toast { id: number; type: ToastType; message: string }

const ToastCtx = createContext<(message: string, type?: ToastType) => void>(() => {});
export function useToast() {
  return useContext(ToastCtx);
}

const STYLE: Record<ToastType, { ring: string; dot: string; icon: ReactNode }> = {
  success: { ring: "ring-emerald-500/25", dot: "bg-emerald-500", icon: "✓" },
  error: { ring: "ring-rose-500/25", dot: "bg-rose-500", icon: "!" },
  info: { ring: "ring-brand-500/25", dot: "bg-brand-500", icon: "i" },
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((message: string, type: ToastType = "info") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, type, message }]);
    const ttl = type === "error" ? 6000 : 3500;
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), ttl);
  }, []);

  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed right-4 top-4 z-[60] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
        <AnimatePresence initial={false}>
          {toasts.map((t) => {
            const s = STYLE[t.type];
            return (
              <motion.div
                key={t.id}
                layout
                initial={{ opacity: 0, x: 60, scale: 0.95 }}
                animate={{ opacity: 1, x: 0, scale: 1 }}
                exit={{ opacity: 0, x: 60, scale: 0.9 }}
                transition={{ type: "spring", stiffness: 420, damping: 32 }}
                className={`pointer-events-auto flex items-start gap-3 rounded-xl border border-white/60 bg-white/90 p-3 shadow-glass ring-1 backdrop-blur-xl dark:border-white/10 dark:bg-ink-800/90 ${s.ring}`}
              >
                <span className={`mt-0.5 flex h-5 w-5 flex-none items-center justify-center rounded-full text-[11px] font-bold text-white ${s.dot}`}>{s.icon}</span>
                <span className="flex-1 text-sm text-slate-700">{t.message}</span>
                <button onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))} className="text-slate-400 transition-colors hover:text-slate-600">✕</button>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </ToastCtx.Provider>
  );
}
