// The shell is deliberately thin: it opens a window onto the bundled UI, which talks to the
// pai daemon over HTTP. The one thing the page cannot do for itself is read the address the
// rest of pai already agreed on, so that is the only command here.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;

/// `~/.config/pai/menubar` is where the daemon's address is written on install, with the token
/// on a second line when the daemon asks for one; the menu bar app reads the same file.
fn configured_line(index: usize) -> Option<String> {
    let home = std::env::var("HOME").ok()?;
    let value = fs::read_to_string(format!("{home}/.config/pai/menubar")).ok()?;
    let line = value.lines().map(str::trim).filter(|line| !line.is_empty()).nth(index)?;
    Some(line.trim_end_matches('/').to_string())
}

#[tauri::command]
fn configured_base_url() -> Option<String> {
    configured_line(0)
}

#[tauri::command]
fn configured_token() -> Option<String> {
    configured_line(1)
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![configured_base_url, configured_token])
        .run(tauri::generate_context!())
        .expect("error while running pai");
}
