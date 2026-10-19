//! Raw TCP byte pipe for network receipt printers (port 9100). The webview cannot open sockets, so the
//! `ByteTransport` in `@pos/hardware` is implemented over these commands: open → write → read → close.
//! One connection per print job, matching the driver.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::State;

#[derive(Default)]
pub struct TcpState {
    next: AtomicU32,
    connections: Mutex<HashMap<u32, TcpStream>>,
}

const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);

#[tauri::command]
pub async fn tcp_open(state: State<'_, TcpState>, host: String, port: u16) -> Result<u32, String> {
    let addr = (host.as_str(), port)
        .to_socket_addrs()
        .map_err(|e| format!("cannot resolve {host}: {e}"))?
        .next()
        .ok_or_else(|| format!("no address for {host}"))?;
    let stream = TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT)
        .map_err(|e| format!("cannot connect to {host}:{port}: {e}"))?;
    stream.set_nodelay(true).ok();
    stream.set_write_timeout(Some(WRITE_TIMEOUT)).ok();
    let handle = state.next.fetch_add(1, Ordering::SeqCst) + 1;
    state.connections.lock().map_err(|e| e.to_string())?.insert(handle, stream);
    Ok(handle)
}

#[tauri::command]
pub async fn tcp_write(state: State<'_, TcpState>, handle: u32, bytes: Vec<u8>) -> Result<(), String> {
    let mut conns = state.connections.lock().map_err(|e| e.to_string())?;
    let stream = conns.get_mut(&handle).ok_or("connection is closed")?;
    stream.write_all(&bytes).map_err(|e| e.to_string())?;
    stream.flush().map_err(|e| e.to_string())
}

/// Read up to `length` bytes, returning early with fewer (possibly none) once `timeout_ms` has passed.
#[tauri::command]
pub async fn tcp_read(
    state: State<'_, TcpState>,
    handle: u32,
    length: usize,
    timeout_ms: u64,
) -> Result<Vec<u8>, String> {
    let mut conns = state.connections.lock().map_err(|e| e.to_string())?;
    let stream = conns.get_mut(&handle).ok_or("connection is closed")?;
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    let mut out = Vec::with_capacity(length);
    let mut buf = vec![0u8; length.max(1)];
    while out.len() < length {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        stream.set_read_timeout(Some(remaining)).ok();
        match stream.read(&mut buf[..length - out.len()]) {
            Ok(0) => break,
            Ok(n) => out.extend_from_slice(&buf[..n]),
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::TimedOut => break,
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn tcp_close(state: State<'_, TcpState>, handle: u32) -> Result<(), String> {
    state.connections.lock().map_err(|e| e.to_string())?.remove(&handle);
    Ok(())
}
