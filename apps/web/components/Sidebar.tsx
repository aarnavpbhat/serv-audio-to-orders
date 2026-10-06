"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { ScrollArea } from "@/components/ui/ScrollArea";
import { Separator } from "@/components/ui/Separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/Tooltip";
import { cn } from "@/lib/utils";
import { Artwork } from "./Artwork";
import { ThemeToggle } from "./ThemeToggle";
import { ChartIcon, CheckIcon, Equalizer, InboxIcon, ListIcon, LiveIcon, MicIcon, SearchIcon, WaveIcon } from "./Icons";

interface RecentRun {
  id: string;
  source_file: string;
  status: string;
  order_count: number;
}

const NAV = [
  { href: "/", label: "Runs", icon: WaveIcon },
  { href: "/live", label: "Live", icon: LiveIcon },
  { href: "/orders", label: "Orders", icon: ListIcon },
  { href: "/mock-webhook", label: "Mock Webhook", icon: InboxIcon },
  { href: "/eval", label: "Eval", icon: ChartIcon },
];

export function Sidebar({ keys, geminiModel, devRoutes }: { keys: { deepgram: boolean; gemini: boolean }; geminiModel: string; devRoutes: boolean }) {
  const path = usePathname();
  const router = useRouter();
  const [q, setQ] = useState("");
  const [recent, setRecent] = useState<RecentRun[]>([]);
  const [reviewCount, setReviewCount] = useState(0);

  // E5: the review queue's size, as a badge on Review.
  useEffect(() => {
    if (!devRoutes) return;
    let alive = true;
    const load = async () => {
      const res = await fetch("/api/review/count", { cache: "no-store" }).catch(() => null);
      if (alive && res?.ok) setReviewCount(((await res.json()) as { count: number }).count);
    };
    const first = setTimeout(() => void load(), 0);
    const t = setInterval(() => void load(), 5000);
    return () => {
      alive = false;
      clearTimeout(first);
      clearInterval(t);
    };
  }, [devRoutes]);

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
    <aside className="flex h-full w-[232px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground backdrop-blur-2xl backdrop-saturate-150">
      <Link href="/" className="flex items-center gap-2.5 px-5 pb-3 pt-5" aria-label="Serv Audio to Orders">
        {/* servtech.co's white logo; the light theme turns it black (--c-logo-filter). */}
        <Image src="/serv-logo-white.png" alt="Serv" width={644} height={204} priority className="h-[18px] w-auto [filter:var(--c-logo-filter)]" />
        <span className="text-[14px] text-muted-foreground">Audio to Orders</span>
      </Link>

      <form onSubmit={search} className="relative px-3 pb-3">
        <SearchIcon className="pointer-events-none absolute left-5 top-2 size-3.5 text-muted-foreground" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search runs and fixtures" aria-label="Search" className="h-7 border-transparent bg-muted pl-7 text-[13px] md:text-[13px] dark:bg-muted" />
      </form>

      <nav className="flex flex-col gap-px px-3">
        {[...NAV, ...(devRoutes ? [{ href: "/simulator", label: "Simulator", icon: MicIcon }, { href: "/review", label: "Review", icon: CheckIcon }] : [])].map((n) => {
          const active = n.href === "/" ? path === "/" || path.startsWith("/runs") : path.startsWith(n.href);
          return (
            <Button key={n.href} asChild variant="ghost" size="sm" className={cn("h-7 justify-start gap-2.5 px-2 text-[13px] font-normal", active && "bg-fill-strong font-medium hover:bg-fill-strong")}>
              <Link href={n.href}>
                <n.icon className="size-4 text-brand" />
                {n.label}
                {n.href === "/review" && reviewCount > 0 && (
                  <span className="ml-auto rounded-full bg-brand px-1.5 text-[10.5px] font-semibold tabular-nums text-background" aria-label={`${reviewCount} orders to review`}>
                    {reviewCount}
                  </span>
                )}
              </Link>
            </Button>
          );
        })}
      </nav>

      <div className="label mt-5 px-5 pb-1.5 text-[10.5px]">Recent Runs</div>
      <ScrollArea className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:block!">
        <div className="flex flex-col gap-px px-3 pb-3">
          {recent.length === 0 && <p className="px-2 text-[12px] text-muted-foreground">No runs yet.</p>}
          {recent.map((r) => {
            const active = path === `/runs/${r.id}`;
            const busy = r.status === "running" || r.status === "queued";
            return (
              <Link key={r.id} href={`/runs/${r.id}`} className={cn("flex items-center gap-2 rounded-md px-2 py-1", active ? "bg-fill-strong" : "hover:bg-muted")}>
                <Artwork seed={r.source_file} size="xs" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] leading-tight">{r.source_file.replace(/\.mp3$/, "")}</span>
                  <span className="block truncate text-[11px] leading-tight text-muted-foreground">
                    {r.order_count} order{r.order_count === 1 ? "" : "s"} · {r.status.replace(/_/g, " ")}
                  </span>
                </span>
                {busy && <Equalizer className="text-brand" />}
              </Link>
            );
          })}
        </div>
      </ScrollArea>

      <Separator />
      <div className="space-y-1 px-5 py-3 text-[11px] text-muted-foreground">
        <Provider ok={keys.deepgram} label="Deepgram Nova-3" />
        <Provider ok={keys.gemini} label={`Gemini ${geminiModel.replace(/^gemini-/, "")}`} />
        <div className="pt-2">
          <ThemeToggle />
        </div>
      </div>
    </aside>
  );
}

function Provider({ ok, label }: { ok: boolean; label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex items-center gap-1.5">
          <span className={cn("size-1.5 rounded-full", ok ? "bg-emerald-500" : "bg-rose-500")} />
          <span className="truncate">{label}</span>
          <span className="ml-auto">{ok ? "key set" : "no key"}</span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="right">{ok ? "API key found in the environment" : "No API key in the environment"}</TooltipContent>
    </Tooltip>
  );
}
