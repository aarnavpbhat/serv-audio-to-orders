"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Artwork } from "./Artwork";
import { ChartIcon, Equalizer, InboxIcon, SearchIcon, WaveIcon } from "./Icons";

interface RecentRun {
  id: string;
  source_file: string;
  status: string;
  order_count: number;
}

const NAV = [
  { href: "/", label: "Runs", icon: WaveIcon },
  { href: "/mock-webhook", label: "Mock Webhook", icon: InboxIcon },
  { href: "/eval", label: "Eval", icon: ChartIcon },
];

export function Sidebar({ keys, geminiModel }: { keys: { deepgram: boolean; gemini: boolean }; geminiModel: string }) {
  const path = usePathname();
  const router = useRouter();
  const [q, setQ] = useState("");
  const [recent, setRecent] = useState<RecentRun[]>([]);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const res = await fetch("/api/runs", { cache: "no-store" });
      if (alive && res.ok) setRecent(((await res.json()) as RecentRun[]).slice(0, 8));
    };
    void load();
    const t = setInterval(load, 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  function search(e: React.FormEvent) {
    e.preventDefault();
    router.push(q.trim() ? `/?q=${encodeURIComponent(q.trim())}` : "/");
  }

  return (
    <aside className="flex h-full w-[232px] shrink-0 flex-col border-r border-line bg-sidebar backdrop-blur-2xl backdrop-saturate-150">
      <Link href="/" className="flex items-center gap-2 px-5 pb-3 pt-5">
        <span className="grid h-6 w-6 place-items-center rounded-md bg-gradient-to-br from-[#ff5f6d] to-accent text-white">
          <WaveIcon className="h-3.5 w-3.5" />
        </span>
        <span className="text-[15px] font-semibold tracking-tight">Serv</span>
        <span className="text-[15px] text-muted">Orders</span>
      </Link>

      <form onSubmit={search} className="px-3 pb-3">
        <label className="flex items-center gap-1.5 rounded-md bg-fill px-2 py-1 text-muted focus-within:ring-2 focus-within:ring-accent/50">
          <SearchIcon className="h-3.5 w-3.5" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search runs and fixtures" className="w-full bg-transparent text-[13px] text-ink outline-none placeholder:text-muted" />
        </label>
      </form>

      <nav className="space-y-px px-3">
        {NAV.map((n) => {
          const active = n.href === "/" ? path === "/" || path.startsWith("/runs") : path.startsWith(n.href);
          return (
            <Link key={n.href} href={n.href} className={`flex items-center gap-2.5 rounded-md px-2 py-[5px] text-[13px] ${active ? "bg-fill-strong font-medium text-ink" : "text-ink/85 hover:bg-fill"}`}>
              <n.icon className="h-4 w-4 text-accent" />
              {n.label}
            </Link>
          );
        })}
      </nav>

      <div className="label mt-5 px-5 pb-1.5 text-[10.5px]">Recent Runs</div>
      <div className="no-scrollbar min-h-0 flex-1 space-y-px overflow-y-auto px-3 pb-3">
        {recent.length === 0 && <p className="px-2 text-[12px] text-muted">No runs yet.</p>}
        {recent.map((r) => {
          const active = path === `/runs/${r.id}`;
          const busy = r.status === "running" || r.status === "queued";
          return (
            <Link key={r.id} href={`/runs/${r.id}`} className={`flex items-center gap-2 rounded-md px-2 py-1 ${active ? "bg-fill-strong" : "hover:bg-fill"}`}>
              <Artwork seed={r.source_file} size="xs" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] leading-tight">{r.source_file.replace(/\.mp3$/, "")}</span>
                <span className="block truncate text-[11px] leading-tight text-muted">
                  {r.order_count} order{r.order_count === 1 ? "" : "s"} · {r.status.replace(/_/g, " ")}
                </span>
              </span>
              {busy && <Equalizer className="text-accent" />}
            </Link>
          );
        })}
      </div>

      <div className="space-y-1 border-t border-line px-5 py-3 text-[11px] text-muted">
        <Provider ok={keys.deepgram} label="Deepgram Nova-3" />
        <Provider ok={keys.gemini} label={`Gemini ${geminiModel.replace(/^gemini-/, "")}`} />
      </div>
    </aside>
  );
}

function Provider({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className="flex items-center gap-1.5" title={ok ? "API key set" : "No API key"}>
      <span className={`h-1.5 w-1.5 rounded-full ${ok ? "bg-emerald-500" : "bg-rose-500"}`} />
      <span className="truncate">{label}</span>
      <span className="ml-auto">{ok ? "key set" : "no key"}</span>
    </div>
  );
}
