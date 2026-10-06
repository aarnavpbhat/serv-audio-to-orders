import { getConfig } from "@serv/config";
import type { Metadata } from "next";
import { Inter } from "next/font/google";
import localFont from "next/font/local";
import { Sidebar } from "@/components/Sidebar";
import { THEME_SCRIPT } from "@/components/ThemeToggle";
import { TooltipProvider } from "@/components/ui/Tooltip";
import { settings } from "@/lib/data";
import "./globals.css";

// Serv's default family (servtech.co's --default-font-family), self-hosted at build time.
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
// Serv's headline face (servtech.co's landing font), from Fontshare under the ITF Free Font
// License in fonts/GeneralSans-LICENSE.txt. It allows self-hosting for our own app but not
// redistribution, so the font file must not be published (this repo is private).
const generalSans = localFont({ src: "./fonts/GeneralSans-Variable.woff2", weight: "200 700", variable: "--font-general-sans", display: "swap" });

export const metadata: Metadata = {
  title: "Serv Audio to Orders",
  description: "Drive-thru audio to structured orders, step by step",
};

export const dynamic = "force-dynamic";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const s = settings();
  return (
    // The theme script sets data-theme before paint, so the server's value may differ.
    <html lang="en" data-theme="dark" className={`${inter.variable} ${generalSans.variable}`} suppressHydrationWarning>
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
