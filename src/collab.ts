import { Channel } from "@tauri-apps/api/core";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { api } from "./ipc";
import type { Project } from "./project";
import { setState, type Peer } from "./store";

// Messages between peers, framed like y-websocket: a type, then the y-protocols payload.
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

// Events from the backend: `[kind: u8][peer: u32][payload]`.
const EVENT_DATA = 0;
const EVENT_JOINED = 1;
const EVENT_LEFT = 2;
const EVENT_ROUTE = 3;

type AwarenessChanges = { added: number[]; updated: number[]; removed: number[] };

const textDecoder = new TextDecoder();

/**
 * Keeps a project's Yjs document in sync with connected peers. Updates are
 * applied with the sending peer as origin, so the host relays every update to
 * all other peers and nobody echoes a peer's own update back to it.
 */
export class Session {
  readonly events = new Channel<ArrayBuffer>();
  private peers = new Set<number>();
  /** Awareness clients each connection speaks for, removed when it drops. */
  private clientsByPeer = new Map<number, Set<number>>();

  constructor(
    private project: Project,
    private onPeerLeft: (peer: number) => void,
  ) {
    this.events.onmessage = this.onEvent;
    project.doc.on("update", this.onDocUpdate);
    project.awareness.on("update", this.onAwarenessUpdate);
    project.awareness.on("change", this.onPresence);
  }

  /** Stops syncing and forgets remote cursors. The connection itself is closed by the backend. */
  detach() {
    this.project.doc.off("update", this.onDocUpdate);
    this.project.awareness.off("update", this.onAwarenessUpdate);
    this.project.awareness.off("change", this.onPresence);
    const remote = [...this.clientsByPeer.values()].flatMap((clients) => [...clients]);
    awarenessProtocol.removeAwarenessStates(this.project.awareness, remote, "detach");
    this.peers.clear();
    setState({ peers: [], routes: {} });
  }

  private onEvent = (buffer: ArrayBuffer) => {
    const bytes = new Uint8Array(buffer);
    const peer = new DataView(buffer).getUint32(1);
    const payload = bytes.subarray(5);
    switch (bytes[0]) {
      case EVENT_DATA:
        this.receive(peer, payload);
        break;
      case EVENT_JOINED:
        this.peers.add(peer);
        this.greet(peer);
        break;
      case EVENT_LEFT:
        this.drop(peer);
        this.onPeerLeft(peer);
        break;
      case EVENT_ROUTE: {
        const route = textDecoder.decode(payload) === "direct" ? "direct" : "relay";
        setState((state) => ({ routes: { ...state.routes, [peer]: route } }));
        break;
      }
    }
  };

  /** Both sides start by exchanging state vectors and presence. */
  private greet(peer: number) {
    this.send(peer, 0, message(MESSAGE_SYNC, (e) => syncProtocol.writeSyncStep1(e, this.project.doc)));
    const clients = [...this.project.awareness.getStates().keys()];
    this.send(peer, 0, this.awarenessMessage(clients));
  }

  private receive(peer: number, payload: Uint8Array) {
    // Peers are other people's machines: a malformed message must not break the session.
    try {
      const decoder = decoding.createDecoder(payload);
      switch (decoding.readVarUint(decoder)) {
        case MESSAGE_SYNC: {
          const reply = encoding.createEncoder();
          encoding.writeVarUint(reply, MESSAGE_SYNC);
          syncProtocol.readSyncMessage(decoder, reply, this.project.doc, peer);
          if (encoding.length(reply) > 1) this.send(peer, 0, encoding.toUint8Array(reply));
          break;
        }
        case MESSAGE_AWARENESS:
          awarenessProtocol.applyAwarenessUpdate(this.project.awareness, decoding.readVarUint8Array(decoder), peer);
          break;
      }
    } catch (error) {
      console.warn("Ignored a malformed message from peer", peer, error);
    }
  }

  private drop(peer: number) {
    this.peers.delete(peer);
    const clients = this.clientsByPeer.get(peer);
    this.clientsByPeer.delete(peer);
    if (clients?.size) awarenessProtocol.removeAwarenessStates(this.project.awareness, [...clients], "left");
    setState((state) => {
      const { [peer]: _, ...routes } = state.routes;
      return { routes };
    });
  }

  private onDocUpdate = (update: Uint8Array, origin: unknown) => {
    this.send(0, peerOf(origin), message(MESSAGE_SYNC, (e) => syncProtocol.writeUpdate(e, update)));
  };

  private onAwarenessUpdate = ({ added, updated, removed }: AwarenessChanges, origin: unknown) => {
    const peer = peerOf(origin);
    if (peer) {
      const clients = this.clientsByPeer.get(peer) ?? new Set<number>();
      for (const id of [...added, ...updated]) clients.add(id);
      for (const id of removed) clients.delete(id);
      this.clientsByPeer.set(peer, clients);
    }
    this.send(0, peer, this.awarenessMessage([...added, ...updated, ...removed]));
  };

  private onPresence = () => {
    const peers: Peer[] = [];
    this.project.awareness.getStates().forEach((state, clientId) => {
      if (clientId === this.project.awareness.clientID || !state.user) return;
      peers.push({ clientId, name: String(state.user.name), color: String(state.user.color), file: state.file ?? null });
    });
    setState({ peers });
  };

  private awarenessMessage(clients: number[]) {
    return message(MESSAGE_AWARENESS, (e) =>
      encoding.writeVarUint8Array(e, awarenessProtocol.encodeAwarenessUpdate(this.project.awareness, clients)),
    );
  }

  /** Sends to one peer, or to everyone but `except` when `to` is 0. */
  private send(to: number, except: number, payload: Uint8Array) {
    if (this.peers.size === 0) return;
    const frame = new Uint8Array(8 + payload.length);
    const view = new DataView(frame.buffer);
    view.setUint32(0, to);
    view.setUint32(4, except);
    frame.set(payload, 8);
    api.shareSend(frame).catch((error) => console.warn("Couldn't send to peers", error));
  }
}

/** Remote changes carry the peer's connection id as origin; local ones don't. */
const peerOf = (origin: unknown) => (typeof origin === "number" ? origin : 0);

function message(type: number, write: (encoder: encoding.Encoder) => void): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, type);
  write(encoder);
  return encoding.toUint8Array(encoder);
}
