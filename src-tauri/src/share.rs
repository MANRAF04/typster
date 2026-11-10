//! Peer-to-peer live sharing over iroh (QUIC with NAT hole punching).
//!
//! The host binds an endpoint and hands out a ticket: its iroh address plus a
//! random secret. Guests dial the address, present the secret, and from then
//! on both sides exchange opaque length-prefixed frames. Connections are
//! direct whenever hole punching succeeds and fall back to n0's public relays
//! otherwise; the relays only ever see encrypted QUIC packets.
//!
//! The host forms a star: every guest connects to it, and the frontend
//! forwards collaboration updates between guests.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use iroh::Endpoint;
use iroh::endpoint::{Connection, presets};
use iroh_tickets::endpoint::EndpointTicket;
use tauri::{State, Webview};
use tauri::ipc::{Channel, InvokeBody, InvokeResponseBody, Request};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc;

use crate::windows::Windows;

const ALPN: &[u8] = b"typster/share/1";
const TICKET_PREFIX: &str = "typster:";
/// Whole-project snapshots with images can be large, but not unbounded.
const MAX_FRAME: usize = 256 * 1024 * 1024;
const MAX_GUESTS: usize = 32;
const AUTH_TIMEOUT: Duration = Duration::from_secs(15);
/// The host as seen by a guest. Guests get ids above this.
const HOST_PEER: u32 = 1;

// Events for the frontend, each `[kind: u8][peer: u32 big-endian][payload]`.
const EV_DATA: u8 = 0;
const EV_JOINED: u8 = 1;
const EV_LEFT: u8 = 2;
/// Payload is `direct` or `relay`.
const EV_ROUTE: u8 = 3;

type Sink = Arc<dyn Fn(u8, u32, &[u8]) + Send + Sync>;
type Peers = Arc<Mutex<HashMap<u32, mpsc::UnboundedSender<Vec<u8>>>>>;

pub struct Session {
    endpoint: Endpoint,
    peers: Peers,
}

impl Session {
    /// Starts accepting guests and returns the ticket to share with them.
    fn host(endpoint: Endpoint, sink: Sink) -> (Self, String) {
        endpoint.set_alpns(vec![ALPN.to_vec()]);
        let mut secret = [0u8; 16];
        getrandom::fill(&mut secret).expect("the OS random number generator failed");
        let ticket = format!("{TICKET_PREFIX}{}:{}", hex(&secret), EndpointTicket::new(endpoint.addr()));
        let peers = Peers::default();
        tokio::spawn(accept(endpoint.clone(), secret, peers.clone(), sink));
        (Self { endpoint, peers }, ticket)
    }

    async fn join(endpoint: Endpoint, ticket: &str, sink: Sink) -> Result<Self, String> {
        let (secret, address) = parse_ticket(ticket)?;
        let conn = endpoint
            .connect(address, ALPN)
            .await
            .map_err(|e| format!("Couldn't reach the host. Is their session still running? ({e})"))?;
        let (mut send, mut recv) = conn.open_bi().await.map_err(|e| e.to_string())?;
        write_frame(&mut send, &secret).await.map_err(|e| e.to_string())?;
        match tokio::time::timeout(AUTH_TIMEOUT, read_frame(&mut recv)).await {
            Ok(Some(reply)) if reply == b"ok" => {}
            _ => return Err("The host rejected this ticket. Ask them for a new one.".into()),
        }
        let peers = Peers::default();
        tokio::spawn(serve(HOST_PEER, conn, send, recv, peers.clone(), sink));
        Ok(Self { endpoint, peers })
    }

    /// Queues `payload` for peer `to`, or for everyone but `except` when `to` is 0.
    fn send(&self, to: u32, except: u32, payload: &[u8]) {
        for (id, queue) in self.peers.lock().unwrap().iter() {
            if (to == 0 || to == *id) && *id != except {
                let _ = queue.send(payload.to_vec());
            }
        }
    }

    async fn close(self) {
        self.peers.lock().unwrap().clear();
        self.endpoint.close().await;
    }
}

async fn accept(endpoint: Endpoint, secret: [u8; 16], peers: Peers, sink: Sink) {
    let mut last_id = HOST_PEER;
    while let Some(incoming) = endpoint.accept().await {
        last_id += 1;
        let (id, peers, sink) = (last_id, peers.clone(), sink.clone());
        tokio::spawn(async move {
            let Ok(conn) = incoming.await else { return };
            let Ok((mut send, mut recv)) = conn.accept_bi().await else { return };
            let presented = tokio::time::timeout(AUTH_TIMEOUT, read_frame(&mut recv)).await.ok().flatten();
            let full = peers.lock().unwrap().len() >= MAX_GUESTS;
            if full || !presented.is_some_and(|candidate| same_secret(&candidate, &secret)) {
                conn.close(1u32.into(), b"denied");
                return;
            }
            if write_frame(&mut send, b"ok").await.is_ok() {
                serve(id, conn, send, recv, peers, sink).await;
            }
        });
    }
}

