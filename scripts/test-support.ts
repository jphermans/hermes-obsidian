/**
 * In-memory vault used by the tests: mirrors the slice of the Obsidian App
 * API that the plugin actually calls, so file creation, collision handling,
 * frontmatter merging and the vault scan are exercised for real.
 */

import { TFile, TFolder } from "obsidian";

export interface FakeFile {
  path: string;
  content: string;
  mtime?: number;
}

interface FolderNode {
  path: string;
}

function folderFor(path: string): FolderNode {
  const slash = path.lastIndexOf("/");
  const dir = slash <= 0 ? "/" : path.slice(0, slash);
  return { path: dir };
}

export function makeApp(files: FakeFile[]) {
  const folders = new Set<string>();
  const store = files.map((file, index) => {
    const parent = folderFor(file.path);
    const entry = new TFile(file.path, parent);
    (entry as unknown as { stat: { mtime: number } }).stat = { mtime: file.mtime ?? 1000 + index };
    (entry as unknown as { content: string }).content = file.content;
    return entry;
  });

  function find(path: string): TFile | TFolder | null {
    const normalised = path.replace(/^[/]+/, "").replace(/[/]+$/, "");
    const file = store.find((entry) => entry.path === normalised);
    if (file) return file;
    if (folders.has(normalised)) return new TFolder(normalised);
    return null;
  }

  const vault = {
    getName: () => "TestVault",
    getAbstractFileByPath: find,
    getMarkdownFiles: () => store.filter((entry) => entry.extension === "md").slice(),
    read: async (file: TFile) => (file as unknown as { content: string }).content,
    cachedRead: async (file: TFile) => (file as unknown as { content: string }).content,
    modify: async (file: TFile, content: string) => {
      (file as unknown as { content: string }).content = content;
      (file as unknown as { stat: { mtime: number } }).stat.mtime = Date.now();
    },
    create: async (path: string, content: string) => {
      const normalised = path.replace(/^[/]+/, "");
      if (find(normalised)) throw new Error("File already exists: " + normalised);
      const parent = folderFor(normalised);
      const entry = new TFile(normalised, parent);
      (entry as unknown as { stat: { mtime: number } }).stat = { mtime: Date.now() };
      (entry as unknown as { content: string }).content = content;
      store.push(entry);
      return entry;
    },
    createFolder: async (path: string) => {
      const normalised = path.replace(/^[/]+/, "");
      if (folders.has(normalised)) throw new Error("Folder already exists: " + normalised);
      folders.add(normalised);
      return new TFolder(normalised);
    },
  };

  return { vault, folders, store };
}

export function makeAppObject(files: FakeFile[]) {
  const { vault } = makeApp(files);
  const workspace = {
    getActiveViewOfType: () => null,
    on: () => ({}),
    getLeavesOfType: () => [],
    getRightLeaf: () => null,
    getLeaf: () => null,
    revealLeaf() {},
    detachLeavesOfType() {},
  };
  return { vault, workspace } as unknown as import("obsidian").App;
}
