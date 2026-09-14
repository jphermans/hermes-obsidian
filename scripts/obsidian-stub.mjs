/**
 * Test-time stand-in for the `obsidian` runtime module.
 * Only the APIs the tested modules import are implemented; requestUrl is a real
 * HTTP client so the API tests exercise the shipped networking code.
 */

import yaml from "js-yaml";

export class TFile {
  path;
  basename;
  extension;
  parent;

  constructor(path, parent) {
    this.path = path;
    const slash = path.lastIndexOf("/");
    const name = slash < 0 ? path : path.slice(slash + 1);
    const dot = name.lastIndexOf(".");
    this.basename = dot > 0 ? name.slice(0, dot) : name;
    this.extension = dot > 0 ? name.slice(dot + 1) : "";
    this.parent = parent;
  }
}

export class TFolder {
  path;
  children = [];

  constructor(path) {
    this.path = path;
  }
}

export class App {}

export class Notice {
  constructor(message) {
    this.message = message;
  }
  hide() {}
}

export const Platform = {
  isDesktop: true,
  isMobile: false,
  isMacOS: true,
  isWin: false,
  isLinux: false,
  isIosApp: false,
  isAndroidApp: false,
};

/** Test helper: pretend to run on a phone. */
export function setPlatform(values) {
  Object.assign(Platform, values);
}

export function normalizePath(path) {
  const parts = [];
  for (const part of String(path == null ? "" : path).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  const out = parts.join("/");
  return out.length === 0 ? "/" : out;
}

export function parseYaml(text) {
  return yaml.load(text);
}

export function stringifyYaml(value) {
  return yaml.dump(value, { lineWidth: -1 });
}

export async function requestUrl(request) {
  const options = typeof request === "string" ? { url: request } : request;
  const response = await fetch(options.url, {
    method: options.method || "GET",
    headers: options.headers || {},
    body: options.body,
  });
  const text = await response.text();
  return {
    status: response.status,
    text,
    headers: Object.fromEntries(response.headers.entries()),
    get json() {
      return JSON.parse(text);
    },
    arrayBuffer: () => new TextEncoder().encode(text).buffer,
  };
}

/* --- minimal DOM so plugin classes can be instantiated in node ----------- */

function makeEl(tag = "div") {
  const el = {
    tagName: tag,
    children: [],
    style: {},
    dataset: {},
    textContent: "",
    value: "",
    type: "",
    rows: 0,
    placeholder: "",
    classList: { add() {}, remove() {}, contains: () => false },
    createEl: (childTag, options) => {
      const child = makeEl(childTag);
      if (options && options.text) child.textContent = options.text;
      el.children.push(child);
      return child;
    },
    createDiv: (options) => el.createEl("div", options),
    addClass() {},
    removeClass() {},
    toggleClass() {},
    setText(text) {
      el.textContent = text;
    },
    setAttr() {},
    getAttr: () => null,
    removeAttribute() {},
    addEventListener() {},
    appendChild(child) {
      el.children.push(child);
      return child;
    },
    empty() {
      el.children = [];
    },
    querySelector: () => null,
    focus() {},
    scrollIntoView() {},
    remove() {},
  };
  return el;
}

export function createEl(tag) {
  return makeEl(tag);
}

export class Component {
  load() {}
  unload() {}
  onload() {}
  onunload() {}
  addChild(child) {
    return child;
  }
  registerEvent() {}
}

export class WorkspaceLeaf extends Component {}

export class Editor {
  getValue() {
    return "";
  }
  getSelection() {
    return "";
  }
  replaceSelection() {}
  getCursor() {
    return { line: 0, ch: 0 };
  }
}

export class ItemView extends Component {
  constructor(leaf) {
    super();
    this.leaf = leaf;
    this.contentEl = makeEl();
    this.containerEl = makeEl();
  }
  getViewType() {
    return "";
  }
  getDisplayText() {
    return "";
  }
  getIcon() {
    return "";
  }
}

export class MarkdownView extends ItemView {
  constructor() {
    super(new WorkspaceLeaf());
    this.editor = new Editor();
    this.file = null;
  }
}

export class Modal extends Component {
  constructor(app) {
    super();
    this.app = app;
    this.contentEl = makeEl();
    this.titleEl = makeEl();
  }
  open() {}
  close() {}
}

export class Setting {
  constructor(containerEl) {
    this.containerEl = containerEl || makeEl();
    this.controlEl = makeEl("input");
    this.inputEl = makeEl("input");
  }
  setName() {
    return this;
  }
  setDesc() {
    return this;
  }
  setHeading() {
    return this;
  }
  setClass() {
    return this;
  }
  addText(callback) {
    callback({
      inputEl: this.inputEl,
      setValue: () => this,
      setPlaceholder: () => this,
      onChange: () => this,
      setDisabled: () => this,
      setLimit: () => this,
    });
    return this;
  }
  addTextArea(callback) {
    const el = makeEl("textarea");
    callback({
      inputEl: el,
      setValue: () => this,
      setPlaceholder: () => this,
      onChange: () => this,
      setDisabled: () => this,
    });
    return this;
  }
  addToggle(callback) {
    callback({ setValue: () => this, onChange: () => this, setDisabled: () => this });
    return this;
  }
  addDropdown(callback) {
    callback({
      addOption: () => this,
      addOptions: () => this,
      setValue: () => this,
      onChange: () => this,
      selectEl: makeEl("select"),
    });
    return this;
  }
  addSlider(callback) {
    callback({
      setLimits: () => this,
      setValue: () => this,
      setDynamicTooltip: () => this,
      onChange: () => this,
    });
    return this;
  }
  addButton(callback) {
    callback({
      setButtonText: () => this,
      setIcon: () => this,
      setTooltip: () => this,
      setCta: () => this,
      onClick: () => this,
      buttonEl: makeEl("button"),
    });
    return this;
  }
  addExtraButton(callback) {
    return this.addButton(callback);
  }
}

export class MarkdownRenderer {
  static async render() {}
  static async renderMarkdown() {}
}

export class FuzzySuggestModal extends Modal {
  emptyStateText = "";
  setPlaceholder() {
    return this;
  }
  setInstructions() {
    return this;
  }
  getItems() {
    return [];
  }
  getItemText() {
    return "";
  }
  onChooseItem() {}
}

export class SuggestModal extends FuzzySuggestModal {}

export class PluginSettingTab {
  constructor(app, plugin) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = makeEl();
  }
  display() {}
}

export class Plugin extends Component {
  constructor(app, manifest) {
    super();
    this.app = app;
    this.manifest = manifest || { id: "hermes-agent-notes", version: "0.0.0" };
    this.__data = null;
  }
  async loadData() {
    return this.__data;
  }
  async saveData(data) {
    this.__data = JSON.parse(JSON.stringify(data));
  }
  registerView() {}
  addSettingTab() {}
  addRibbonIcon() {
    return makeEl();
  }
  addCommand() {}
  addStatusBarItem() {
    return makeEl();
  }
  registerEvent() {}
}

