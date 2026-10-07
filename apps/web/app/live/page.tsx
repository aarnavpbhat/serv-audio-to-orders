import { notFound } from "next/navigation";

// The Live page is disabled for now (2026-10-06): it answers 404 and is not in the sidebar.
// Test Lab and the simulator still show the same lane view for the stream they start, and
// stop it themselves. To bring it back, restore this file's render of
// components/live/LivePage (with isLocalHeaders) and its Sidebar entry from git history.
export default function Live() {
  notFound();
}
