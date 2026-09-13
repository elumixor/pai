// The shell is deliberately empty: the window loads the bundled UI, which talks to the pai
// daemon over HTTP. Nothing about the product lives in Rust.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running pai");
}
