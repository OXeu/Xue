// Migrate existing images from {session}_{msgId} naming to {phash} naming
// Run: bun run scripts/migrate-images.mjs

import { readFileSync, renameSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { computeDHashFromBuffer } from "../src/phash.ts";

const IMG_DIR = "data/prod/images";

const files = [
  "group_313214094_1072888079.jpeg",
  "group_313214094_1648735303.jpeg",
  "group_313214094_1769024260.gif",
  "group_313214094_1956145287.jpeg",
  "group_313214094_2146700513.png",
];

for (const f of files) {
  const buf = readFileSync(join(IMG_DIR, f));
  const phash = await computeDHashFromBuffer(buf);
  const ext = f.split(".").pop();
  const newName = `${phash}.${ext}`;

  // Remove old meta file (we use .meta now, not .json)
  const oldMeta = f.replace(/\.(jpeg|gif|png)$/, ".json");
  const oldMetaPath = join(IMG_DIR, oldMeta);
  if (existsSync(oldMetaPath)) {
    unlinkSync(oldMetaPath);
    console.log(`  removed old meta: ${oldMeta}`);
  }

  // Rename image
  renameSync(join(IMG_DIR, f), join(IMG_DIR, newName));

  // Write minimal .meta
  const mime = ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : "image/jpeg";
  writeFileSync(join(IMG_DIR, `${phash}.meta`), JSON.stringify({ mime }) + "\n");

  // Compute phash for inference file update (for 1648735303.jpeg which had no inference record)
  console.log(`${f} → ${newName} (phash=${phash}, mime=${mime})`);
}

console.log("\nDone. Update inference file for any new phashes as needed.");
