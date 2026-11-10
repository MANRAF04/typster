import { create } from "zustand";
import type { Diag } from "./ipc";
import type { Project } from "./project";

export type Peer = { clientId: number; name: string; color: string; file: string | null };

export type Share =
  | { role: "off" | "starting" | "joining" | "guest" }
  | { role: "host"; ticket: string }
  /** A guest whose host left. The project stays open as an offline copy. */
  | { role: "ended" };

export type Zoom = number | "fit";

type State = {
  project: Project | null;
  files: string[];
  main: string | null;
  active: string | null;
  diagnostics: Diag[];
  /** Whether the last compilation failed, leaving the preview out of date. */
  failed: boolean;
  compileMs: number | null;
  /** Package download in progress, if any. */
  download: string | null;
  cursor: { line: number; col: number } | null;
  share: Share;
  peers: Peer[];
  /** Connection route per peer connection id. */
  routes: Record<number, "direct" | "relay">;
  sidebar: boolean;
  zoom: Zoom;
  /** The zoom actually applied, for display. */
  zoomPercent: number;
  pageCount: number;
};

export const initialProjectState = {
  project: null,
  files: [],
  main: null,
  active: null,
  diagnostics: [],
  failed: false,
  compileMs: null,
  pageCount: 0,
  cursor: null,
  share: { role: "off" },
  peers: [],
  routes: {},
} satisfies Partial<State>;

export const useStore = create<State>(() => ({
  ...initialProjectState,
  download: null,
  sidebar: localStorage.getItem("typster.sidebar") !== "0",
  zoom: "fit",
  zoomPercent: 100,
}));

export const getState = useStore.getState;
export const setState = useStore.setState;
