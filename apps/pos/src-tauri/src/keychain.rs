//! Device key pair and secrets in the OS keychain (macOS Keychain, Windows Credential Manager,
//! Secret Service on Linux). The Ed25519 seed is stored base64 under one keychain entry; the webview
//! only ever receives the public key and signatures.

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use ed25519_dalek::{Signer, SigningKey};
use keyring::Entry;
use rand::rngs::OsRng;

const SERVICE: &str = "com.unifiedpos.register";
const KEY_ACCOUNT: &str = "device-signing-key";

fn entry(account: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, account).map_err(|e| e.to_string())
}

fn load_or_create() -> Result<SigningKey, String> {
    let e = entry(KEY_ACCOUNT)?;
    match e.get_password() {
        Ok(seed_b64) => {
            let bytes = B64.decode(seed_b64).map_err(|e| e.to_string())?;
            let seed: [u8; 32] = bytes
                .try_into()
                .map_err(|_| "stored device key has the wrong length".to_string())?;
            Ok(SigningKey::from_bytes(&seed))
        }
        Err(keyring::Error::NoEntry) => {
            let key = SigningKey::generate(&mut OsRng);
            e.set_password(&B64.encode(key.to_bytes()))
                .map_err(|e| e.to_string())?;
            Ok(key)
        }
        Err(e) => Err(e.to_string()),
    }
}

/// Create the key pair if missing; returns the raw 32-byte public key, base64 (what `/v1/auth/device/enroll` expects).
#[tauri::command]
pub fn device_key_ensure() -> Result<String, String> {
    Ok(B64.encode(load_or_create()?.verifying_key().to_bytes()))
}

/// Sign a UTF-8 message; returns the signature, base64.
#[tauri::command]
pub fn device_key_sign(message: String) -> Result<String, String> {
    let key = load_or_create()?;
    Ok(B64.encode(key.sign(message.as_bytes()).to_bytes()))
}

#[tauri::command]
pub fn device_key_destroy() -> Result<(), String> {
    match entry(KEY_ACCOUNT)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

fn secret_account(name: &str) -> String {
    format!("secret:{name}")
}

#[tauri::command]
pub fn secret_get(name: String) -> Result<Option<String>, String> {
    match entry(&secret_account(&name))?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn secret_set(name: String, value: String) -> Result<(), String> {
    entry(&secret_account(&name))?
        .set_password(&value)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn secret_delete(name: String) -> Result<(), String> {
    match entry(&secret_account(&name))?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
