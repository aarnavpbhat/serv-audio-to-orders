import { getConfig } from "@serv/config";
import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { Sidebar } from "@/components/Sidebar";
import { THEME_SCRIPT } from "@/components/ThemeToggle";
import { TooltipProvider } from "@/components/ui/Tooltip";
import { settings } from "@/lib/data";
import "./globals.css";

// Serv's default family (servtech.co's --default-font-family), self-hosted at build time.
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

export const metadata: Metadata = {
  title: "Serv Audio to Orders",
  description: "Drive-thru audio to structured orders, step by step",
};

export const dynamic = "force-dynamic";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const s = settings();
  return (
    // The theme script sets data-theme before paint, so the server's value may differ.
    <html lang="en" data-theme="dark" className={inter.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="overflow-hidden">
        <TooltipProvider delayDuration={400}>
          <div className="flex h-full">
            <Sidebar keys={s.keys} geminiModel={s.geminiModel} devRoutes={getConfig().enableDevRoutes} />
            <main className="relative min-w-0 flex-1 overflow-y-auto">{children}</main>
          </div>
        </TooltipProvider>
      </body>
    </html>
  );
}
