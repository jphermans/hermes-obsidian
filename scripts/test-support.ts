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
    configDir: ".obsidian",
    getAbstractFileByPath: find,
    getMarkdownFiles: () => store.filter((entry) => entry.extension === "md").slice(),
    getFiles: () => store.slice(),
    adapter: {
      files: new Map(),
      async write(path, data) {
        this.files.set(path, data);
      },
      async read(path) {
        if (!this.files.has(path)) throw new Error("ENOENT: " + path);
        return this.files.get(path);
      },
      async exists(path) {
        return this.files.has(path);
      },
      async remove(path) {
        this.files.delete(path);
      },
      async mkdir() {},
    },
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
  const { vault, store } = makeApp(files);
  let activePath: string | null = null;
  const workspace = {
    activeEditor: null,
    getActiveViewOfType: () => null,
    getActiveFile: () => (activePath ? store.find((entry) => entry.path === activePath) || null : null),
    on: () => ({}),
    getLeavesOfType: () => [],
    getRightLeaf: () => null,
    // A leaf that can actually open a file: otherwise the "open after create"
    // path throws and the failure hides inside a catch.
    getLeaf: () => ({
      openFile: async () => {},
      setViewState: async () => {},
    }),
    revealLeaf() {},
    detachLeavesOfType() {},
  };
  const app = {
    vault,
    workspace,
    /** Test helper: pretend Obsidian has this note open while the sidebar has focus. */
    setActiveFile: (path: string | null) => {
      activePath = path;
    },
  };
  return app as unknown as import("obsidian").App;
}
