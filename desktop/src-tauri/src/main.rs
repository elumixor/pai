// The shell is deliberately thin: it opens a window onto the bundled UI, which talks to the
// pai daemon over HTTP. The one thing the page cannot do for itself is read the address the
// rest of pai already agreed on, so that is the only command here.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;

/// `~/.config/pai/menubar` is where the daemon's address is written on install; the menu bar
/// app reads the same file.
#[tauri::command]
fn configured_base_url() -> Option<String> {
    let home = std::env::var("HOME").ok()?;
    let path = format!("{home}/.config/pai/menubar");
    let value = fs::read_to_string(path).ok()?;
    let trimmed = value.trim().trim_end_matches('/').to_string();
    (!trimmed.is_empty()).then_some(trimmed)
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![configured_base_url])
        .run(tauri::generate_context!())
        .expect("error while running pai");
}
