/** Starts the slow-phase webhook retry worker inside the Next.js server process. */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startWorker } = await import("./lib/jobs");
  startWorker();
}
