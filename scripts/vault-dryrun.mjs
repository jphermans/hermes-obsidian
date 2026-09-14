/**
 * Dry-run of the shipped vault-convention engine against a REAL vault on disk.
 * Usage: node scripts/vault-dryrun.mjs "/path/to/vault" [sampleSize]
 */

import fs from "node:fs";
import path from "node:path";
import * as hermes from "./.build/tests.mjs";

const vaultRoot = process.argv[2];
const sampleSize = Number(process.argv[3] || 120);
if (!vaultRoot) {
  console.error("usage: node scripts/vault-dryrun.mjs <vaultPath> [sampleSize]");
  process.exit(2);
}

const files = [];
function walk(dir, relative) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    const rel = relative ? relative + "/" + entry.name : entry.name;
    if (entry.isDirectory()) walk(full, rel);
    else if (entry.name.endsWith(".md")) {
      const stat = fs.statSync(full);
      files.push({ path: rel, content: fs.readFileSync(full, "utf8"), mtime: stat.mtimeMs });
    }
  }
}

const started = Date.now();
walk(vaultRoot, "");
console.log("read " + files.length + " markdown files in " + (Date.now() - started) + " ms");

const app = hermes.makeAppObject(files);
const scanStart = Date.now();
const conventions = await hermes.scanVault(app, sampleSize);
console.log("scanVault(" + sampleSize + ") took " + (Date.now() - scanStart) + " ms");

console.log("\n--- report ---");
console.log(hermes.conventionsReport(conventions, 30));
console.log("\n--- frontmatter template handed to Hermes ---");
console.log(hermes.defaultFrontmatterTemplate(conventions));
console.log("\n--- system prompt size ---");
const context = {
  vaultName: "Obsidian Vault",
  targetFolder: "13.00 AI",
  notePath: "13.00 AI/Test.md",
  noteTitle: "Test",
  activeNoteContent: "# Test\n",
  existingNotes: hermes.listNotesInFolder(app, "13.00 AI", 60),
  folderList: hermes.listFolders(app).slice(0, 60),
  includeFrontmatter: true,
  frontmatterTemplate: hermes.defaultFrontmatterTemplate(conventions),
  conventions,
  language: "auto",
};
const prompt = hermes.systemPrompt("create", context);
console.log(prompt.length + " characters ≈ " + Math.round(prompt.length / 4) + " tokens");
console.log("existing notes offered for linking: " + context.existingNotes.length);
