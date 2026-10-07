import { readFileSync } from "node:fs";
import { Catalog } from "./catalog";

export function loadCatalog(file: string): Catalog {
  return Catalog.fromJson(JSON.parse(readFileSync(file, "utf8")));
}