async fn serve(
    id: u32,
    conn: Connection,
    mut send: iroh::endpoint::SendStream,
    mut recv: iroh::endpoint::RecvStream,
    peers: Peers,
    sink: Sink,
) {
    let (queue, mut outbox) = mpsc::unbounded_channel::<Vec<u8>>();
    peers.lock().unwrap().insert(id, queue);
    tokio::spawn(async move {
        while let Some(frame) = outbox.recv().await {
            if write_frame(&mut send, &frame).await.is_err() {
                break;
            }
        }
    });
    let route = tokio::spawn(watch_route(conn.clone(), id, sink.clone()));
    sink(EV_JOINED, id, &[]);
    while let Some(frame) = read_frame(&mut recv).await {
        sink(EV_DATA, id, &frame);
    }
    peers.lock().unwrap().remove(&id);
    route.abort();
    conn.close(0u32.into(), b"bye");
    sink(EV_LEFT, id, &[]);
}

/// Connections start relayed and usually switch to direct once hole punching
/// succeeds, so the route is re-checked periodically.
async fn watch_route(conn: Connection, id: u32, sink: Sink) {
    let mut last = None;
    loop {
        let direct = conn.paths().iter().any(|path| path.is_selected() && path.is_ip());
        if last != Some(direct) {
            sink(EV_ROUTE, id, if direct { b"direct" } else { b"relay" });
            last = Some(direct);
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

async fn read_frame(recv: &mut (impl AsyncRead + Unpin)) -> Option<Vec<u8>> {
    let mut len = [0u8; 4];
    recv.read_exact(&mut len).await.ok()?;
    let len = u32::from_be_bytes(len) as usize;
    if len > MAX_FRAME {
        return None;
    }
    let mut frame = vec![0; len];
    recv.read_exact(&mut frame).await.ok()?;
    Some(frame)
}

async fn write_frame(send: &mut (impl AsyncWrite + Unpin), data: &[u8]) -> std::io::Result<()> {
    send.write_all(&(data.len() as u32).to_be_bytes()).await?;
    send.write_all(data).await
}

fn parse_ticket(ticket: &str) -> Result<([u8; 16], EndpointTicket), String> {
    let invalid = || "That doesn't look like a Typster ticket.".to_string();
    let rest = ticket.trim().strip_prefix(TICKET_PREFIX).ok_or_else(invalid)?;
    let (secret, address) = rest.split_once(':').ok_or_else(invalid)?;
    let secret = unhex(secret).ok_or_else(invalid)?;
    Ok((secret, address.parse().map_err(|_| invalid())?))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(text: &str) -> Option<[u8; 16]> {
    let mut out = [0u8; 16];
    if text.len() != 32 || !text.is_ascii() {
        return None;
    }
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&text[2 * i..2 * i + 2], 16).ok()?;
    }
    Some(out)
}

/// Constant-time comparison, so timing doesn't leak how much of a guess matched.
fn same_secret(candidate: &[u8], secret: &[u8; 16]) -> bool {
    candidate.len() == secret.len() && candidate.iter().zip(secret).fold(0, |acc, (a, b)| acc | (a ^ b)) == 0
}

fn channel_sink(channel: Channel<InvokeResponseBody>) -> Sink {
    Arc::new(move |kind, peer, payload| {
        let mut event = Vec::with_capacity(5 + payload.len());
        event.push(kind);
        event.extend_from_slice(&peer.to_be_bytes());
        event.extend_from_slice(payload);
        let _ = channel.send(InvokeResponseBody::Raw(event));
    })
}

#[derive(Default)]
pub struct Share(Mutex<Option<Session>>);

impl Share {
    fn replace(&self, session: Option<Session>) -> Option<Session> {
        std::mem::replace(&mut self.0.lock().unwrap(), session)
    }

    pub async fn stop(&self) {
        if let Some(session) = self.replace(None) {
            session.close().await;
        }
    }
}

#[tauri::command]
pub async fn share_host(
    webview: Webview,
    windows: State<'_, Windows>,
    events: Channel<InvokeResponseBody>,
) -> Result<String, String> {
    let window = windows.of(&webview);
    let share = &window.share;
    share.stop().await;
    let endpoint = Endpoint::bind(presets::N0).await.map_err(|e| e.to_string())?;
    // The ticket should include the relay so peers behind strict NATs can
    // connect, but an offline machine can still share on its LAN.
    let _ = tokio::time::timeout(Duration::from_secs(8), endpoint.online()).await;
    let (session, ticket) = Session::host(endpoint, channel_sink(events));
    share.replace(Some(session));
    Ok(ticket)
}

#[tauri::command]
pub async fn share_join(
    webview: Webview,
    windows: State<'_, Windows>,
    ticket: String,
    events: Channel<InvokeResponseBody>,
) -> Result<(), String> {
    let window = windows.of(&webview);
    let share = &window.share;
    share.stop().await;
    let endpoint = Endpoint::bind(presets::N0).await.map_err(|e| e.to_string())?;
    match Session::join(endpoint.clone(), &ticket, channel_sink(events)).await {
        Ok(session) => {
            share.replace(Some(session));
            Ok(())
        }
        Err(error) => {
            endpoint.close().await;
            Err(error)
        }
    }
}

/// Body: `[to: u32][except: u32][payload]`, both ids big-endian.
#[tauri::command]
pub fn share_send(webview: Webview, windows: State<'_, Windows>, request: Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(body) = request.body() else { return Err("Expected a binary body.".into()) };
    if body.len() < 8 {
        return Err("Malformed share frame.".into());
    }
    let to = u32::from_be_bytes(body[..4].try_into().unwrap());
    let except = u32::from_be_bytes(body[4..8].try_into().unwrap());
    if let Some(session) = windows.of(&webview).share.0.lock().unwrap().as_ref() {
        session.send(to, except, &body[8..]);
    }
    Ok(())
}

#[tauri::command]
pub async fn share_stop(webview: Webview, windows: State<'_, Windows>) -> Result<(), String> {
    windows.of(&webview).share.stop().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use iroh::Watcher;

    #[tokio::test]
    async fn frames_round_trip() {
        let (mut a, mut b) = tokio::io::duplex(64);
        tokio::spawn(async move {
            write_frame(&mut a, b"hello").await.unwrap();
            write_frame(&mut a, &[]).await.unwrap();
        });
        assert_eq!(read_frame(&mut b).await.unwrap(), b"hello");
        assert_eq!(read_frame(&mut b).await.unwrap(), b"");
        assert!(read_frame(&mut b).await.is_none(), "EOF ends the stream");
    }

    #[test]
    fn tickets_parse_and_reject_garbage() {
        assert_eq!(unhex(&hex(&[7; 16])), Some([7; 16]));
        assert!(parse_ticket("hello").is_err());
        assert!(parse_ticket("typster:zz:abc").is_err());
        assert!(same_secret(&[1; 16], &[1; 16]));
        assert!(!same_secret(&[1; 15], &[1; 16]));
        assert!(!same_secret(&[2; 16], &[1; 16]));
    }

    /// A host and a guest in one process, talking over loopback without relays.
    #[tokio::test(flavor = "multi_thread")]
    async fn host_and_guest_exchange_frames() {
        async fn local_endpoint() -> Endpoint {
            let endpoint = Endpoint::bind(presets::Minimal).await.unwrap();
            let mut addr = endpoint.watch_addr();
            tokio::time::timeout(Duration::from_secs(10), async {
                while addr.get().ip_addrs().next().is_none() {
                    addr.updated().await.unwrap();
                }
            })
            .await
            .expect("endpoint never learned a local address");
            endpoint
        }
        fn recorder() -> (Sink, mpsc::UnboundedReceiver<(u8, u32, Vec<u8>)>) {
            let (tx, rx) = mpsc::unbounded_channel();
            (Arc::new(move |kind, peer, data: &[u8]| { let _ = tx.send((kind, peer, data.to_vec())); }), rx)
        }
        async fn next(rx: &mut mpsc::UnboundedReceiver<(u8, u32, Vec<u8>)>, kind: u8) -> (u32, Vec<u8>) {
            loop {
                let (k, peer, data) = tokio::time::timeout(Duration::from_secs(10), rx.recv()).await.unwrap().unwrap();
                if k == kind {
                    return (peer, data);
                }
            }
        }

        let (host_sink, mut host_events) = recorder();
        let (host, ticket) = Session::host(local_endpoint().await, host_sink);

        let (guest_sink, mut guest_events) = recorder();
        let guest = Session::join(local_endpoint().await, &ticket, guest_sink).await.unwrap();
        let (guest_id, _) = next(&mut host_events, EV_JOINED).await;
        assert!(guest_id > HOST_PEER);
        assert_eq!(next(&mut guest_events, EV_JOINED).await.0, HOST_PEER);

        guest.send(0, 0, b"from guest");
        assert_eq!(next(&mut host_events, EV_DATA).await, (guest_id, b"from guest".to_vec()));
        host.send(guest_id, 0, b"from host");
        assert_eq!(next(&mut guest_events, EV_DATA).await, (HOST_PEER, b"from host".to_vec()));
        host.send(0, guest_id, b"not for the guest");
        host.send(0, 0, b"for everyone");
        assert_eq!(next(&mut guest_events, EV_DATA).await.1, b"for everyone");

        let forged = ticket.replacen(&ticket[8..40], &"0".repeat(32), 1);
        let (sink, _) = recorder();
        assert!(Session::join(local_endpoint().await, &forged, sink).await.is_err());

        host.close().await;
        assert_eq!(next(&mut guest_events, EV_LEFT).await.0, HOST_PEER);
        guest.close().await;
    }
}
