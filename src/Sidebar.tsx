import { ContextMenu } from "@base-ui/react/context-menu";
import { BookOpen, ChevronRight, File, FileCode, FilePlus, FileText, Folder, Image, Pencil, Star, Trash, Type } from "lucide-react";
import { useMemo, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { createFile, deleteFile, displayName, openFile, renameFile, setMainFile } from "./actions";
import { extension } from "./project";
import { useStore, type Peer } from "./store";
import { IconButton } from "./ui";

type Node = { name: string; path: string; children: Node[] | null };

function buildTree(paths: string[]): Node[] {
  const root: Node[] = [];
  for (const path of paths) {
    const parts = path.split("/");
    let level = root;
    parts.forEach((name, i) => {
      const isFile = i === parts.length - 1;
      let node = level.find((n) => n.name === name && (n.children === null) === isFile);
      if (!node) {
        node = { name, path: parts.slice(0, i + 1).join("/"), children: isFile ? null : [] };
        level.push(node);
      }
      if (node.children) level = node.children;
    });
  }
  const sort = (nodes: Node[]): Node[] => {
    nodes.sort((a, b) => Number(a.children === null) - Number(b.children === null) || a.name.localeCompare(b.name));
    for (const node of nodes) if (node.children) sort(node.children);
    return nodes;
  };
  return sort(root);
}

/** Returns a problem with `name` as a new project path, or null if it's fine. */
function problemWith(name: string, files: string[], current?: string): string | null {
  const path = name.trim();
  if (!path) return "Enter a file name.";
  const parts = path.split("/");
  if (path.includes("\\") || parts.some((part) => part === "" || part.startsWith("."))) {
    return "Use a relative path like chapters/intro.typ.";
  }
  if (path !== current && files.includes(path)) return "That file already exists.";
  if (files.some((file) => file.startsWith(`${path}/`))) return "That's a folder.";
  return null;
}

const ICONS: Record<string, typeof File> = {
  typ: FileCode,
  bib: BookOpen,
  png: Image,
  jpg: Image,
  jpeg: Image,
  gif: Image,
  webp: Image,
  svg: Image,
  ttf: Type,
  otf: Type,
  ttc: Type,
  otc: Type,
  txt: FileText,
  md: FileText,
};

const depthStyle = (depth: number) => ({ "--depth": depth }) as CSSProperties;

export function Sidebar() {
  const files = useStore((state) => state.files);
  const main = useStore((state) => state.main);
  const active = useStore((state) => state.active);
  const peers = useStore((state) => state.peers);
  const role = useStore((state) => state.share.role);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const tree = useMemo(() => buildTree(files), [files]);
  const syncing = role === "joining" || (role === "guest" && files.length === 0);

  const toggle = (path: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(path)) next.add(path);
      return next;
    });

  const onRowKey = (event: KeyboardEvent, path: string) => {
    if (event.key === "F2") setRenaming(path);
    else if (event.key === "Delete") void deleteFile(path);
  };

  const rows: ReactNode[] = [];
  const addRows = (nodes: Node[], depth: number) => {
    for (const node of nodes) {
      if (node.children) {
        const open = !collapsed.has(node.path);
        rows.push(
          <button
            key={`dir:${node.path}`}
            className="tree-row"
            data-dir={node.path}
            style={depthStyle(depth)}
            aria-expanded={open}
            onClick={() => toggle(node.path)}
          >
            <ChevronRight className={open ? "tree-chevron open" : "tree-chevron"} />
            <Folder />
            <span className="tree-name">{node.name}</span>
          </button>,
        );
        if (open) addRows(node.children, depth + 1);
      } else if (renaming === node.path) {
        rows.push(
          <NameInput
            key={node.path}
            depth={depth}
            initial={node.path}
            problem={(name) => problemWith(name, files, node.path)}
            onSubmit={(name) => {
              setRenaming(null);
              if (name !== node.path) void renameFile(node.path, name);
            }}
            onCancel={() => setRenaming(null)}
          />,
        );
      } else {
        const Icon = ICONS[extension(node.path)] ?? File;
        rows.push(
          <button
            key={node.path}
            className="tree-row"
            data-path={node.path}
            aria-current={active === node.path}
            style={depthStyle(depth)}
            onClick={() => openFile(node.path)}
            onKeyDown={(event) => onRowKey(event, node.path)}
          >
            <span className="tree-chevron" />
            <Icon />
            <span className="tree-name">{node.name}</span>
            {peers
              .filter((peer) => peer.file === node.path)
              .map((peer) => (
                <span key={peer.clientId} className="peer-dot" style={{ background: peer.color }} title={peer.name} />
              ))}
            {node.path === main && <span className="main-badge">main</span>}
          </button>,
        );
      }
    }
  };
  addRows(tree, 0);

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span>Files</span>
        <IconButton label="New file" onClick={() => setCreating(true)}>
          <FilePlus />
        </IconButton>
      </div>
      <ContextMenu.Root>
        <ContextMenu.Trigger
          className="tree"
          onContextMenu={(event) => setMenuFor((event.target as Element).closest<HTMLElement>("[data-path]")?.dataset.path ?? null)}
        >
          {creating && (
            <NameInput
              depth={0}
              initial=""
              placeholder="chapters/intro.typ"
              problem={(name) => problemWith(name, files)}
              onSubmit={(name) => {
                setCreating(false);
                createFile(name);
              }}
              onCancel={() => setCreating(false)}
            />
          )}
          {rows}
          {syncing && <div className="tree-note">Syncing project</div>}
          {!syncing && files.length === 0 && !creating && <div className="tree-note">No files yet.</div>}
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Positioner className="positioner">
            <ContextMenu.Popup className="menu">
              {menuFor ? (
                <>
                  {menuFor.endsWith(".typ") && menuFor !== main && (
                    <ContextMenu.Item className="menu-item" onClick={() => setMainFile(menuFor)}>
                      <Star /> Set as main file
                    </ContextMenu.Item>
                  )}
                  <ContextMenu.Item className="menu-item" onClick={() => setRenaming(menuFor)}>
                    <Pencil /> Rename <kbd>F2</kbd>
                  </ContextMenu.Item>
                  <ContextMenu.Separator className="menu-separator" />
                  <ContextMenu.Item className="menu-item danger" onClick={() => void deleteFile(menuFor)}>
                    <Trash /> Delete <kbd>Del</kbd>
                  </ContextMenu.Item>
                </>
              ) : (
                <ContextMenu.Item className="menu-item" onClick={() => setCreating(true)}>
                  <FilePlus /> New file
                </ContextMenu.Item>
              )}
            </ContextMenu.Popup>
          </ContextMenu.Positioner>
        </ContextMenu.Portal>
      </ContextMenu.Root>
      {(role === "host" || role === "guest") && <Presence peers={peers} />}
    </aside>
  );
}

