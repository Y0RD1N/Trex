//! Logo de cada proyecto para la barra lateral.
//!
//! Se busca donde suelen estar: el icono que enlaza `index.html`, los iconos de
//! Tauri y los nombres habituales (`favicon.svg`, `logo.png`…) en las carpetas
//! típicas. En monorepos se mira también dentro de `apps/*` y `packages/*`.
//! Solo se hacen unas pocas comprobaciones fijas, nunca un recorrido completo.
use base64::Engine;
use std::path::{Path, PathBuf};

/// Tamaño máximo de un logo que se lee.
const MAX_BYTES: u64 = 1024 * 1024;
/// Por encima de este tamaño, un PNG se reduce antes de enviarlo a la ventana.
const SHRINK_ABOVE: usize = 24 * 1024;
const SHRINK_EDGE: u32 = 64;

const FOLDERS: &[&str] = &[
    "", "public", "public/brand", "public/images", "public/img", "public/icons", "static", "assets",
    "src/assets", "app", "src/app", "resources", "build", "media", ".github",
];
const NAMES: &[&str] = &[
    "logo.svg", "logo-mark.svg", "icon.svg", "favicon.svg", "logo.png", "icon.png",
    "apple-touch-icon.png", "icon-192.png", "favicon.png", "logo.webp", "favicon.ico", "icon.ico",
];
const TAURI_ICONS: &[&str] = &[
    "src-tauri/icons/128x128.png", "src-tauri/icons/icon.png", "src-tauri/icons/32x32.png", "src-tauri/icons/icon.ico",
];
const HTML_PAGES: &[&str] = &["index.html", "public/index.html", "src/index.html"];

fn media_type(path: &Path, bytes: &[u8]) -> Option<&'static str> {
    let ext = path.extension()?.to_string_lossy().to_ascii_lowercase();
    match ext.as_str() {
        "svg" => {
            let head = String::from_utf8_lossy(&bytes[..bytes.len().min(4096)]).to_ascii_lowercase();
            head.contains("<svg").then_some("image/svg+xml")
        }
        "ico" => bytes.starts_with(&[0, 0, 1, 0]).then_some("image/x-icon"),
        _ => crate::attachments::image_type(bytes),
    }
}

