import type { Metadata } from "next";
import { Sidebar } from "@/components/Sidebar";
import { TooltipProvider } from "@/components/ui/Tooltip";
import { settings } from "@/lib/data";
import "./globals.css";

export const metadata: Metadata = {
  title: "Serv Audio-to-Orders Sandbox",
  description: "Drive-thru audio to structured orders, step by step",
};

export const dynamic = "force-dynamic";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const s = settings();
  return (
    <html lang="en">
      <body className="overflow-hidden">
        <TooltipProvider delayDuration={400}>
          <div className="flex h-full">
            <Sidebar keys={s.keys} geminiModel={s.geminiModel} />
            <main className="relative min-w-0 flex-1 overflow-y-auto">{children}</main>
          </div>
        </TooltipProvider>
      </body>
    </html>
  );
}
