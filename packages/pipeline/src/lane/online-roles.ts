/**
 * Crew or customer for each finalized line on mixed audio, using only lines
 * already heard (no look-ahead). Diarized speakers get their role from crew
 * phrase cues; when diarization puts everyone under one voice, roles come from
 * wording and turn-taking and are marked as guessed (shown with "?").
 */
import { assignRoles, diarizationCollapsed, inferTurnRoles } from "../transcribe/roles";

interface Line {
  label: string;
  text: string;
  start_s: number;
  end_s: number;
}

export class OnlineRoles {
  private readonly history: Line[] = [];

  assign(label: string, text: string, start_s: number, end_s: number): { role: "crew" | "customer"; guessed: boolean } {
    this.history.push({ label, text, start_s, end_s });
    const labels = this.history.map((h) => h.label);
    const voices = new Set(labels).size;
    const collapsed = this.history.length >= 4 && diarizationCollapsed(labels);
    if (voices >= 2 && !collapsed) {
      const roles = assignRoles(this.history.map((h) => ({ label: h.label, text: h.text })));
      if (!roles.ambiguous) return { role: roles.crew.has(label) ? "crew" : "customer", guessed: false };
    }
    const recent = this.history.slice(-8);
    return { role: inferTurnRoles(recent).at(-1) ?? "customer", guessed: true };
  }
}