function NameInput(props: {
  depth: number;
  initial: string;
  placeholder?: string;
  problem: (name: string) => string | null;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(props.initial);
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    const problem = props.problem(value);
    if (problem) setError(problem);
    else props.onSubmit(value.trim());
  };
  return (
    <div className="tree-input" style={depthStyle(props.depth)}>
      <input
        autoFocus
        spellCheck={false}
        value={value}
        placeholder={props.placeholder}
        aria-invalid={error !== null}
        onChange={(event) => {
          setValue(event.target.value);
          setError(null);
        }}
        onFocus={(event) => {
          // Select the name without folder and extension, like file managers do.
          const start = value.lastIndexOf("/") + 1;
          const dot = value.lastIndexOf(".");
          event.target.setSelectionRange(start, dot > start ? dot : value.length);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") submit();
          else if (event.key === "Escape") props.onCancel();
        }}
        onBlur={() => {
          const name = value.trim();
          if (name && name !== props.initial && !props.problem(name)) props.onSubmit(name);
          else props.onCancel();
        }}
      />
      {error && <div className="tree-error">{error}</div>}
    </div>
  );
}

function Presence({ peers }: { peers: Peer[] }) {
  const me = useStore((state) => state.project?.awareness.getLocalState()?.user);
  return (
    <div className="presence">
      <div className="sidebar-label">In this session</div>
      <div className="presence-row">
        <Avatar name={displayName()} color={me?.color ?? "var(--accent)"} />
        <span className="presence-name">{displayName()}</span>
        <span className="presence-file">you</span>
      </div>
      {peers.map((peer) => (
        <button
          key={peer.clientId}
          className="presence-row"
          disabled={!peer.file}
          title={peer.file ? `Go to ${peer.file}` : undefined}
          onClick={() => peer.file && openFile(peer.file)}
        >
          <Avatar name={peer.name} color={peer.color} />
          <span className="presence-name">{peer.name}</span>
          {peer.file && <span className="presence-file">{peer.file.split("/").pop()}</span>}
        </button>
      ))}
    </div>
  );
}

function Avatar({ name, color }: { name: string; color: string }) {
  return (
    <span className="avatar" style={{ background: color }}>
      {name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}
