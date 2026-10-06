"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";

/**
 * The two ways to stop a live stream (E3). End session sends the open
 * conversation now; Discard drops it and sends nothing, so it asks first.
 */
export function StopButtons({ onStop, disabled, size = "default" }: { onStop: (mode: "end" | "discard") => void | Promise<void>; disabled?: boolean; size?: "default" | "sm" }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = async (mode: "end" | "discard") => {
    setBusy(true);
    setConfirming(false);
    try {
      await onStop(mode);
    } finally {
      setBusy(false);
    }
  };
  if (confirming) {
    return (
      <span className="flex items-center gap-2 text-[12.5px]">
        <span className="text-muted-foreground">Discard this session? The open conversation is dropped and nothing is sent.</span>
        <Button size={size} variant="destructive" onClick={() => void run("discard")}>
          Yes, discard
        </Button>
        <Button size={size} variant="ghost" onClick={() => setConfirming(false)}>
          Keep
        </Button>
      </span>
    );
  }
  return (
    <span className="flex items-center gap-2">
      <Button size={size} variant="secondary" disabled={disabled || busy} onClick={() => void run("end")} title="Send the open conversation now, then stop">
        End session
      </Button>
      <Button size={size} variant="outline" disabled={disabled || busy} onClick={() => setConfirming(true)} title="Drop the open conversation and send nothing">
        Discard
      </Button>
    </span>
  );
}
