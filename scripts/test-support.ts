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
  const vaultCalls = { deleted: [] as string[], trashed: [] as string[] };
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
    /** Obsidian's vault.copy: a new file with the same content. */
    copy: async (file: TFile, newPath: string) => {
      const normalised = newPath.replace(/^[/]+/, "");
      if (find(normalised)) throw new Error("File already exists: " + normalised);
      const entry = new TFile(normalised, folderFor(normalised));
      (entry as unknown as { stat: { mtime: number } }).stat = { mtime: Date.now() };
      (entry as unknown as { content: string }).content = (file as unknown as { content: string }).content;
      store.push(entry);
      return entry;
    },
    /** Permanent delete. */
    delete: async (file: TFile) => {
      vaultCalls.deleted.push(file.path);
      const index = store.findIndex((entry) => entry.path === file.path);
      if (index >= 0) store.splice(index, 1);
    },
    /** The older trash API, used when fileManager.trashFile is unavailable. */
    trash: async (file: TFile) => {
      vaultCalls.trashed.push(file.path);
      const index = store.findIndex((entry) => entry.path === file.path);
      if (index >= 0) store.splice(index, 1);
    },
  };

  return { vault, folders, store, vaultCalls };
}

export interface FakeFileOps {
  /** Paths handed to fileManager.trashFile (Obsidian's own delete). */
  trashed: string[];
  /** Paths handed to vault.delete(..., true). */
  deleted: string[];
  /** Renames Obsidian performed, in order. */
  renamed: { from: string; to: string }[];
}

export function makeAppObject(files: FakeFile[]) {
  const { vault, store, vaultCalls } = makeApp(files);
  let activePath: string | null = null;
  const calls: FakeFileOps = { trashed: vaultCalls.trashed, deleted: vaultCalls.deleted, renamed: [] };

  function stripLeading(path: string): string {
    return path.replace(/^[/]+/, "");
  }

  function updateLinks(from: string, to: string): void {
    const oldName = from.slice(from.lastIndexOf("/") + 1).replace(".md", "");
    const newName = to.slice(to.lastIndexOf("/") + 1).replace(".md", "");
    if (oldName === newName) return;
    // What Obsidian does for a rename: wikilinks elsewhere follow the note.
    for (const entry of store) {
      const content = (entry as unknown as { content: string }).content;
      const updated = content.split("[[" + oldName + "]]").join("[[" + newName + "]]");
      if (updated !== content) (entry as unknown as { content: string }).content = updated;
    }
  }

  const fileManager = {
    async renameFile(file: { path: string }, newPath: string): Promise<void> {
      const normalised = stripLeading(newPath);
      if (store.some((entry) => entry.path === normalised)) throw new Error("File already exists: " + normalised);
      const entry = store.find((item) => item.path === file.path);
      if (!entry) throw new Error("not found: " + file.path);
      const from = entry.path;
      (entry as unknown as { path: string }).path = normalised;
      calls.renamed.push({ from, to: normalised });
      updateLinks(from, normalised);
    },
    /** Obsidian honours the user's "Deleted files" preference here. */
    async trashFile(file: { path: string }): Promise<void> {
      calls.trashed.push(file.path);
      const index = store.findIndex((entry) => entry.path === file.path);
      if (index >= 0) store.splice(index, 1);
    },
  };

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
    fileManager,
    /** Test helper: every trash/delete/rename this harness was asked to perform. */
    fileOps: calls,
    /** Test helper: pretend Obsidian has this note open while the sidebar has focus. */
    setActiveFile: (path: string | null) => {
      activePath = path;
    },
  };
  return app as unknown as import("obsidian").App;
}
