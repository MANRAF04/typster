import { Channel, invoke } from "@tauri-apps/api/core";

export type FileMeta = { path: string; size: number };
export type ProjectInfo = { root: string; name: string; main: string | null; files: FileMeta[] };
/** Offsets are UTF-16 code units, like CodeMirror positions. */
export type Diag = {
  path: string | null;
  from: number;
  to: number;
  line: number | null;
  error: boolean;
  message: string;
  hints: string[];
};
/** `svg` is null when the page didn't change since the previous result. */
export type PageOut = { w: number; h: number; svg: string | null };
/** `pages` is null when compilation failed and the last good preview stays. */
export type Compiled = { pages: PageOut[] | null; diagnostics: Diag[]; ms: number };
export type CompletionItem = { label: string; kind: string; detail: string | null; apply: string | null };
export type Completions = { from: number; items: CompletionItem[] };
export type Hover = { text: string; code: boolean };
/** A point on a page, in pt from the page's top left corner. */
export type Pos = { page: number; x: number; y: number };
export type Target = { kind: "file"; path: string; offset: number } | ({ kind: "position" } & Pos);
export type DiskChanges = { changed: string[]; added: FileMeta[]; removed: string[] };

const encoder = new TextEncoder();

/** Body of raw file commands: `[path length: u32][path: UTF-8][data]`. */
function fileFrame(path: string, data: Uint8Array): Uint8Array {
  const name = encoder.encode(path);
  const frame = new Uint8Array(4 + name.length + data.length);
  new DataView(frame.buffer).setUint32(0, name.length);
  frame.set(name, 4);
  frame.set(data, 4 + name.length);
  return frame;
}

export const api = {
  openProject: (path: string) => invoke<ProjectInfo>("open_project", { path }),
  openGuest: () => invoke<void>("open_guest"),
  closeProject: () => invoke<void>("close_project"),
  readFile: async (path: string) => new Uint8Array(await invoke<ArrayBuffer>("read_file", { path })),
  writeFile: (path: string, data: Uint8Array, force = false) =>
    invoke<void>("write_file", fileFrame(path, data), { headers: force ? { "x-force": "1" } : {} }),
  deleteFile: (path: string) => invoke<void>("delete_file", { path }),
  renameFile: (from: string, to: string) => invoke<void>("rename_file", { from, to }),
  scanDisk: () => invoke<DiskChanges>("scan_disk"),

  setFile: (path: string, text: string) => invoke<void>("set_file", { path, text }),
  setFileBytes: (path: string, data: Uint8Array) => invoke<void>("set_file_bytes", fileFrame(path, data)),
  removeFile: (path: string) => invoke<void>("remove_file", { path }),
  setMain: (path: string | null) => invoke<void>("set_main", { path }),
  resendPreview: () => invoke<void>("resend_preview"),
  complete: (path: string, offset: number, explicit: boolean) =>
    invoke<Completions | null>("complete", { path, offset, explicit }),
  tooltip: (path: string, offset: number, before: boolean) =>
    invoke<Hover | null>("tooltip", { path, offset, before }),
  jumpClick: (page: number, x: number, y: number) => invoke<Target | null>("jump_click", { page, x, y }),
  jumpCursor: (path: string, offset: number) => invoke<Pos[]>("jump_cursor", { path, offset }),
  exportPdf: (path: string) => invoke<void>("export_pdf", { path }),
  saveCopy: (dir: string) => invoke<void>("save_copy", { dir }),

  shareHost: (events: Channel<ArrayBuffer>) => invoke<string>("share_host", { events }),
  shareJoin: (ticket: string, events: Channel<ArrayBuffer>) => invoke<void>("share_join", { ticket, events }),
  /** `frame` is `[to: u32][except: u32][payload]`. */
  shareSend: (frame: Uint8Array) => invoke<void>("share_send", frame),
  shareStop: () => invoke<void>("share_stop"),

  /** A file or folder the OS asked this window to open, if any. */
  takePendingPath: () => invoke<string | null>("take_pending_path"),
  newWindow: () => invoke<void>("new_window"),
  /** Only works for files that were just dropped onto the window. */
  readDropped: async (path: string) => new Uint8Array(await invoke<ArrayBuffer>("read_dropped", { path })),
  updatesSupported: () => invoke<boolean>("updates_supported"),
  defaultName: () => invoke<string>("default_name"),
};

/** Tauri rejects with the command's error string. */
export const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
