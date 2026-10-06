import { expect, test } from "@playwright/test";

// v2.1 step 5: Serv's tokens keep text readable (WCAG AA, 4.5:1) in both themes.
// Colors are resolved by the browser (oklch, color-mix and alpha included) and
// composited over the surface they sit on before measuring.
const PAIRS: [text: string, surface: string][] = [
  ["--foreground", "--background"],
  ["--muted-foreground", "--background"],
  ["--foreground", "--card"],
  ["--muted-foreground", "--card"],
  ["--primary-foreground", "--primary"],
  ["--c-accent", "--background"],
  ["--c-accent", "--card"],
  ["--destructive", "--background"],
  ["--sidebar-foreground", "--background"],
];

for (const theme of ["dark", "light"] as const) {
  test(`text contrast is at least 4.5:1 in the ${theme} theme`, async ({ page }) => {
    await page.addInitScript((t) => localStorage.setItem("serv-theme", t), theme);
    await page.goto("/eval");
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    const ratios = await page.evaluate((pairs) => {
      const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D;
      const css = getComputedStyle(document.documentElement);
      /** The token's color painted over `under` (the page background first), as sRGB 0-255. */
      const paint = (token: string, under?: string) => {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = css.getPropertyValue("--background").trim() || "#000";
        ctx.fillRect(0, 0, 1, 1);
        if (under) {
          ctx.fillStyle = css.getPropertyValue(under).trim();
          ctx.fillRect(0, 0, 1, 1);
        }
        ctx.fillStyle = css.getPropertyValue(token).trim();
        ctx.fillRect(0, 0, 1, 1);
        return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
      };
      const lum = (rgb: number[]) => {
        const [r, g, b] = rgb.map((v) => {
          const c = v / 255;
          return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        }) as [number, number, number];
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      return pairs.map(([text, surface]) => {
        const bg = lum(paint(surface));
        const fg = lum(paint(text, surface));
        const ratio = (Math.max(bg, fg) + 0.05) / (Math.min(bg, fg) + 0.05);
        return `${text} on ${surface}: ${ratio.toFixed(2)}`;
      });
    }, PAIRS);
    const low = ratios.filter((r) => Number(r.split(": ")[1]) < 4.5);
    expect(low, ratios.join("\n")).toEqual([]);
  });
}