/// El logo como `data:` URL, si el archivo existe y es una imagen.
fn data_url(path: &Path) -> Option<String> {
    let metadata = std::fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_BYTES {
        return None;
    }
    let mut bytes = std::fs::read(path).ok()?;
    let kind = media_type(path, &bytes)?;
    if kind == "image/png" && bytes.len() > SHRINK_ABOVE {
        if let Some(small) = shrink(&bytes) {
            bytes = small;
        }
    }
    Some(format!("data:{kind};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

fn shrink(bytes: &[u8]) -> Option<Vec<u8>> {
    let picture = image::load_from_memory_with_format(bytes, image::ImageFormat::Png).ok()?;
    let picture = picture.resize(SHRINK_EDGE, SHRINK_EDGE, image::imageops::FilterType::Lanczos3);
    let mut out = std::io::Cursor::new(Vec::new());
    picture.write_to(&mut out, image::ImageFormat::Png).ok()?;
    Some(out.into_inner())
}

fn attribute(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let mut from = 0;
    while let Some(found) = lower[from..].find(name) {
        let start = from + found;
        from = start + name.len();
        let before = lower[..start].chars().last();
        if !before.is_some_and(char::is_whitespace) {
            continue;
        }
        let rest = lower[from..].trim_start();
        let Some(rest) = rest.strip_prefix('=') else { continue };
        let offset = tag.len() - rest.len();
        let value = tag[offset..].trim_start();
        let (quote, value) = match value.chars().next()? {
            q @ ('"' | '\'') => (Some(q), &value[1..]),
            _ => (None, value),
        };
        let end = match quote {
            Some(q) => value.find(q)?,
            None => value.find(|c: char| c.is_whitespace() || c == '>').unwrap_or(value.len()),
        };
        return Some(value[..end].to_string());
    }
    None
}

/// Los `href` de los `<link rel="…icon…">` de una página, en orden.
pub(crate) fn icon_links(html: &str) -> Vec<String> {
    let lower = html.to_ascii_lowercase();
    let mut links = Vec::new();
    let mut from = 0;
    while let Some(found) = lower[from..].find("<link") {
        let start = from + found;
        let end = lower[start..].find('>').map_or(html.len(), |end| start + end);
        let tag = &html[start..end];
        from = end;
        let rel = attribute(tag, "rel").unwrap_or_default().to_ascii_lowercase();
        if rel.split_whitespace().any(|part| part == "icon" || part == "apple-touch-icon") {
            if let Some(href) = attribute(tag, "href") {
                links.push(href);
            }
        }
    }
    links
}

fn from_html(base: &Path, page: &Path) -> Option<String> {
    let metadata = std::fs::metadata(page).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_BYTES {
        return None;
    }
    let html = std::fs::read_to_string(page).ok()?;
    let page_dir = page.parent().unwrap_or(base);
    for href in icon_links(&html) {
        if href.starts_with("data:image/") {
            return Some(href);
        }
        if href.contains("://") || href.starts_with("//") {
            continue;
        }
        let clean = href.split(['?', '#']).next().unwrap_or_default();
        let candidates: Vec<PathBuf> = match clean.strip_prefix('/') {
            Some(rooted) => vec![base.join("public").join(rooted), base.join(rooted), base.join("static").join(rooted)],
            None => vec![page_dir.join(clean), base.join("public").join(clean)],
        };
        if let Some(url) = candidates.iter().find_map(|path| data_url(path)) {
            return Some(url);
        }
    }
    None
}

fn find_in(base: &Path) -> Option<String> {
    HTML_PAGES
        .iter()
        .find_map(|page| from_html(base, &base.join(page)))
        .or_else(|| TAURI_ICONS.iter().find_map(|icon| data_url(&base.join(icon))))
        .or_else(|| {
            FOLDERS
                .iter()
                .flat_map(|folder| NAMES.iter().map(move |name| base.join(folder).join(name)))
                .find_map(|path| data_url(&path))
        })
}

/// Subproyectos de un monorepo, en orden alfabético.
fn workspaces(root: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    for group in ["apps", "packages"] {
        let Ok(entries) = std::fs::read_dir(root.join(group)) else { continue };
        let mut dirs: Vec<PathBuf> = entries
            .flatten()
            .take(40)
            .map(|entry| entry.path())
            .filter(|path| path.is_dir())
            .collect();
        dirs.sort();
        found.extend(dirs);
    }
    found
}

pub(crate) fn find_project_icon(root: &Path) -> Option<String> {
    if !root.is_dir() {
        return None;
    }
    find_in(root).or_else(|| workspaces(root).iter().find_map(|dir| find_in(dir)))
}

#[tauri::command]
pub async fn project_icon(path: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || find_project_icon(Path::new(&path)))
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SVG: &[u8] = b"<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>";

    #[test]
    fn icon_links_are_read_in_any_attribute_order() {
        let html = r#"<head>
            <link rel="stylesheet" href="/app.css">
            <link href='/brand/mark.svg' type="image/svg+xml" rel='icon' />
            <LINK REL="apple-touch-icon" HREF=/touch.png>
            <link rel="mask-icon" href="/mask.svg">
        </head>"#;
        assert_eq!(icon_links(html), vec!["/brand/mark.svg", "/touch.png"]);
    }

    #[test]
    fn logos_are_found_where_projects_keep_them() {
        let root = std::env::temp_dir().join(format!("trex-icon-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);

        // El icono enlazado desde index.html gana a los nombres habituales.
        let web = root.join("web");
        std::fs::create_dir_all(web.join("public/brand")).unwrap();
        std::fs::write(web.join("index.html"), r#"<link rel="icon" href="/brand/mark.svg?v=2">"#).unwrap();
        std::fs::write(web.join("public/brand/mark.svg"), SVG).unwrap();
        std::fs::write(web.join("public/favicon.svg"), b"<svg>otro</svg>").unwrap();
        let url = find_project_icon(&web).unwrap();
        assert!(url.starts_with("data:image/svg+xml;base64,"));
        let body = base64::engine::general_purpose::STANDARD.decode(&url[26..]).unwrap();
        assert_eq!(body, SVG);

        // Monorepo: el icono de Tauri de una app interna.
        let mono = root.join("mono");
        std::fs::create_dir_all(mono.join("apps/desktop/src-tauri/icons")).unwrap();
        std::fs::write(mono.join("apps/desktop/src-tauri/icons/32x32.png"), b"\x89PNG\r\n\x1a\n0000").unwrap();
        assert!(find_project_icon(&mono).unwrap().starts_with("data:image/png;base64,"));

        // Un archivo con nombre de logo que no es una imagen no cuenta.
        let plain = root.join("plain");
        std::fs::create_dir_all(&plain).unwrap();
        std::fs::write(plain.join("logo.png"), b"texto").unwrap();
        assert_eq!(find_project_icon(&plain), None);
        assert_eq!(find_project_icon(&root.join("no-existe")), None);

        std::fs::remove_dir_all(&root).unwrap();
    }
}
