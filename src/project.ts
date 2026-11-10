import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { toast } from "sonner";
import { api, errorText } from "./ipc";
import { setState } from "./store";

/** Origin of changes that came from disk and must not be written back. */
export const FROM_DISK = "disk";

const TEXT_EXTENSIONS = new Set(["typ", "bib", "yml", "yaml", "toml", "json", "csv", "tsv", "txt", "md", "xml", "cff"]);
// ponytail: flat per-file cap; stream large assets separately if projects need them.
const MAX_FILE_SIZE = 20 * 1024 * 1024;
const SAVE_DELAY_MS = 400;

export const isTextPath = (path: string) => TEXT_EXTENSIONS.has(extension(path));
export const extension = (path: string) => path.slice(path.lastIndexOf(".") + 1).toLowerCase();

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

export type FileValue = Y.Text | Uint8Array;

/**
 * A project is a Yjs document holding every file, so the same model serves
 * solo editing and live sharing. Text files are `Y.Text`, everything else raw
 * bytes. Every change is mirrored to the compiler; a host also autosaves
 * changes to disk, wherever they came from.
 */
export class Project {
  readonly doc = new Y.Doc();
  readonly files = this.doc.getMap<FileValue>("files");
  readonly meta = this.doc.getMap<string>("meta");
  readonly awareness = new Awareness(this.doc);
  private undoManagers = new Map<string, Y.UndoManager>();
  /** Text as last read from or written to disk. */
  private saved = new Map<string, string>();
  private saveTimers = new Map<string, number>();
  private toCompiler = new Set<string>();

  private constructor(
    /** The project folder, or null for a guest's in-memory copy. */
    readonly root: string | null,
    readonly name: string,
  ) {
    this.files.observeDeep(this.onFilesChanged);
    this.meta.observe(this.onMetaChanged);
  }

  static async open(path: string): Promise<Project> {
    const info = await api.openProject(path);
    const project = new Project(info.root, info.name);
    const fitting = info.files.filter((file) => file.size <= MAX_FILE_SIZE);
    const loaded = await inBatches(fitting, 32, async (file) => [file.path, await api.readFile(file.path)] as const);
    // Typst has no project file, so the chosen main file is remembered per folder.
    const chosen = localStorage.getItem(mainKey(info.root));
    const main = chosen && loaded.some(([path]) => path === chosen) ? chosen : info.main;
    project.doc.transact(() => {
      for (const [path, bytes] of loaded) project.files.set(path, project.decode(path, bytes));
      if (main) project.meta.set("main", main);
    }, FROM_DISK);
    const skipped = info.files.length - fitting.length;
    if (skipped) toast.warning(`Skipped ${skipped} file${skipped > 1 ? "s" : ""} over 20 MB.`);
    return project;
  }

  static async guest(): Promise<Project> {
    await api.openGuest();
    return new Project(null, "Shared project");
  }

  get isHost() {
    return this.root !== null;
  }

  text(path: string): Y.Text | null {
    const value = this.files.get(path);
    return value instanceof Y.Text ? value : null;
  }

  undoManager(path: string, text: Y.Text): Y.UndoManager {
    let manager = this.undoManagers.get(path);
    if (!manager || manager.scope[0] !== text) {
      manager?.destroy();
      // Only the editor binding is tracked, so remote and disk changes are never undone locally.
      manager = new Y.UndoManager(text, { trackedOrigins: new Set() });
      this.undoManagers.set(path, manager);
    }
    return manager;
  }

  createFile(path: string, content: string | Uint8Array = "") {
    this.files.set(path, typeof content === "string" ? new Y.Text(content) : content);
  }

  /**
   * Yjs types can't move between keys, so a rename re-creates the file. Pass
   * `FROM_DISK` when the file was already renamed on disk.
   */
  renameFile(from: string, to: string, origin: unknown = null) {
    const value = this.files.get(from);
    if (value === undefined || this.files.has(to)) return;
    this.doc.transact(() => {
      if (value instanceof Y.Text) {
        const text = value.toString();
        this.files.set(to, new Y.Text(text));
        if (origin === FROM_DISK) this.saved.set(to, text);
      } else {
        this.files.set(to, value.slice());
      }
      this.files.delete(from);
      if (this.meta.get("main") === from) this.meta.set("main", to);
    }, origin);
  }

  deleteFile(path: string) {
    this.doc.transact(() => {
      this.files.delete(path);
      if (this.meta.get("main") === path) this.meta.delete("main");
    });
  }

  setMain(path: string) {
    this.meta.set("main", path);
  }

  /** Writes pending edits now instead of waiting for the autosave delay. */
  async saveAll() {
    const pending = [...this.saveTimers.keys()];
    for (const timer of this.saveTimers.values()) clearTimeout(timer);
    await Promise.all(pending.map((path) => this.save(path)));
  }

  async save(path: string, force = false) {
    this.saveTimers.delete(path);
    const value = this.files.get(path);
    if (value === undefined) return;
    const text = value instanceof Y.Text ? value.toString() : null;
    if (text !== null && !force && text === this.saved.get(path)) return;
    try {
      await api.writeFile(path, text === null ? (value as Uint8Array) : encoder.encode(text), force);
      if (text !== null) this.saved.set(path, text);
    } catch (error) {
      if (error === "conflict") this.reportConflict(path);
      else if (error === "exists")
        toast.error(`Couldn't save ${path}`, { description: "A file with this name is already on disk, and Typster didn't load it." });
      else toast.error(`Couldn't save ${path}`, { description: errorText(error) });
    }
  }

