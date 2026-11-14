//! Claves de API del modo llamada (Gemini Live, ElevenLabs).
//!
//! La persona escribe su clave en Ajustes; aquí se guarda cifrada con DPAPI de
//! Windows (solo su usuario en este equipo puede descifrarla) y no vuelve nunca
//! al frontend: el estado solo dice si hay clave o no.
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

pub const PROVIDERS: &[&str] = &["gemini", "elevenlabs"];

fn valid_provider(provider: &str) -> Result<(), String> {
    if PROVIDERS.contains(&provider) { Ok(()) } else { Err("Proveedor de voz desconocido.".into()) }
}

/// Una clave de API es una sola línea de caracteres visibles, sin espacios.
fn clean_key(key: &str) -> Result<String, String> {
    let key = key.trim();
    if key.len() < 8 || key.len() > 512 || !key.chars().all(|c| c.is_ascii_graphic()) {
        return Err("Esa clave no tiene el formato de una clave de API.".into());
    }
    Ok(key.to_string())
}

fn path(app: &AppHandle, provider: &str) -> Result<PathBuf, String> {
    valid_provider(provider)?;
    app.path().app_data_dir().map(|dir| dir.join("voice-keys").join(format!("{provider}.dpapi")))
        .map_err(|error| format!("No se encontró la carpeta de datos de la app: {error}"))
}

pub fn has(app: &AppHandle, provider: &str) -> bool {
    path(app, provider).is_ok_and(|path| path.is_file())
}

/// La clave descifrada, para usarla en una conexión. `None` si no hay o no se pudo leer.
pub fn load(app: &AppHandle, provider: &str) -> Option<String> {
    let bytes = std::fs::read(path(app, provider).ok()?).ok()?;
    let plain = dpapi::unprotect(&bytes).ok()?;
    String::from_utf8(plain).ok().filter(|key| !key.is_empty())
}

fn save(app: &AppHandle, provider: &str, key: &str) -> Result<(), String> {
    let key = clean_key(key)?;
    let path = path(app, provider)?;
    if let Some(dir) = path.parent() { std::fs::create_dir_all(dir).map_err(|e| e.to_string())?; }
    // Al disco solo llega el texto cifrado.
    let protected = dpapi::protect(key.as_bytes())?;
    let temporary = path.with_extension("dpapi.tmp");
    std::fs::write(&temporary, protected).map_err(|e| format!("No se pudo guardar la clave: {e}"))?;
    std::fs::rename(&temporary, &path).map_err(|e| format!("No se pudo guardar la clave: {e}"))
}

fn remove(app: &AppHandle, provider: &str) -> Result<(), String> {
    match std::fs::remove_file(path(app, provider)?) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("No se pudo borrar la clave: {error}")),
    }
}

#[tauri::command]
pub fn voice_key_set(app: AppHandle, provider: String, key: String) -> Result<(), String> {
    save(&app, &provider, &key)
}

#[tauri::command]
pub fn voice_key_clear(app: AppHandle, provider: String) -> Result<(), String> {
    remove(&app, &provider)
}

#[cfg(windows)]
mod dpapi {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB};

    /// Copia la salida de DPAPI, la borra de su búfer y lo libera.
    unsafe fn take(blob: CRYPT_INTEGER_BLOB) -> Vec<u8> {
        if blob.pbData.is_null() { return Vec::new(); }
        let bytes = std::slice::from_raw_parts(blob.pbData, blob.cbData as usize).to_vec();
        for offset in 0..blob.cbData as usize {
            std::ptr::write_volatile(blob.pbData.add(offset), 0);
        }
        let _ = LocalFree(Some(HLOCAL(blob.pbData.cast())));
        bytes
    }

    fn run(input: &[u8], protect: bool) -> Result<Vec<u8>, String> {
        let input = CRYPT_INTEGER_BLOB { cbData: input.len() as u32, pbData: input.as_ptr().cast_mut() };
        let mut output = CRYPT_INTEGER_BLOB::default();
        let result = unsafe {
            if protect {
                CryptProtectData(&input, PCWSTR::null(), None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut output)
            } else {
                CryptUnprotectData(&input, None, None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut output)
            }
        };
        result.map_err(|_| "Windows no pudo proteger la clave.".to_string())?;
        Ok(unsafe { take(output) })
    }

    pub fn protect(plain: &[u8]) -> Result<Vec<u8>, String> { run(plain, true) }
    pub fn unprotect(protected: &[u8]) -> Result<Vec<u8>, String> { run(protected, false) }
}

#[cfg(not(windows))]
mod dpapi {
    pub fn protect(_: &[u8]) -> Result<Vec<u8>, String> { Err("Las claves de voz solo se pueden guardar en Windows por ahora.".into()) }
    pub fn unprotect(_: &[u8]) -> Result<Vec<u8>, String> { Err("Las claves de voz solo se pueden guardar en Windows por ahora.".into()) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_known_providers_and_plausible_keys_are_accepted() {
        assert!(valid_provider("gemini").is_ok());
        assert!(valid_provider("elevenlabs").is_ok());
        assert!(valid_provider("../otro").is_err());
        assert_eq!(clean_key("  AIzaSyExample-123_abc  ").unwrap(), "AIzaSyExample-123_abc");
        assert!(clean_key("corta").is_err());
        assert!(clean_key("con espacios dentro de la clave").is_err());
        assert!(clean_key("línea\nnueva-0123456789").is_err());
    }

    #[cfg(windows)]
    #[test]
    fn a_key_survives_encryption_and_never_sits_in_the_clear() {
        let key = b"sk_test_0123456789abcdef";
        let protected = dpapi::protect(key).unwrap();
        assert!(!protected.windows(key.len()).any(|window| window == key));
        assert_eq!(dpapi::unprotect(&protected).unwrap(), key);
        assert!(dpapi::unprotect(b"esto no es un cifrado valido").is_err());
    }
}
