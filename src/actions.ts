import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask, open, save } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { toast } from "sonner";
import { Session } from "./collab";
import { initDrop } from "./drop";
import { editor } from "./editor";
import { api, errorText, type Compiled } from "./ipc";
import { preview } from "./preview";
import { FROM_DISK, Project, isTextPath } from "./project";
import { getState, initialProjectState, setState, useStore } from "./store";

const RECENT_KEY = "typster.recent";
const NAME_KEY = "typster.name";
/** The host's connection id, as seen by a guest. */
const HOST_PEER = 1;
const COLORS = ["#e5484d", "#f76b15", "#d69e2e", "#30a46c", "#12a594", "#0090ff", "#8e4ec6", "#d6409f"];
const TEMPLATE = `#set page(paper: "a4", margin: 2.5cm)
#set heading(numbering: "1.")

= Introduction

Welcome to Typster. Edit this file and the preview updates as you type.
`;

let session: Session | null = null;
let fallbackName = "";

// Projects

export async function openProject(path: string) {
  if (!(await closeProject())) return;
  try {
    const project = await Project.open(path);
    attach(project);
    rememberRecent(project.root!);
  } catch (error) {
    toast.error("Couldn't open the project", { description: errorText(error) });
  }
}

export async function openFolderDialog() {
  const dir = await open({ directory: true, title: "Open a project folder" });
  if (dir) await openProject(dir);
}

export async function openFileDialog() {
  const file = await open({ title: "Open a Typst file", filters: [{ name: "Typst", extensions: ["typ"] }] });
  if (file) await openProject(file);
}

export async function newProjectDialog() {
  const dir = await open({ directory: true, title: "Choose a folder for the new project", canCreateDirectories: true });
  if (!dir) return;
  await openProject(dir);
  const project = getState().project;
  if (project && !project.files.has("main.typ")) {
    project.createFile("main.typ", TEMPLATE);
    project.setMain("main.typ");
    openFile("main.typ");
  }
}

/** Returns false if the user chose to keep the project open. */
export async function closeProject(): Promise<boolean> {
  const { project, share } = getState();
  if (!project) return true;
  if (share.role === "host") {
    const confirmed = await ask("Closing it ends the live session for everyone.", {
      title: "You're sharing this project",
      kind: "warning",
      okLabel: "End session",
      cancelLabel: "Keep open",
    });
    if (!confirmed) return false;
  }
  await stopSharing();
  if (project.isHost) await project.saveAll();
  project.destroy();
  editor.clear();
  preview.update([]);
  setState(initialProjectState);
  // Lets files opened from the OS reuse this now empty window.
  await api.closeProject();
  void getCurrentWindow().setTitle("Typster");
  return true;
}

function attach(project: Project) {
  project.awareness.setLocalStateField("user", identity(project));
  setState({
    ...initialProjectState,
    project,
    files: [...project.files.keys()].sort(),
    main: project.meta.get("main") ?? null,
  });
  void getCurrentWindow().setTitle(`${project.name} · Typster`);
}

/** Opens a path handed over by the OS: a file of the open project, or another project. */
async function openPath(path: string) {
  const { project } = getState();
  const relative = project?.root ? relativeTo(project.root, path) : null;
  if (relative === null) return openProject(path);
  if (project?.files.has(relative)) openFile(relative);
}

async function openPending() {
  const path = await api.takePendingPath();
  if (path) await openPath(path);
}

function relativeTo(root: string, path: string): string | null {
  const normalize = (p: string) => p.replaceAll("\\", "/").replace(/\/+$/, "");
  const [base, full] = [normalize(root), normalize(path)];
  if (full === base) return "";
  return full.startsWith(`${base}/`) ? full.slice(base.length + 1) : null;
}

export function newWindow() {
  void api.newWindow();
}

export function openFile(path: string, offset?: number) {
  const { project } = getState();
  if (!project) return;
  setState({ active: path });
  project.awareness.setLocalStateField("file", path);
  const text = project.text(path);
  if (text) editor.show(project, path, text, offset);
}

function defaultFile(project: Project, files: string[]): string | null {
  const main = project.meta.get("main");
  if (main && files.includes(main)) return main;
  return files.find((path) => path.endsWith(".typ")) ?? files.find(isTextPath) ?? files[0] ?? null;
}

// Files

export function createFile(path: string) {
  getState().project?.createFile(path);
  openFile(path);
  editor.focus();
}

