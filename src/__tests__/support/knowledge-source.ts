// Import-source provenance checks only. Runtime knowledge is fetched from Product.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { OfficeKey } from "../../customers/abita/profile.js";
const root = join(import.meta.dirname, "..", "..", "..");
export function readOfficeKnowledgeSource(officeKey: OfficeKey): string {
  const manifest = JSON.parse(
    readFileSync(join(root, "docs/knowledge/manifest.json"), "utf8"),
  ) as { offices: { officeKey: string; sourcePath: string }[] };
  const source = manifest.offices.find(
    (office) => office.officeKey === officeKey,
  );
  if (!source) throw new Error(`No archived source for ${officeKey}`);
  return readFileSync(join(root, source.sourcePath), "utf8");
}
