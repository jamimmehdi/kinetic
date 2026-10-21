//! Fan-out of engine events to every connected client, as ready-to-send JSON lines.

use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Mutex, OnceLock};

static CLIENTS: OnceLock<Mutex<Vec<Sender<String>>>> = OnceLock::new();

fn clients() -> &'static Mutex<Vec<Sender<String>>> {
    CLIENTS.get_or_init(|| Mutex::new(Vec::new()))
}

pub fn subscribe() -> Receiver<String> {
    let (tx, rx) = channel();
    if let Ok(mut list) = clients().lock() {
        list.push(tx);
    }
    rx
}

/// Send one event to everyone. Clients whose channel has closed are dropped.
pub fn publish(value: &serde_json::Value) {
    let Ok(mut line) = serde_json::to_string(value) else { return };
    line.push('\n');
    if let Ok(mut list) = clients().lock() {
        list.retain(|tx| tx.send(line.clone()).is_ok());
    }
}