export async function renameFile(from: string, to: string) {
  const { project, active } = getState();
  if (!project) return;
  try {
    // A host renames on disk directly; otherwise the rename would trash the old file and write a new one.
    if (project.isHost) {
      await project.save(from);
      await api.renameFile(from, to);
    }
    project.renameFile(from, to, project.isHost ? FROM_DISK : null);
    if (active === from) openFile(to);
  } catch (error) {
    toast.error(`Couldn't rename ${from}`, { description: errorText(error) });
  }
}

export async function deleteFile(path: string) {
  const { project } = getState();
  if (!project) return;
  const confirmed = await ask(project.isHost ? "It's moved to the trash." : "It's removed for everyone in the session.", {
    title: `Delete ${path}?`,
    kind: "warning",
    okLabel: "Delete",
    cancelLabel: "Cancel",
  });
  if (confirmed) project.deleteFile(path);
}

export function setMainFile(path: string) {
  getState().project?.setMain(path);
}

// Output

export async function exportPdf() {
  const { project, main } = getState();
  if (!project || !main) return;
  const name = `${main.split("/").pop()!.replace(/\.typ$/, "")}.pdf`;
  const path = await save({
    title: "Export PDF",
    defaultPath: project.root ? `${project.root}/${name}` : name,
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (!path) return;
  const id = toast.loading("Exporting PDF");
  try {
    await api.exportPdf(path);
    toast.success(`Exported ${path.split(/[\\/]/).pop()}`, { id });
  } catch (error) {
    toast.error("Export failed", { id, description: errorText(error) });
  }
}

export async function saveCopy() {
  const dir = await open({ directory: true, title: "Choose a folder for your copy", canCreateDirectories: true });
  if (!dir) return;
  try {
    await api.saveCopy(dir);
    toast.success("Copy saved", { action: { label: "Open it", onClick: () => void openProject(dir) } });
  } catch (error) {
    toast.error("Couldn't save the copy", { description: errorText(error) });
  }
}

// Live sharing

export async function startSharing() {
  const { project } = getState();
  if (!project?.isHost || session) return;
  setState({ share: { role: "starting" } });
  const next = new Session(project, () => {});
  try {
    const ticket = await api.shareHost(next.events);
    session = next;
    setState({ share: { role: "host", ticket } });
  } catch (error) {
    next.detach();
    setState({ share: { role: "off" } });
    toast.error("Couldn't start sharing", { description: errorText(error) });
  }
}

export async function joinSession(ticket: string) {
  if (!(await closeProject())) return;
  const project = await Project.guest();
  attach(project);
  setState({ share: { role: "joining" } });
  const next = new Session(project, (peer) => peer === HOST_PEER && hostLeft());
  try {
    await api.shareJoin(ticket.trim(), next.events);
    session = next;
    setState({ share: { role: "guest" } });
  } catch (error) {
    next.detach();
    await closeProject();
    toast.error("Couldn't join the session", { description: errorText(error) });
  }
}

export async function stopSharing() {
  const current = session;
  if (!current) return;
  session = null;
  setState(({ share }) => ({ share: { role: share.role === "guest" ? "ended" : "off" } }));
  current.detach();
  await api.shareStop();
}

function hostLeft() {
  if (!session) return;
  void stopSharing();
  toast("The host ended the session", {
    description: "You're editing an offline copy now.",
    action: { label: "Save a copy", onClick: () => void saveCopy() },
  });
}

export function displayName() {
  return localStorage.getItem(NAME_KEY) || fallbackName || "Anonymous";
}

export function setDisplayName(name: string) {
  localStorage.setItem(NAME_KEY, name.trim());
  const project = getState().project;
  project?.awareness.setLocalStateField("user", identity(project));
}

function identity(project: Project) {
  const color = COLORS[project.doc.clientID % COLORS.length];
  return { name: displayName(), color, colorLight: `${color}33` };
}

// Layout

export function toggleSidebar() {
  const sidebar = !getState().sidebar;
  localStorage.setItem("typster.sidebar", sidebar ? "1" : "0");
  setState({ sidebar });
}

export function recentProjects(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
  } catch {
    return [];
  }
}

export function forgetRecent(path: string) {
  localStorage.setItem(RECENT_KEY, JSON.stringify(recentProjects().filter((recent) => recent !== path)));
}

function rememberRecent(path: string) {
  localStorage.setItem(RECENT_KEY, JSON.stringify([path, ...recentProjects().filter((p) => p !== path)].slice(0, 8)));
}

// Wiring

export async function init() {
  fallbackName = await api.defaultName().catch(() => "");
  // The backend only sends changed pages, so a reloaded webview needs all of them once.
  void api.resendPreview();

  // Each window has its own compiler: only listen to results meant for this one.
  const thisWindow = getCurrentWebviewWindow();
  await thisWindow.listen<Compiled>("compiled", ({ payload }) => {
    if (!getState().project) return;
    if (payload.pages) preview.update(payload.pages);
    setState({
      diagnostics: payload.diagnostics,
      failed: payload.pages === null,
      compileMs: payload.ms,
      ...(payload.pages && { pageCount: payload.pages.length }),
    });
    editor.setDiagnostics(payload.diagnostics);
  });
  await thisWindow.listen<string | null>("status", ({ payload }) => setState({ download: payload }));
  await thisWindow.listen("open-pending", () => void openPending());
  await listen("save-all", () => void getState().project?.saveAll());
  await initDrop(openProject);

  preview.onClick = async (page, x, y) => {
    const target = await api.jumpClick(page, x, y).catch(() => null);
    if (target?.kind === "file" && !target.path.startsWith("@")) openFile(target.path, target.offset);
    else if (target?.kind === "position") preview.reveal(target);
  };
  editor.onCursorRest = async (path, offset) => {
    const [position] = await api.jumpCursor(path, offset).catch(() => []);
    if (position) preview.reveal(position);
  };

  // Keep an editor open: the main file at first, another one if the open file disappears.
  useStore.subscribe((state) => {
    const { project, files, active } = state;
    if (!project || (active && files.includes(active))) return;
    const next = defaultFile(project, files);
    if (next) openFile(next);
    else if (active) setState({ active: null });
  });

  useStore.subscribe((state, prev) => {
    if (state.share.role !== "host" || state.peers === prev.peers) return;
    const before = new Set(prev.peers.map((peer) => peer.clientId));
    const after = new Set(state.peers.map((peer) => peer.clientId));
    for (const peer of state.peers) if (!before.has(peer.clientId)) toast(`${peer.name} joined`);
    for (const peer of prev.peers) if (!after.has(peer.clientId)) toast(`${peer.name} left`);
  });

  const appWindow = getCurrentWindow();
  await appWindow.onFocusChanged(({ payload: focused }) => {
    const project = getState().project;
    if (focused && project) project.syncFromDisk().catch((error) => console.warn("Disk sync failed", error));
  });
  await appWindow.onCloseRequested(async (event) => {
    if (!(await closeProject())) event.preventDefault();
  });

  addEventListener("keydown", onShortcut, true);

  await openPending();
  void checkForUpdates();
}

async function checkForUpdates() {
  if (import.meta.env.DEV || getCurrentWebviewWindow().label !== "main") return;
  if (!(await api.updatesSupported().catch(() => false))) return;
  const update = await check().catch(() => null);
  if (!update) return;
  toast(`Typster ${update.version} is available`, {
    duration: Infinity,
    action: { label: "Install and restart", onClick: () => void installUpdate(update) },
  });
}

async function installUpdate(update: Update) {
  // Other windows autosave within half a second; this makes sure nothing is pending anywhere.
  await emit("save-all");
  if (!(await closeProject())) return;
  const id = toast.loading(`Downloading Typster ${update.version}`);
  try {
    await update.downloadAndInstall();
    await relaunch();
  } catch (error) {
    toast.error("The update failed", { id, description: errorText(error) });
  }
}

function onShortcut(event: KeyboardEvent) {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
  const key = event.key.toLowerCase();
  // Select all only makes sense in text; elsewhere it highlights the whole interface.
  if (key === "a" && !(event.target as HTMLElement).closest("input, textarea, .cm-content")) {
    event.preventDefault();
    return;
  }
  if (event.shiftKey && key === "n") {
    event.preventDefault();
    newWindow();
    return;
  }
  const actions: Record<string, () => unknown> = {
    s: () => getState().project?.saveAll(),
    o: () => openFolderDialog(),
    e: () => exportPdf(),
    b: () => toggleSidebar(),
    "=": () => preview.zoomBy(1.1),
    "+": () => preview.zoomBy(1.1),
    "-": () => preview.zoomBy(1 / 1.1),
    "0": () => setState({ zoom: "fit" }),
  };
  const action = actions[key];
  if (!action || (event.shiftKey && key !== "+")) return;
  event.preventDefault();
  void action();
}
