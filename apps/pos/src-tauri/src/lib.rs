//! Tauri 2 shell for the POS register: SQL plugin for the local store, OS keychain commands for the
//! device key and secrets, and a TCP byte pipe for network printers. USB, serial and Bluetooth
//! peripherals are added after the hardware spike (R1) decides the plugin set.

mod keychain;
mod tcp;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::default().build())
        .manage(tcp::TcpState::default())
        .invoke_handler(tauri::generate_handler![
            keychain::device_key_ensure,
            keychain::device_key_sign,
            keychain::device_key_destroy,
            keychain::secret_get,
            keychain::secret_set,
            keychain::secret_delete,
            tcp::tcp_open,
            tcp::tcp_write,
            tcp::tcp_read,
            tcp::tcp_close,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the POS application");
}
