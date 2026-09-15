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

export const notices = [];

export class Notice {
  constructor(message) {
    this.message = message;
    notices.push(message);
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
      // Keep the class name: the tests use it to find sections of the settings page.
      if (options && options.cls) child.className = options.cls;
      el.children.push(child);
      return child;
    },
    createDiv: (options) => el.createEl("div", options),
    createSpan: (options) => el.createEl("span", options),
    createSvg: (tag) => el.createEl(tag || "svg", {}),
    // Real enough to assert on: tests check which classes a render added.
    addClass: (...names) => {
      for (const name of names) {
        if (!name) continue;
        const present = (el.className || "").split(/\s+/).filter(Boolean);
        if (present.indexOf(name) < 0) {
          present.push(name);
          el.className = present.join(" ");
        }
      }
    },
    removeClass: (...names) => {
      const present = (el.className || "").split(/\s+/).filter(Boolean).filter((name) => names.indexOf(name) < 0);
      el.className = present.join(" ");
    },
    toggleClass: (name, force) => {
      const present = (el.className || "").split(/\s+/).filter(Boolean);
      const has = present.indexOf(name) >= 0;
      const want = force === undefined ? !has : !!force;
      if (want && !has) present.push(name);
      const next = want ? present : present.filter((entry) => entry !== name);
      el.className = next.join(" ");
    },
    appendText(text) {
      el.textContent = (el.textContent || "") + text;
      return el;
    },
    setText(text) {
      el.textContent = text;
    },
    setAttr() {},
    // Listeners are recorded so a test can click what a user would click; a no-op
    // addEventListener silently hid every UI flow from the suite.
    listeners: [],
    addEventListener(type, handler) {
      el.listeners.push({ type, handler });
      return el;
    },
    getAttr: () => null,
    removeAttribute() {},
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
  /** Obsidian returns a disposer; the harness only has to not throw. */
  register(callback) {
    return callback;
  }
  registerDomEvent() {}
  registerInterval() {}
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

export const openedModals = [];

export class Modal extends Component {
  constructor(app) {
    super();
    this.app = app;
    this.contentEl = makeEl();
    this.titleEl = makeEl();
    this.modalEl = makeEl();
  }
  /** Records the instance so a test can drive the window a user would see. */
  open() {
    openedModals.push(this);
    if (typeof this.onOpen === "function") this.onOpen();
  }
  close() {
    if (typeof this.onClose === "function") this.onClose();
  }
}

/** Chainable component shapes, matching Obsidian's (each returns the component). */
function chainable(inputEl, extra = {}) {
  const component = {
    inputEl,
    value: "",
    setValue(value) {
      component.value = value;
      inputEl.value = value;
      return component;
    },
    setPlaceholder(text) {
      inputEl.placeholder = text;
      return component;
    },
    setDisabled() {
      return component;
    },
    setLimit() {
      return component;
    },
    setDynamicTooltip() {
      return component;
    },
    setLimits() {
      return component;
    },
    onChange(handler) {
      component.changeHandler = handler;
      return component;
    },
    addOption() {
      return component;
    },
    addOptions() {
      return component;
    },
    setButtonText(text) {
      component.buttonText = text;
      return component;
    },
    setIcon(icon) {
      component.icon = icon;
      return component;
    },
    setTooltip(tooltip) {
      component.tooltip = tooltip;
      return component;
    },
    setCta() {
      return component;
    },
    onClick(handler) {
      component.clickHandler = handler;
      return component;
    },
    ...extra,
  };
  return component;
}

export class Setting {
  constructor(containerEl) {
    this.containerEl = containerEl || makeEl();
    // A definition's render() callback draws into this row, so it has to exist and be
    // reachable from the container the way the real .setting-item is.
    this.settingEl = makeEl("div");
    if (Array.isArray(this.containerEl.children)) this.containerEl.children.push(this.settingEl);
    this.infoEl = makeEl("div");
    this.nameEl = makeEl("div");
    this.descEl = makeEl("div");
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
    callback(chainable(this.inputEl));
    return this;
  }
  addTextArea(callback) {
    callback(chainable(makeEl("textarea")));
    return this;
  }
  addToggle(callback) {
    callback(chainable(makeEl("input")));
    return this;
  }
  addDropdown(callback) {
    callback(chainable(makeEl("select"), { selectEl: makeEl("select") }));
    return this;
  }
  addSlider(callback) {
    callback(chainable(makeEl("input")));
    return this;
  }
  addButton(callback) {
    callback(chainable(makeEl("button")));
    return this;
  }
  addExtraButton(callback) {
    callback(chainable(makeEl("button")));
    return this;
  }
}

/** Countdown of renders that should throw, so the chat guard can be tested for real. */
export let markdownFailures = 0;
export let markdownRejections = 0;

/** Makes the next `count` renders throw synchronously. */
export function failMarkdownRenders(count) {
  markdownFailures = count;
}

/** Makes the next `count` renders return a rejected promise, the way a real async one can. */
export function rejectMarkdownRenders(count) {
  markdownRejections = count;
}

export let markdownRenders = 0;

export class MarkdownRenderer {
  static render(app, markdown, el) {
    markdownRenders++;
    if (markdownFailures > 0) {
      markdownFailures--;
      throw new Error("the renderer blew up");
    }
    if (markdownRejections > 0) {
      markdownRejections--;
      return Promise.reject(new Error("the async renderer blew up"));
    }
    if (el && typeof el.createEl === "function") el.createEl("span", { text: String(markdown) });
    return Promise.resolve();
  }
  static async renderMarkdown(app, markdown, el) {
    return MarkdownRenderer.render(app, markdown, el);
  }
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
  /**
   * Obsidian 1.13 made this the entry point when a settings tab opens: it renders the
   * declarative definitions, or falls back to display(). Deliberately present in the stub
   * so a subclass that shadows it fails the tests the way it fails in the real app.
   *
   * The dispatch below mirrors 1.13: a non-empty getSettingDefinitions() means display() is
   * never called, and each definition's render callback gets a Setting row to draw into.
   */
  renderTab() {
    const definitions = typeof this.getSettingDefinitions === "function" ? this.getSettingDefinitions() : [];
    if (Array.isArray(definitions) && definitions.length > 0) {
      for (const definition of definitions) {
        const row = new Setting(this.containerEl);
        row.settingEl.addClass("setting-item");
        if (typeof definition.render === "function") definition.render(row, { listEl: this.containerEl });
      }
      return;
    }
    this.display();
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

