import { Menu } from "@base-ui/react/menu";
import { Popover } from "@base-ui/react/popover";
import { Tooltip } from "@base-ui/react/tooltip";
import {
  AppWindow,
  ChevronDown,
  CircleAlert,
  Download,
  FilePlus,
  FileText,
  FolderOpen,
  LoaderCircle,
  Maximize2,
  PanelLeft,
  TriangleAlert,
  Users,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { Toaster } from "sonner";
import {
  closeProject,
  exportPdf,
  forgetRecent,
  newProjectDialog,
  newWindow,
  openFile,
  openFileDialog,
  openFolderDialog,
  openProject,
  recentProjects,
  toggleSidebar,
} from "./actions";
import { editor } from "./editor";
import { preview } from "./preview";
import { extension } from "./project";
import { ShareDialog } from "./ShareDialog";
import { Sidebar } from "./Sidebar";
import { setState, useStore } from "./store";
import { IconButton, plural } from "./ui";

export function App() {
  const hasProject = useStore((state) => state.project !== null);
  return (
    <Tooltip.Provider delay={500}>
      {hasProject ? <Workspace /> : <Welcome />}
      <Toaster position="bottom-right" theme="system" closeButton toastOptions={{ className: "toast" }} style={TOAST_COLORS} />
    </Tooltip.Provider>
  );
}

const TOAST_COLORS = {
  "--normal-bg": "var(--popover)",
  "--normal-border": "var(--border)",
  "--normal-text": "var(--text)",
} as CSSProperties;

function Welcome() {
  const [recent, setRecent] = useState(recentProjects);
  return (
    <main className="welcome">
      <div className="welcome-card">
        <img className="welcome-logo" src="/logo.svg" alt="" />
        <h1>Typster</h1>
        <p className="welcome-tagline">Write Typst with an instant preview, and edit together without a server.</p>
        <div className="welcome-actions">
          <button className="btn btn-large" onClick={openFolderDialog}>
            <FolderOpen /> Open folder
          </button>
          <button className="btn btn-large" onClick={openFileDialog}>
            <FileText /> Open file
          </button>
          <button className="btn btn-large" onClick={newProjectDialog}>
            <FilePlus /> New project
          </button>
          <ShareDialog>
            <button className="btn btn-large">
              <Users /> Join a session
            </button>
          </ShareDialog>
        </div>
        {recent.length > 0 && (
          <section className="recent">
            <h2>Recent</h2>
            <ul>
              {recent.map((path) => (
                <li key={path} className="recent-row">
                  <button className="recent-open" onClick={() => openProject(path)}>
                    <span className="recent-name">{path.split(/[\\/]/).filter(Boolean).pop() ?? path}</span>
                    <span className="recent-path">{path}</span>
                  </button>
                  <IconButton
                    label="Remove from list"
                    onClick={() => {
                      forgetRecent(path);
                      setRecent(recentProjects());
                    }}
                  >
                    <X />
                  </IconButton>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </main>
  );
}

function Workspace() {
  const sidebar = useStore((state) => state.sidebar);
  const [split, setSplit] = useState(() => Number(localStorage.getItem("typster.split")) || 0.5);
  const panes = useRef<HTMLDivElement>(null);
  return (
    <div className="workspace">
      <Toolbar />
      <div
        ref={panes}
        className="panes"
        style={{ gridTemplateColumns: `${sidebar ? "var(--sidebar-width) " : ""}${split}fr 1px ${1 - split}fr` }}
      >
        {sidebar && <Sidebar />}
        <EditorPane />
        <Splitter panes={panes} sidebar={sidebar} onChange={setSplit} />
        <PreviewPane />
      </div>
      <StatusBar />
    </div>
  );
}

function Toolbar() {
  const name = useStore((state) => state.project?.name);
  const isHost = useStore((state) => state.project?.isHost ?? false);
  const download = useStore((state) => state.download);
  const share = useStore((state) => state.share);
  const peers = useStore((state) => state.peers.length);
  const hasMain = useStore((state) => state.main !== null);
  const live = share.role === "host" || share.role === "guest";
  return (
    <header className="toolbar">
      <IconButton label="Toggle sidebar (Ctrl+B)" onClick={toggleSidebar}>
        <PanelLeft />
      </IconButton>
      <Menu.Root>
        <Menu.Trigger className="btn btn-ghost project-button">
          {name}
          {!isHost && <span className="badge">{share.role === "ended" ? "Offline copy" : "Guest"}</span>}
          <ChevronDown className="chevron" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner className="positioner" sideOffset={6} align="start">
            <Menu.Popup className="menu">
              <Menu.Item className="menu-item" onClick={openFolderDialog}>
                <FolderOpen /> Open folder
                <kbd>Ctrl+O</kbd>
              </Menu.Item>
              <Menu.Item className="menu-item" onClick={openFileDialog}>
                <FileText /> Open file
              </Menu.Item>
              <Menu.Item className="menu-item" onClick={newProjectDialog}>
                <FilePlus /> New project
              </Menu.Item>
              <Menu.Item className="menu-item" onClick={newWindow}>
                <AppWindow /> New window
                <kbd>Ctrl+Shift+N</kbd>
              </Menu.Item>
              <Menu.Separator className="menu-separator" />
              <Menu.Item className="menu-item" onClick={() => void closeProject()}>
                <X /> Close project
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      <div className="spacer" />
      {download && (
        <span className="toolbar-status">
          <LoaderCircle className="spin" /> {download}
        </span>
      )}
      <ShareDialog>
        <button className={live ? "btn live-button" : "btn"}>
          {live ? <span className="live-dot" /> : <Users />}
          {live ? (peers ? `Live · ${peers + 1}` : "Live") : "Share"}
        </button>
      </ShareDialog>
      <button className="btn btn-primary" onClick={exportPdf} disabled={!hasMain}>
        <Download /> Export PDF
      </button>
    </header>
  );
}

function EditorPane() {
  const host = useRef<HTMLDivElement>(null);
  const active = useStore((state) => state.active);
  const project = useStore((state) => state.project);
  useStore((state) => state.files);
  useEffect(() => editor.mount(host.current!), []);
  const value = active ? project?.files.get(active) : undefined;
  const bytes = value instanceof Uint8Array ? value : null;
  return (
    <section className="editor-pane">
      <div ref={host} className="editor-host" hidden={!active || bytes !== null} />
      {bytes && active && <BinaryFile path={active} bytes={bytes} />}
      {!active && <div className="empty">Create a file to get started.</div>}
    </section>
  );
}

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

function BinaryFile({ path, bytes }: { path: string; bytes: Uint8Array }) {
  const type = IMAGE_TYPES[extension(path)];
  const url = useMemo(() => (type ? URL.createObjectURL(new Blob([bytes as BlobPart], { type })) : null), [bytes, type]);
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);
  return (
    <div className="binary">
      {url ? <img src={url} alt={path} /> : <FileText className="binary-icon" />}
      <span>
        {path} · {formatSize(bytes.length)}
      </span>
    </div>
  );
}

const formatSize = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;

function Splitter(props: { panes: RefObject<HTMLDivElement | null>; sidebar: boolean; onChange: (split: number) => void }) {
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const panes = props.panes.current!.getBoundingClientRect();
    const sidebar = props.sidebar ? (props.panes.current!.firstElementChild as HTMLElement).offsetWidth : 0;
    let split = 0.5;
    const move = (e: PointerEvent) => {
      split = Math.min(0.8, Math.max(0.2, (e.clientX - panes.left - sidebar) / (panes.width - sidebar)));
      props.onChange(split);
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      localStorage.setItem("typster.split", String(split));
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up, { once: true });
  };
  return <div className="splitter" role="separator" aria-orientation="vertical" onPointerDown={onPointerDown} />;
}

function PreviewPane() {
  const host = useRef<HTMLDivElement>(null);
  const failed = useStore((state) => state.failed);
  const errors = useStore((state) => state.diagnostics.filter((diag) => diag.error).length);
  const zoom = useStore((state) => state.zoom);
  const zoomPercent = useStore((state) => state.zoomPercent);
  const pageCount = useStore((state) => state.pageCount);
  const compiled = useStore((state) => state.compileMs !== null);
  useEffect(() => preview.mount(host.current!), []);
  return (
    <section className="preview-pane" ref={host}>
      {failed && pageCount > 0 && (
        <div className="preview-banner">
          <CircleAlert /> Preview paused on {plural(errors, "error")}
        </div>
      )}
      {compiled && pageCount === 0 && !failed && <div className="empty">Nothing to preview yet.</div>}
      <div className="preview-controls">
        <IconButton label="Zoom out (Ctrl+-)" onClick={() => preview.zoomBy(1 / 1.1)}>
          <ZoomOut />
        </IconButton>
        <button className="btn btn-ghost zoom-label" onClick={() => setState({ zoom: "fit" })} title="Fit width (Ctrl+0)">
          {zoom === "fit" ? <Maximize2 /> : null}
          {zoomPercent}%
        </button>
        <IconButton label="Zoom in (Ctrl+=)" onClick={() => preview.zoomBy(1.1)}>
          <ZoomIn />
        </IconButton>
      </div>
    </section>
  );
}

function StatusBar() {
  const diagnostics = useStore((state) => state.diagnostics);
  const compileMs = useStore((state) => state.compileMs);
  const cursor = useStore((state) => state.cursor);
  const main = useStore((state) => state.main);
  const errors = diagnostics.filter((diag) => diag.error).length;
  const warnings = diagnostics.length - errors;
  return (
    <footer className="statusbar">
      <Popover.Root>
        <Popover.Trigger className="status-button" disabled={diagnostics.length === 0}>
          <CircleAlert className={errors ? "error-icon" : ""} /> {errors}
          <TriangleAlert className={warnings ? "warning-icon" : ""} /> {warnings}
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner className="positioner" side="top" align="start" sideOffset={8}>
            <Popover.Popup className="menu problems">
              {diagnostics.map((diag, i) => (
                <Popover.Close
                  key={i}
                  className="problem"
                  disabled={!diag.path || diag.path.startsWith("@")}
                  onClick={() => diag.path && openFile(diag.path, diag.from)}
                >
                  {diag.error ? <CircleAlert className="error-icon" /> : <TriangleAlert className="warning-icon" />}
                  <span className="problem-text">
                    <span>{diag.message}</span>
                    {diag.path && (
                      <span className="problem-where">
                        {diag.path}
                        {diag.line !== null && `:${diag.line + 1}`}
                      </span>
                    )}
                  </span>
                </Popover.Close>
              ))}
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
      {compileMs !== null && <span>{compileMs} ms</span>}
      <div className="spacer" />
      {cursor && (
        <span>
          Ln {cursor.line}, Col {cursor.col}
        </span>
      )}
      {main && <span>Main: {main}</span>}
    </footer>
  );
}
