import { getCurrentWebview } from "@tauri-apps/api/webview";
import { toast } from "sonner";
import { editor } from "./editor";
import { api, errorText } from "./ipc";
import { extension, isTextPath } from "./project";
import { getState } from "./store";

/** Formats Typst's `image` function accepts. */
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "pdf"]);

type Point = { x: number; y: number };
type Target =
  | { kind: "folder"; dir: string; el: Element }
  | { kind: "editor"; el: Element }
  /** The welcome screen: a dropped folder or file is opened as a project. */
  | { kind: "open"; el: Element };

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });
let highlighted: Element | null = null;

export async function initDrop(openProject: (path: string) => Promise<void>) {
  await getCurrentWebview().onDragDropEvent(({ payload }) => {
    if (payload.type === "leave") return highlight(null);
    const point = { x: payload.position.x / devicePixelRatio, y: payload.position.y / devicePixelRatio };
    const target = targetAt(point);
    if (payload.type !== "drop") return highlight(target?.el ?? null);
    highlight(null);
    if (target?.kind === "open") void openProject(payload.paths[0]);
    else if (target) void addFiles(payload.paths, target, point);
  });
}

function targetAt(point: Point): Target | null {
  const el = document.elementFromPoint(point.x, point.y);
  if (!el) return null;
  if (!getState().project) {
    const welcome = el.closest(".welcome");
    return welcome && { kind: "open", el: welcome };
  }
  const editorPane = el.closest(".editor-pane");
  if (editorPane) return { kind: "editor", el: editorPane };
  const tree = el.closest(".tree");
  if (!tree) return null;
  const folder = el.closest<HTMLElement>("[data-dir]");
  if (folder) return { kind: "folder", dir: folder.dataset.dir!, el: folder };
  const file = el.closest<HTMLElement>("[data-path]");
  return { kind: "folder", dir: file ? parentDir(file.dataset.path!) : "", el: tree };
}

function highlight(el: Element | null) {
  if (el === highlighted) return;
  highlighted?.classList.remove("drop-target");
  el?.classList.add("drop-target");
  highlighted = el;
}

/** Copies dropped files into the project. Images dropped on a Typst file are also inserted. */
async function addFiles(paths: string[], target: Target, point: Point) {
  const { project, active } = getState();
  if (!project) return;
  const dir = target.kind === "folder" ? target.dir : active ? parentDir(active) : "";
  const added: string[] = [];
  for (const source of paths) {
    const name = source.split(/[\\/]/).pop()!;
    if (name.startsWith(".")) {
      toast.error(`Skipped ${name}`, { description: "Hidden files aren't part of projects." });
      continue;
    }
    try {
      const bytes = await api.readDropped(source);
      const path = freePath(project.files, dir ? `${dir}/${name}` : name);
      project.createFile(path, isTextPath(path) ? (decodeText(bytes) ?? bytes) : bytes);
      added.push(path);
    } catch (error) {
      toast.error(`Couldn't add ${name}`, { description: errorText(error) });
    }
  }
  const images = added.filter((path) => IMAGE_EXTENSIONS.has(extension(path)));
  if (target.kind === "editor" && active?.endsWith(".typ") && images.length) {
    // The images sit next to the open file, so their names are their relative paths.
    const calls = images.map((path) => `#image("${typstString(path.slice(dir ? dir.length + 1 : 0))}")`);
    editor.insertAt(point, calls.join("\n"));
  } else if (added.length) {
    toast.success(added.length === 1 ? `Added ${added[0]}` : `Added ${added.length} files`);
  }
}

/** `name 2.png`, `name 3.png`, ... when `path` is taken. */
function freePath(files: { has(path: string): boolean }, path: string): string {
  if (!files.has(path)) return path;
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  const [stem, ext] = dot > slash + 1 ? [path.slice(0, dot), path.slice(dot)] : [path, ""];
  for (let n = 2; ; n++) {
    const candidate = `${stem} ${n}${ext}`;
    if (!files.has(candidate)) return candidate;
  }
}

const parentDir = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));
const typstString = (text: string) => text.replaceAll("\\", "\\\\").replaceAll('"', '\\"');

function decodeText(bytes: Uint8Array): string | null {
  try {
    return strictUtf8.decode(bytes);
  } catch {
    return null;
  }
}
