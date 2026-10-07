import { wrapAsync } from "@/lib/error-handler";
import { listFixtureAudio } from "@/lib/fixtures";

export const GET = wrapAsync(async () => Response.json(listFixtureAudio()));