  /** Replaces a file with its disk version. */
  async reload(path: string) {
    const bytes = await api.readFile(path);
    const current = this.files.get(path);
    const text = this.decodeText(path, bytes);
    this.doc.transact(() => {
      // Edit in place: a new Y.Text would detach open editors and collaborators.
      if (current instanceof Y.Text && text !== null) replaceText(current, text);
      else this.files.set(path, text === null ? bytes : new Y.Text(text));
    }, FROM_DISK);
  }

  /** Picks up edits made outside Typster, e.g. by git or another editor. */
  async syncFromDisk() {
    if (!this.isHost) return;
    const changes = await api.scanDisk();
    for (const path of changes.changed) {
      const current = this.files.get(path);
      const unsaved = this.saveTimers.has(path) || (current instanceof Y.Text && current.toString() !== this.saved.get(path));
      if (unsaved) this.reportConflict(path);
      else await this.reload(path);
    }
    const added = changes.added.filter((file) => file.size <= MAX_FILE_SIZE && !this.files.has(file.path));
    const loaded = await inBatches(added, 32, async (file) => [file.path, await api.readFile(file.path)] as const);
    this.doc.transact(() => {
      for (const [path, bytes] of loaded) this.files.set(path, this.decode(path, bytes));
      for (const path of changes.removed) if (!this.saveTimers.has(path)) this.files.delete(path);
    }, FROM_DISK);
  }

  destroy() {
    for (const timer of this.saveTimers.values()) clearTimeout(timer);
    this.files.unobserveDeep(this.onFilesChanged);
    this.meta.unobserve(this.onMetaChanged);
    for (const manager of this.undoManagers.values()) manager.destroy();
    this.awareness.destroy();
    this.doc.destroy();
  }

  /** Text files become `Y.Text` unless they aren't valid UTF-8. */
  private decode(path: string, bytes: Uint8Array): FileValue {
    const text = this.decodeText(path, bytes);
    return text === null ? bytes : new Y.Text(text);
  }

  /**
   * The contents of a text file, remembered as its saved state. Null for
   * binary files. Note that a `Y.Text` reads as empty until it joins the doc.
   */
  private decodeText(path: string, bytes: Uint8Array): string | null {
    if (!isTextPath(path)) return null;
    try {
      const text = strictUtf8.decode(bytes);
      this.saved.set(path, text);
      return text;
    } catch {
      // Not UTF-8: keep the bytes untouched rather than corrupt the file on save.
      return null;
    }
  }

  private reportConflict(path: string) {
    toast.warning(`${path} changed on disk`, {
      id: `conflict:${path}`,
      description: "It was edited outside Typster while you had unsaved changes here.",
      duration: Infinity,
      action: { label: "Keep mine", onClick: () => void this.save(path, true) },
      cancel: { label: "Reload", onClick: () => void this.reload(path) },
    });
  }

  private scheduleSave(path: string, delay: number) {
    clearTimeout(this.saveTimers.get(path));
    this.saveTimers.set(path, window.setTimeout(() => void this.save(path), delay));
  }

  private onFilesChanged = (events: Y.YEvent<any>[], transaction: Y.Transaction) => {
    const toDisk = this.isHost && transaction.origin !== FROM_DISK;
    let listChanged = false;
    for (const event of events) {
      if (event.target === this.files) {
        for (const [path, change] of event.changes.keys) {
          listChanged = true;
          this.queueForCompiler(path);
          if (change.action === "delete") {
            this.forget(path);
            if (toDisk) api.deleteFile(path).catch((e) => toast.error(`Couldn't delete ${path}`, { description: errorText(e) }));
          } else if (toDisk) {
            this.scheduleSave(path, 0);
          }
        }
      } else {
        const path = event.path[0] as string;
        this.queueForCompiler(path);
        if (toDisk) this.scheduleSave(path, SAVE_DELAY_MS);
      }
    }
    if (listChanged) setState({ files: [...this.files.keys()].sort() });
  };

  private onMetaChanged = () => {
    const main = this.meta.get("main") ?? null;
    setState({ main });
    void api.setMain(main);
    if (this.root && main) localStorage.setItem(mainKey(this.root), main);
  };

  private queueForCompiler(path: string) {
    if (this.toCompiler.size === 0) queueMicrotask(this.flushToCompiler);
    this.toCompiler.add(path);
  }

  /** Coalesces all changes made in one task into one update per file. */
  private flushToCompiler = () => {
    for (const path of this.toCompiler) {
      const value = this.files.get(path);
      if (value === undefined) void api.removeFile(path);
      else if (value instanceof Y.Text) void api.setFile(path, value.toString());
      else void api.setFileBytes(path, value);
    }
    this.toCompiler.clear();
  };

  private forget(path: string) {
    clearTimeout(this.saveTimers.get(path));
    this.saveTimers.delete(path);
    this.saved.delete(path);
    this.undoManagers.get(path)?.destroy();
    this.undoManagers.delete(path);
  }
}

/** Applies `next` as one minimal edit so cursors and collaborators stay put. */
export function replaceText(text: Y.Text, next: string) {
  const prev = text.toString();
  let start = 0;
  while (start < prev.length && start < next.length && prev[start] === next[start]) start++;
  if (start > 0 && isHighSurrogate(prev.charCodeAt(start - 1))) start--;
  let end = 0;
  while (end < prev.length - start && end < next.length - start && prev[prev.length - 1 - end] === next[next.length - 1 - end]) end++;
  if (end > 0 && isLowSurrogate(prev.charCodeAt(prev.length - end))) end--;
  if (prev.length - start - end > 0) text.delete(start, prev.length - start - end);
  if (next.length - start - end > 0) text.insert(start, next.slice(start, next.length - end));
}

const mainKey = (root: string) => `typster.main:${root}`;

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

async function inBatches<T, R>(items: T[], size: number, f: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += size) results.push(...(await Promise.all(items.slice(i, i + size).map(f))));
  return results;
}
