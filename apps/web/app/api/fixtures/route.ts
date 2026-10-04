import { listFixtureAudio } from "@/lib/fixtures";

export function GET() {
  return Response.json(listFixtureAudio());
}
