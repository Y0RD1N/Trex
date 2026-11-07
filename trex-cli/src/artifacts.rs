//! Durable, content-addressed tool artifacts. Image payloads exist only in the
//! private store and in a transient provider request, never in normalized JSON.

use std::{
    fs::{self, File, OpenOptions},
    io::{Cursor, Read, Write},
    path::{Path, PathBuf},
};

use anyhow::{anyhow, bail, ensure, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use image::{ImageDecoder, ImageFormat, ImageReader};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const MAX_IMAGE_BYTES: usize = 4 * 1024 * 1024;
const MAX_IMAGES: usize = 16;
const MAX_DIMENSION: u32 = 16_384;
const MAX_PIXELS: u64 = 64_000_000;
// RGBA16 is the largest decoded pixel among the supported formats. Check
// decoder output size before allocating it; Limits::max_alloc is best effort.
const MAX_DECODED_BYTES: u64 = MAX_PIXELS * 8;
const OMITTED: &str = "[image payload omitted; use artifact metadata]";

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ArtifactStorage {
    #[default]
    Local,
    Broker,
}

/// A durable reference, never a path or URL. Broker references are metadata
/// only: restoring history must not fetch them or repeat the originating tool.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactRef {
    pub id: String,
    pub sha256: String,
    pub mime_type: String,
    pub size_bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    pub kind: String,
    #[serde(default)]
    pub storage: ArtifactStorage,
    pub provenance: Value,
}

/// Normalize an MCP CallToolResult while leaving native tool values unchanged.
/// Each image failure becomes a finite text note, retaining the completed tool
/// result. No source parser/filesystem errors (which could quote payloads) leak.
pub fn normalize_tool_result(raw: Value, provenance: Value) -> Result<Value> {
    normalize_at(raw, provenance, &|| {
        Ok(crate::profile::home()?.join("artifacts"))
    })
}

fn normalize_at(
    raw: Value,
    provenance: Value,
    directory: &impl Fn() -> Result<PathBuf>,
) -> Result<Value> {
    let Some(content) = raw.get("content").and_then(Value::as_array) else {
        return Ok(raw);
    };
    if !content
        .iter()
        .all(|item| item.get("type").and_then(Value::as_str).is_some())
    {
        return Ok(raw);
    }
    let mut payloads = Vec::new();
    collect_payloads(&raw, &mut payloads, 0);
    let provenance = scrub(&provenance, &payloads, 0);
    let mut text = Vec::new();
    let mut artifacts = Vec::new();
    let mut count = 0;
    let structured = raw.get("structuredContent").filter(|v| !v.is_null());
    for item in content {
        match item.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(value) = item.get("text").and_then(Value::as_str) {
                    // MCP servers (Trex Browser included) repeat structuredContent
                    // as its JSON text. Keep one copy instead of a second,
                    // escaped serialization inside the stored result.
                    if structured.is_some_and(|structured| {
                        value.trim_start().starts_with('{')
                            && serde_json::from_str::<Value>(value).is_ok_and(|v| &v == structured)
                    }) {
                        continue;
                    }
                    text.push(scrub_text(value, &payloads));
                }
            }
            Some("image") => {
                count += 1;
                let stored = if count <= MAX_IMAGES {
                    store_image(item, provenance.clone(), directory)
                } else {
                    Err(anyhow!("too many images"))
                };
                match stored {
                    Ok(reference) => artifacts.push(reference),
                    Err(_) => text.push("Image artifact unavailable: invalid, oversized, or could not be stored privately. The tool completed; do not repeat it solely to recover this image.".to_owned()),
                }
            }
            _ => text.push("Non-text tool content omitted from durable history.".to_owned()),
        }
    }
    // Metadata-only diagnostics have broker identities, never local paths.
    // A matching local image supersedes its broker metadata reference.
    if let Some(metadata) = raw
        .pointer("/structuredContent/artifacts")
        .and_then(Value::as_array)
    {
        for item in metadata.iter().take(64) {
            if let Some(reference) = broker_reference(item, &provenance, &payloads) {
                if let Some(local) = artifacts.iter_mut().find(|local| {
                    local.storage == ArtifactStorage::Local
                        && local.sha256 == reference.sha256
                        && local.mime_type == reference.mime_type
                }) {
                    // Preserve the broker identity for artifact-open UI even
                    // when provider replay uses the locally verified bytes.
                    local.provenance = reference.provenance;
                } else {
                    artifacts.push(reference);
                }
            }
        }
    }
    let mut normalized = json!({"text":text.join("\n"),"artifacts":artifacts});
    if let Some(structured) = raw.get("structuredContent") {
        normalized["structuredContent"] = scrub(structured, &payloads, 0);
    }
    if let Some(is_error) = raw.get("isError").and_then(Value::as_bool) {
        normalized["isError"] = json!(is_error);
    }
    Ok(normalized)
}

fn broker_reference(item: &Value, provenance: &Value, payloads: &[&str]) -> Option<ArtifactRef> {
    let id = item
        .get("artifactId")
        .or_else(|| item.get("id"))?
        .as_str()?;
    let mime = item.get("mimeType")?.as_str()?;
    if id.is_empty()
        || id.len() > 256
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b':' | b'.'))
    {
        return None;
    }
    let mime_token = |token: &str| {
        !token.is_empty()
            && token
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"!#$&^_.+-".contains(&c))
    };
    if mime.len() > 128
        || !mime
            .split_once('/')
            .is_some_and(|(kind, subtype)| mime_token(kind) && mime_token(subtype))
    {
        return None;
    }
    let sha256 = item.get("sha256").and_then(Value::as_str).unwrap_or("");
    if !sha256.is_empty() && !valid_hash(sha256) {
        return None;
    }
    let mut source = json!({"tool":provenance,"brokerArtifactId":id});
    for field in ["projectId", "profile", "createdAt"] {
        if let Some(value) = item.get(field) {
            source[field] = scrub(value, payloads, 0);
        }
    }
    Some(ArtifactRef {
        id: id.to_owned(),
        sha256: sha256.to_owned(),
        mime_type: mime.to_owned(),
        size_bytes: item
            .get("bytes")
            .or_else(|| item.get("sizeBytes"))
            .and_then(Value::as_u64)
            .unwrap_or(0),
        width: item
            .get("width")
            .and_then(Value::as_u64)
            .and_then(|n| n.try_into().ok()),
        height: item
            .get("height")
            .and_then(Value::as_u64)
            .and_then(|n| n.try_into().ok()),
        kind: item
            .get("kind")
            .and_then(Value::as_str)
            .filter(|kind| {
                !kind.is_empty()
                    && kind.len() <= 64
                    && kind
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.'))
            })
            .unwrap_or_else(|| {
                if mime.starts_with("video/") {
                    "video"
                } else if mime.starts_with("image/") {
                    "image"
                } else {
                    "artifact"
                }
            })
            .to_owned(),
        storage: ArtifactStorage::Broker,
        provenance: source,
    })
}

fn collect_payloads<'a>(value: &'a Value, payloads: &mut Vec<&'a str>, depth: usize) {
    if depth > 64 {
        return;
    }
    match value {
        Value::Object(map) => {
            let image = image_object(value);
            for (key, field) in map {
                if (image && key == "data") || binary_field(key) {
                    if let Some(data) = field.as_str().filter(|s| s.len() >= 16) {
                        // Short malformed values cannot be screenshot bytes.
                        // Bound tracking independently of the broker's shape.
                        if payloads.len() < 256 && !payloads.contains(&data) {
                            payloads.push(data);
                        }
                    }
                }
            }
            for value in map.values() {
                collect_payloads(value, payloads, depth + 1);
            }
        }
        Value::Array(array) => {
            for value in array {
                collect_payloads(value, payloads, depth + 1);
            }
        }
        _ => {}
    }
}

fn image_object(value: &Value) -> bool {
    matches!(
        value.get("type").and_then(Value::as_str),
        Some("image" | "image_url")
    ) || ["mimeType", "mediaType", "mime_type"].iter().any(|key| {
        value
            .get(*key)
            .and_then(Value::as_str)
            .is_some_and(|s| s.starts_with("image/"))
    })
}

fn binary_field(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    lower.contains("base64")
        || matches!(
            lower.as_str(),
            "imagedata" | "screenshotdata" | "dataurl" | "data_url"
        )
}

fn scrub(value: &Value, payloads: &[&str], depth: usize) -> Value {
    if depth > 64 {
        return json!("[nested content omitted]");
    }
    match value {
        Value::String(s) => json!(scrub_text(s, payloads)),
        Value::Array(array) => Value::Array(
            array
                .iter()
                .map(|v| scrub(v, payloads, depth + 1))
                .collect(),
        ),
        Value::Object(map) => {
            let image = image_object(value);
            let mut clean = serde_json::Map::new();
            for (key, value) in map {
                if (image && key == "data") || binary_field(key) {
                    clean.insert("artifactNote".to_owned(), json!(OMITTED));
                } else {
                    clean.insert(scrub_text(key, payloads), scrub(value, payloads, depth + 1));
                }
            }
            Value::Object(clean)
        }
        scalar => scalar.clone(),
    }
}

fn scrub_text(text: &str, payloads: &[&str]) -> String {
    // Remove every data URL, including non-image duplicates in broker metadata.
    // Require the scheme boundary and comma so ordinary "metadata:" survives.
    static DATA_URL: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let source = DATA_URL
        .get_or_init(|| {
            regex::Regex::new(r#"(?i)\bdata:[^\s"'<>]*,[^\s"'<>]*"#).expect("static data URL regex")
        })
        .replace_all(text, OMITTED);
    let mut positions: Vec<_> = payloads
        .iter()
        .map(|payload| source.find(payload))
        .collect();
    let mut cursor = 0;
    let mut clean = String::new();
    // Scan source text only. Inserted markers are never searched, and each
    // payload's next search advances past the preceding replacement.
    while let Some((index, start)) = positions
        .iter()
        .enumerate()
        .filter_map(|(i, position)| position.map(|start| (i, start)))
        .min_by_key(|&(i, start)| (start, usize::MAX - payloads[i].len()))
    {
        let end = start + payloads[index].len();
        clean.push_str(&source[cursor..start]);
        clean.push_str(OMITTED);
        cursor = end;
        for (index, position) in positions.iter_mut().enumerate() {
            if position.is_some_and(|start| start < cursor) {
                *position = source[cursor..]
                    .find(payloads[index])
                    .map(|start| cursor + start);
            }
        }
    }
    clean.push_str(&source[cursor..]);
    // Also catch a duplicate embedded in text when the broker accidentally
    // supplies only structured content instead of a typed image block.
    static IMAGE_BASE64: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    IMAGE_BASE64
        .get_or_init(|| {
            regex::Regex::new(r"(?:iVBORw0KGgo|/9j/|R0lGOD|UklGR)[A-Za-z0-9+/_-]*={0,2}")
                .expect("static image payload regex")
        })
        .replace_all(&clean, OMITTED)
        .into_owned()
}

fn store_image(
    item: &Value,
    provenance: Value,
    directory: &impl Fn() -> Result<PathBuf>,
) -> Result<ArtifactRef> {
    let encoded = item
        .get("data")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("missing image data"))?;
    ensure!(
        encoded.len() <= MAX_IMAGE_BYTES.div_ceil(3) * 4,
        "oversized image"
    );
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| anyhow!("invalid image encoding"))?;
    ensure!(
        !bytes.is_empty() && bytes.len() <= MAX_IMAGE_BYTES,
        "oversized image"
    );
    let mime = item
        .get("mimeType")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("missing image MIME"))?;
    let (width, height) = dimensions(&bytes, mime)?;
    let hash = format!("{:x}", Sha256::digest(&bytes));
    let reference = ArtifactRef {
        id: hash.clone(),
        sha256: hash,
        mime_type: mime.to_owned(),
        size_bytes: bytes.len() as u64,
        width: Some(width),
        height: Some(height),
        kind: "image".into(),
        storage: ArtifactStorage::Local,
        provenance,
    };
    let directory = directory()?;
    private_directory(&directory)?;
    let path = directory.join(format!("{}.bin", reference.id));
    reject_links(&path)?;
    if path.try_exists()? {
        read_image_at(&directory, &reference)?;
        return Ok(reference);
    }
    let temporary = directory.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let written = (|| -> Result<()> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        private_options(&mut options);
        let mut file = options.open(&temporary)?;
        secure_file(&file, true)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        reject_links(&directory)?;
        if path.try_exists()? {
            read_image_at(&directory, &reference)?;
        } else if publish_file(&temporary, &path).is_err() {
            read_image_at(&directory, &reference)?;
        }
        #[cfg(unix)]
        File::open(&directory)?.sync_all()?;
        Ok(())
    })();
    let _ = fs::remove_file(&temporary);
    written.map_err(|_| anyhow!("could not store image artifact privately"))?;
    Ok(reference)
}

/// Rehydrate a local reference for a transient provider request. The reference
/// contributes only a validated hash; neither paths nor broker IDs are opened.
pub fn image_data_url(reference: &ArtifactRef) -> Result<String> {
    let bytes = read_image_at(&crate::profile::home()?.join("artifacts"), reference)?;
    Ok(format!(
        "data:{};base64,{}",
        reference.mime_type,
        STANDARD.encode(bytes)
    ))
}

fn valid_hash(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

fn read_image_at(directory: &Path, reference: &ArtifactRef) -> Result<Vec<u8>> {
    ensure!(
        reference.storage == ArtifactStorage::Local && reference.kind == "image",
        "artifact is metadata only"
    );
    ensure!(
        valid_hash(&reference.id) && reference.id == reference.sha256,
        "invalid artifact identity"
    );
    ensure!(
        reference.size_bytes > 0 && reference.size_bytes <= MAX_IMAGE_BYTES as u64,
        "oversized artifact"
    );
    check_private_directory(directory)?;
    let path = directory.join(format!("{}.bin", reference.id));
    reject_links(&path)?;
    let before = fs::symlink_metadata(&path)?;
    ensure!(
        before.is_file() && before.len() == reference.size_bytes,
        "artifact must be a bounded regular file"
    );
    let mut options = OpenOptions::new();
    options.read(true);
    private_options(&mut options);
    let file = options.open(&path)?;
    secure_file(&file, false)?;
    let after = file.metadata()?;
    ensure!(
        before.len() == after.len() && after.len() == reference.size_bytes,
        "artifact length mismatch"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        ensure!(
            before.dev() == after.dev() && before.ino() == after.ino(),
            "artifact changed while opening"
        );
    }
    reject_links(&path)?;
    let mut bytes = Vec::new();
    file.take(MAX_IMAGE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 == reference.size_bytes
            && format!("{:x}", Sha256::digest(&bytes)) == reference.sha256,
        "artifact integrity check failed"
    );
    let (width, height) = dimensions(&bytes, &reference.mime_type)?;
    ensure!(
        reference.width == Some(width) && reference.height == Some(height),
        "artifact dimensions mismatch"
    );
    Ok(bytes)
}

fn dimensions(bytes: &[u8], mime: &str) -> Result<(u32, u32)> {
    let invalid = || anyhow!("unsupported or invalid image");
    let format = match mime {
        "image/png" => ImageFormat::Png,
        "image/jpeg" => ImageFormat::Jpeg,
        "image/gif" => ImageFormat::Gif,
        "image/webp" => ImageFormat::WebP,
        _ => return Err(invalid()),
    };
    ensure!(
        image::guess_format(bytes).map_err(|_| invalid())? == format,
        "image MIME mismatch"
    );
    // Retain complete-container checks: some decoders recover a first image
    // from a file with its trailer removed.
    let complete = match format {
        ImageFormat::Png => bytes.ends_with(b"\0\0\0\0IEND\xae\x42\x60\x82"),
        ImageFormat::Jpeg => bytes.ends_with(&[0xff, 0xd9]),
        ImageFormat::Gif => bytes.last() == Some(&b';'),
        ImageFormat::WebP => bytes
            .get(4..8)
            .and_then(|length| <[u8; 4]>::try_from(length).ok())
            .is_some_and(|length| u32::from_le_bytes(length) as u64 + 8 == bytes.len() as u64),
        _ => false,
    };
    ensure!(complete, "incomplete image container");
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_DIMENSION);
    limits.max_image_height = Some(MAX_DIMENSION);
    limits.max_alloc = Some(MAX_DECODED_BYTES);
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    reader.limits(limits.clone());
    let mut decoder = reader.into_decoder().map_err(|_| invalid())?;
    let dimensions = decoder.dimensions();
    ensure!(
        dimensions.0 > 0
            && dimensions.1 > 0
            && dimensions.0 <= MAX_DIMENSION
            && dimensions.1 <= MAX_DIMENSION
            && dimensions.0 as u64 * dimensions.1 as u64 <= MAX_PIXELS,
        "image dimensions exceed limits"
    );
    let output_bytes = decoder.total_bytes();
    ensure!(
        output_bytes <= MAX_DECODED_BYTES,
        "decoded image exceeds limits"
    );
    if format == ImageFormat::Jpeg {
        // image's JPEG wrapper deliberately recovers missing scan data. Verify
        // entropy decoding independently so incomplete evidence is never published.
        let mut strict = jpeg_decoder::Decoder::new(Cursor::new(bytes));
        strict.set_max_decoding_buffer_size(MAX_DECODED_BYTES as usize);
        strict.read_info().map_err(|_| invalid())?;
        let info = strict.info().ok_or_else(invalid)?;
        ensure!(
            (info.width as u32, info.height as u32) == dimensions,
            "image dimensions mismatch"
        );
        let pixels = strict.decode().map_err(|_| invalid())?;
        ensure!(
            pixels.len() as u64 <= MAX_DECODED_BYTES,
            "decoded image exceeds limits"
        );
        return Ok(dimensions);
    }
    if format == ImageFormat::Png {
        // image's PNG decoder tolerates an unfinished zlib stream once enough
        // pixels exist. Verify framing, CRCs and stream completion separately.
        // Seven filter rows per image row also bounds Adam7 interlacing.
        validate_png_stream(bytes, output_bytes + 7 * dimensions.1 as u64)?;
    }
    // Reserve the checked output from the decoder's allocation budget too.
    // Decoder internals additionally use the strict dimension limits above.
    limits.reserve(output_bytes).map_err(|_| invalid())?;
    decoder.set_limits(limits).map_err(|_| invalid())?;
    let output_bytes: usize = output_bytes.try_into().map_err(|_| invalid())?;
    let mut pixels = Vec::new();
    pixels
        .try_reserve_exact(output_bytes)
        .map_err(|_| invalid())?;
    pixels.resize(output_bytes, 0);
    decoder.read_image(&mut pixels).map_err(|_| invalid())?;
    Ok(dimensions)
}

fn validate_png_stream(bytes: &[u8], max_scanline_bytes: u64) -> Result<()> {
    use flate2::{Decompress, FlushDecompress, Status};

    let invalid = || anyhow!("invalid PNG data");
    ensure!(bytes.len() <= MAX_IMAGE_BYTES, "oversized PNG");
    let mut compressed = Vec::new();
    compressed
        .try_reserve_exact(bytes.len())
        .map_err(|_| invalid())?;
    let mut position = 8usize;
    let mut ended = false;
    while position < bytes.len() {
        let header_end = position.checked_add(8).ok_or_else(invalid)?;
        let header = bytes.get(position..header_end).ok_or_else(invalid)?;
        let length = u32::from_be_bytes(header[..4].try_into()?) as usize;
        let data_end = header_end.checked_add(length).ok_or_else(invalid)?;
        let chunk_end = data_end.checked_add(4).ok_or_else(invalid)?;
        let chunk = bytes.get(position + 4..data_end).ok_or_else(invalid)?;
        let crc = bytes.get(data_end..chunk_end).ok_or_else(invalid)?;
        ensure!(
            crc32fast::hash(chunk) == u32::from_be_bytes(crc.try_into()?),
            "invalid PNG checksum"
        );
        match &header[4..8] {
            b"IDAT" => compressed.extend_from_slice(&bytes[header_end..data_end]),
            b"IEND" => {
                ensure!(
                    length == 0 && chunk_end == bytes.len(),
                    "invalid PNG ending"
                );
                ended = true;
                break;
            }
            _ => {}
        }
        position = chunk_end;
    }
    ensure!(ended && !compressed.is_empty(), "missing PNG image data");
    // Verify with a maintained zlib implementation without retaining a second
    // decoded image. Progress and output caps also bound malformed streams.
    let mut decoder = Decompress::new(true);
    let mut scratch = [0u8; 16 * 1024];
    loop {
        let before = (decoder.total_in(), decoder.total_out());
        let input = compressed
            .get(usize::try_from(before.0)?..)
            .ok_or_else(invalid)?;
        let status = decoder
            .decompress(input, &mut scratch, FlushDecompress::None)
            .map_err(|_| invalid())?;
        ensure!(
            decoder.total_out() <= max_scanline_bytes,
            "PNG image data exceeds limits"
        );
        if status == Status::StreamEnd {
            ensure!(
                decoder.total_in() == compressed.len() as u64,
                "trailing PNG image data"
            );
            return Ok(());
        }
        ensure!(
            (decoder.total_in(), decoder.total_out()) != before,
            "incomplete PNG image data"
        );
    }
}

fn reject_link_metadata(metadata: &fs::Metadata) -> Result<()> {
    #[cfg(windows)]
    let linked = {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    };
    #[cfg(not(windows))]
    let linked = metadata.file_type().is_symlink();
    ensure!(
        !linked,
        "artifact storage must not use links or reparse points"
    );
    Ok(())
}

fn reject_links(path: &Path) -> Result<()> {
    for component in path.ancestors() {
        match fs::symlink_metadata(component) {
            Ok(metadata) => reject_link_metadata(&metadata)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => bail!("could not inspect artifact storage"),
        }
    }
    Ok(())
}

fn private_directory(path: &Path) -> Result<()> {
    reject_links(path)?;
    let existed = path.try_exists()?;
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)?;
    #[cfg(windows)]
    if !existed {
        private_acl(&directory_handle(path)?, true, true)?;
    }
    #[cfg(not(windows))]
    let _ = existed;
    check_private_directory(path)
}

fn check_private_directory(path: &Path) -> Result<()> {
    reject_links(path)?;
    let metadata = fs::metadata(path)?;
    ensure!(metadata.is_dir(), "artifact store must be a directory");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        ensure!(
            metadata.permissions().mode() & 0o077 == 0,
            "artifact storage must be private"
        );
    }
    #[cfg(windows)]
    private_acl(&directory_handle(path)?, true, false)?;
    Ok(())
}

#[cfg(windows)]
fn directory_handle(path: &Path) -> Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    let file = OpenOptions::new()
        .access_mode(0x0002_0000 | 0x0004_0000)
        .custom_flags(0x0200_0000 | 0x0020_0000)
        .open(path)?;
    reject_link_metadata(&file.metadata()?)?;
    Ok(file)
}

fn private_options(options: &mut OpenOptions) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
        // Reject a last-component link at open, and never block on a FIFO if a
        // file is replaced between metadata inspection and opening it.
        #[cfg(any(target_os = "linux", target_os = "android"))]
        options.custom_flags(0x20000 | 0x800); // O_NOFOLLOW | O_NONBLOCK
        #[cfg(any(
            target_os = "macos",
            target_os = "ios",
            target_os = "freebsd",
            target_os = "openbsd",
            target_os = "netbsd",
            target_os = "dragonfly"
        ))]
        options.custom_flags(0x100 | 0x4); // O_NOFOLLOW | O_NONBLOCK
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options
            .custom_flags(0x0020_0000)
            .access_mode(0x8000_0000 | 0x4000_0000 | 0x0002_0000 | 0x0004_0000);
    }
    #[cfg(not(any(unix, windows)))]
    let _ = options;
}

#[cfg(not(windows))]
fn publish_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(windows)]
fn publish_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH};
    fn wide(path: &Path) -> std::io::Result<Vec<u16>> {
        let parent = path
            .parent()
            .ok_or_else(|| std::io::Error::other("invalid artifact directory"))?;
        let name = path
            .file_name()
            .ok_or_else(|| std::io::Error::other("invalid artifact filename"))?;
        let mut value: Vec<_> = fs::canonicalize(parent)?
            .join(name)
            .as_os_str()
            .encode_wide()
            .collect();
        value.push(0);
        Ok(value)
    }
    let source = wide(source)?;
    let destination = wide(destination)?;
    // No replacement or cross-volume copy: a concurrent publisher is checked
    // by hash, and the successful rename is flushed before publishing the ref.
    if unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

fn secure_file(file: &File, restrict: bool) -> Result<()> {
    let metadata = file.metadata()?;
    reject_link_metadata(&metadata)?;
    ensure!(metadata.is_file(), "artifact must be a regular file");
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        ensure!(metadata.nlink() == 1, "artifact must not use hard links");
        if restrict {
            file.set_permissions(fs::Permissions::from_mode(0o600))?;
        }
        ensure!(
            file.metadata()?.permissions().mode() & 0o077 == 0,
            "artifact must be private"
        );
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        };
        let mut information = BY_HANDLE_FILE_INFORMATION::default();
        ensure!(
            unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut information) } != 0
                && information.nNumberOfLinks == 1,
            "artifact must not use hard links"
        );
        private_acl(file, false, restrict)?;
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = restrict;
        bail!("private artifact storage unsupported on this platform");
    }
    Ok(())
}

#[cfg(windows)]
fn private_acl(file: &File, directory: bool, restrict: bool) -> Result<()> {
    use std::os::windows::io::AsRawHandle;
    use std::ptr;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Authorization::{
        GetSecurityInfo, SetEntriesInAclW, SetSecurityInfo, EXPLICIT_ACCESS_W, GRANT_ACCESS,
        SE_FILE_OBJECT, TRUSTEE_IS_SID, TRUSTEE_IS_USER, TRUSTEE_W,
    };
    use windows_sys::Win32::Security::{
        EqualSid, GetAce, GetTokenInformation, IsWellKnownSid, TokenUser,
        WinBuiltinAdministratorsSid, WinCreatorOwnerSid, WinLocalSystemSid, ACCESS_ALLOWED_ACE,
        ACE_HEADER, DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION,
        PROTECTED_DACL_SECURITY_INFORMATION, TOKEN_USER,
    };

    struct LocalAllocation(*mut std::ffi::c_void);
    impl Drop for LocalAllocation {
        fn drop(&mut self) {
            unsafe {
                LocalFree(self.0);
            }
        }
    }

    let failure = || anyhow!("could not restrict artifact storage to the current user");
    // The current-process token pseudo handle needs no CloseHandle (Windows 8+).
    let token = -4_isize as windows_sys::Win32::Foundation::HANDLE;
    let mut size = 0;
    unsafe {
        GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut size);
    }
    if size < std::mem::size_of::<TOKEN_USER>() as u32 {
        return Err(failure());
    }
    // usize gives TOKEN_USER the required pointer alignment.
    let mut user = vec![0usize; (size as usize).div_ceil(std::mem::size_of::<usize>())];
    if unsafe { GetTokenInformation(token, TokenUser, user.as_mut_ptr().cast(), size, &mut size) }
        == 0
    {
        return Err(failure());
    }
    let sid = unsafe { (*user.as_ptr().cast::<TOKEN_USER>()).User.Sid };
    let handle = file.as_raw_handle();
    let mut owner = ptr::null_mut();
    let mut existing_acl = ptr::null_mut();
    let mut descriptor = LocalAllocation(ptr::null_mut());
    if unsafe {
        GetSecurityInfo(
            handle,
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            ptr::null_mut(),
            &mut existing_acl,
            ptr::null_mut(),
            &mut descriptor.0,
        )
    } != 0
        || !crate::profile::trusted_owner(owner, sid)
    {
        return Err(failure());
    }
    if !restrict {
        // Do not rewrite ACLs on an existing artifact directory or silently trust
        // metadata from a shared file after repairing it. Unknown/conditional
        // ACE types are deliberately rejected.
        if existing_acl.is_null() {
            return Err(failure());
        }
        for index in 0..unsafe { (*existing_acl).AceCount } as u32 {
            let mut ace = ptr::null_mut();
            if unsafe { GetAce(existing_acl, index, &mut ace) } == 0 {
                return Err(failure());
            }
            let header = unsafe { &*ace.cast::<ACE_HEADER>() };
            if header.AceType == 1 {
                // ACCESS_DENIED_ACE_TYPE
                continue;
            }
            if header.AceType != 0 {
                // ACCESS_ALLOWED_ACE_TYPE
                return Err(failure());
            }
            let trustee = unsafe {
                ptr::addr_of!((*ace.cast::<ACCESS_ALLOWED_ACE>()).SidStart)
                    .cast_mut()
                    .cast()
            };
            let trusted = unsafe {
                EqualSid(trustee, sid) != 0
                    || IsWellKnownSid(trustee, WinLocalSystemSid) != 0
                    || IsWellKnownSid(trustee, WinBuiltinAdministratorsSid) != 0
                    || (header.AceFlags & 0x8 != 0 // INHERIT_ONLY_ACE
                        && IsWellKnownSid(trustee, WinCreatorOwnerSid) != 0)
            };
            if !trusted {
                bail!("artifact storage must be private to the current user");
            }
        }
        return Ok(());
    }
    let entry = EXPLICIT_ACCESS_W {
        grfAccessPermissions: 0x001f_01ff, // FILE_ALL_ACCESS
        grfAccessMode: GRANT_ACCESS,
        grfInheritance: if directory { 0x3 } else { 0 }, // OBJECT_INHERIT | CONTAINER_INHERIT
        Trustee: TRUSTEE_W {
            TrusteeForm: TRUSTEE_IS_SID,
            TrusteeType: TRUSTEE_IS_USER,
            ptstrName: sid.cast(),
            ..Default::default()
        },
    };
    let mut acl = ptr::null_mut();
    let status = unsafe { SetEntriesInAclW(1, &entry, ptr::null(), &mut acl) };
    let _acl = LocalAllocation(acl.cast());
    if status != 0
        || unsafe {
            SetSecurityInfo(
                handle,
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                ptr::null_mut(),
                ptr::null_mut(),
                acl,
                ptr::null(),
            )
        } != 0
    {
        return Err(failure());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";

    fn image() -> Value {
        json!({"type":"image","data":PNG,"mimeType":"image/png"})
    }

    fn normalized(directory: &Path, raw: Value) -> Value {
        normalize_at(
            raw,
            json!({"toolCallId":"screenshot-1","tool":"browser_screenshot"}),
            &|| Ok(directory.to_owned()),
        )
        .unwrap()
    }

    fn invalid_pngs() -> Vec<Vec<u8>> {
        let valid = STANDARD.decode(PNG).unwrap();
        vec![
            // The old signature/header/trailer validator accepted this.
            [valid[..33].to_vec(), valid[valid.len() - 12..].to_vec()].concat(),
            // Correct chunk CRCs, but corrupt or truncated DEFLATE data.
            STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42v///////////23SnkoAAAAASUVORK5CYII=").unwrap(),
            STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAABklEQVR42mP8/x+fo9NKAAAAAElFTkSuQmCC").unwrap(),
            // The original fixture had a corrupt IDAT CRC.
            STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jV1sAAAAASUVORK5CYII=").unwrap(),
            valid[..valid.len() - 13].to_vec(),
        ]
    }

    fn png_chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut chunk = (data.len() as u32).to_be_bytes().to_vec();
        chunk.extend_from_slice(kind);
        chunk.extend_from_slice(data);
        chunk.extend_from_slice(&crc32fast::hash(&chunk[4..]).to_be_bytes());
        chunk
    }

    #[test]
    fn png_stream_checks_are_bounded_and_allow_split_image_data() {
        use flate2::{write::ZlibEncoder, Compression};

        let bytes = STANDARD.decode(PNG).unwrap();
        let split = [
            bytes[..33].to_vec(),
            png_chunk(b"IDAT", &bytes[41..46]),
            png_chunk(b"IDAT", &bytes[46..52]),
            bytes[bytes.len() - 12..].to_vec(),
        ]
        .concat();
        assert_eq!(dimensions(&split, "image/png").unwrap(), (1, 1));

        // A tiny header must not grant a compressed stream an unbounded
        // decoded-work allowance, even when it has a complete checksum.
        let mut encoder = ZlibEncoder::new(Vec::new(), Compression::fast());
        encoder.write_all(&vec![0; 1024 * 1024]).unwrap();
        let inflated = [
            bytes[..33].to_vec(),
            png_chunk(b"IDAT", &encoder.finish().unwrap()),
            bytes[bytes.len() - 12..].to_vec(),
        ]
        .concat();
        assert!(validate_png_stream(&inflated, 9).is_err());
        assert!(dimensions(&inflated, "image/png").is_err());
    }

    #[test]
    fn undecodable_images_never_publish_local_references_or_payloads() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("artifacts");
        for bytes in invalid_pngs() {
            let data = STANDARD.encode(bytes);
            let output = normalized(
                &directory,
                json!({"content":[{"type":"text","text":"Tool completed"},{"type":"image","mimeType":"image/png","data":data}]}),
            );
            assert_eq!(output["artifacts"], json!([]));
            assert!(output["text"].as_str().unwrap().contains("Tool completed"));
            assert!(output["text"].as_str().unwrap().contains("do not repeat"));
            assert!(!output.to_string().contains(&data));
            assert!(!directory.exists());
        }
    }

    #[test]
    fn hash_correct_restored_undecodable_images_fail_rehydration() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("artifacts");
        private_directory(&directory).unwrap();
        for bytes in invalid_pngs() {
            let hash = format!("{:x}", Sha256::digest(&bytes));
            let reference = ArtifactRef {
                id: hash.clone(),
                sha256: hash,
                mime_type: "image/png".into(),
                size_bytes: bytes.len() as u64,
                width: Some(1),
                height: Some(1),
                kind: "image".into(),
                storage: ArtifactStorage::Local,
                provenance: json!({"tool":"browser_screenshot"}),
            };
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            private_options(&mut options);
            let mut file = options
                .open(directory.join(format!("{}.bin", reference.id)))
                .unwrap();
            secure_file(&file, true).unwrap();
            file.write_all(&bytes).unwrap();
            drop(file);
            assert!(read_image_at(&directory, &reference).is_err());
        }
    }

    #[test]
    fn supported_formats_decode_and_require_the_actual_mime() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("artifacts");
        let sample = image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
            2,
            3,
            image::Rgb([10, 20, 30]),
        ));
        for (format, mime) in [
            (ImageFormat::Png, "image/png"),
            (ImageFormat::Jpeg, "image/jpeg"),
            (ImageFormat::Gif, "image/gif"),
            (ImageFormat::WebP, "image/webp"),
        ] {
            let mut bytes = Cursor::new(Vec::new());
            sample.write_to(&mut bytes, format).unwrap();
            let bytes = bytes.into_inner();
            let output = normalized(
                &directory,
                json!({"content":[{"type":"image","mimeType":mime,"data":STANDARD.encode(&bytes)}]}),
            );
            let reference: ArtifactRef =
                serde_json::from_value(output["artifacts"][0].clone()).unwrap();
            assert_eq!((reference.width, reference.height), (Some(2), Some(3)));
            assert_eq!(read_image_at(&directory, &reference).unwrap(), bytes);
            for wrong_mime in [
                "image/png",
                "image/jpeg",
                "image/gif",
                "image/webp",
                "image/svg+xml",
            ] {
                if wrong_mime == mime {
                    continue;
                }
                let output = normalized(
                    &directory,
                    json!({"content":[{"type":"image","mimeType":wrong_mime,"data":STANDARD.encode(&bytes)}]}),
                );
                assert_eq!(output["artifacts"], json!([]));
                let mut forged = reference.clone();
                forged.mime_type = wrong_mime.into();
                assert!(read_image_at(&directory, &forged).is_err());
            }
        }
    }

    #[test]
    fn oversized_dimensions_and_pixel_counts_fail_before_pixel_decoding() {
        for data in [
            // Valid IHDR CRCs with width, height, or pixel count over the cap.
            "iVBORw0KGgoAAAANSUhEUgAAQAEAAAABCAQAAABjVBXtAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAEABCAQAAADxF3l7AAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
            "iVBORw0KGgoAAAANSUhEUgAAH0EAAB9ACAQAAABDOg5BAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
        ] {
            let bytes = STANDARD.decode(data).unwrap();
            let error = dimensions(&bytes, "image/png").unwrap_err().to_string();
            assert!(!error.contains(data));
            assert!(normalize_at(
                json!({"content":[{"type":"image","mimeType":"image/png","data":data}]}),
                Value::Null,
                &|| panic!("oversized image must not access storage")
            ).unwrap()["artifacts"].as_array().unwrap().is_empty());
        }
    }

    #[test]
    fn normalizes_text_images_and_structured_content_without_durable_payloads() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("artifacts");
        let raw = json!({"content":[{"type":"text","text":"Captured the page"},image()],"structuredContent":{"ok":true,"nested":[image(),{"copy":PNG,"url":format!("data:image/png;base64,{PNG}"),"base64":PNG}],"text":format!("duplicate {PNG}")},"isError":false});
        let output = normalized(&directory, raw);
        assert_eq!(output["text"], "Captured the page");
        assert_eq!(output["isError"], false);
        assert_eq!(output["structuredContent"]["ok"], true);
        let durable = output.to_string();
        assert!(!durable.contains(PNG));
        assert!(!durable.contains("data:image"));
        let artifact: ArtifactRef = serde_json::from_value(output["artifacts"][0].clone()).unwrap();
        assert_eq!((artifact.width, artifact.height), (Some(1), Some(1)));
        assert_eq!(artifact.mime_type, "image/png");
        assert_eq!(artifact.provenance["toolCallId"], "screenshot-1");
        assert!(valid_hash(&artifact.id));
        let bytes = read_image_at(&directory, &artifact).unwrap();
        assert_eq!(STANDARD.encode(&bytes), PNG);
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
        assert!(!durable.contains(".bin"));
        assert!(!durable.contains(temp.path().to_str().unwrap()));
        assert_eq!(
            normalized(&directory, json!({"content":[image()]}))["artifacts"][0]["id"],
            artifact.id
        );
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
    }

    #[test]
    fn native_values_and_already_normalized_results_pass_through() {
        for native in [
            json!({"stdout":"done","exitCode":0}),
            json!({"content":["native"]}),
            json!({"text":"done","artifacts":[]}),
            json!("native text"),
        ] {
            assert_eq!(
                normalize_at(native.clone(), Value::Null, &|| bail!(
                    "must not access storage"
                ))
                .unwrap(),
                native
            );
        }
        let result = normalize_at(json!({"content":[{"type":"text","text":"tool failed"}],"isError":true,"structuredContent":{"code":42}}), Value::Null, &|| bail!("text does not need storage")).unwrap();
        assert_eq!(
            result,
            json!({"text":"tool failed","artifacts":[],"structuredContent":{"code":42},"isError":true})
        );
    }

    #[test]
    fn duplicate_malformed_payloads_cannot_expand_inserted_omission_markers() {
        let mut content = vec![json!({"type":"text","text":"a"})];
        for _ in 0..10 {
            content.push(json!({"type":"image","mimeType":"image/png","data":"a"}));
        }
        let output = normalize_at(json!({"content":content}), Value::Null, &|| {
            bail!("invalid image must not access storage")
        })
        .unwrap();
        assert!(output.to_string().len() < 4096);
        assert_eq!(output["artifacts"], json!([]));
        // Even a malformed payload that matches the marker is processed only
        // from the original source, never from a preceding replacement.
        assert_eq!(scrub_text(OMITTED, &[OMITTED, OMITTED]), OMITTED);
    }

    #[test]
    fn json_text_binary_aliases_and_data_urls_are_scrubbed_without_image_sibling() {
        let structured = json!({"screenshotBase64":PNG,"description":"metadata: captured page","nested":{"url":format!("data:image/png;base64,{PNG}")}});
        let output = normalize_at(json!({"content":[{"type":"text","text":structured.to_string()}],"structuredContent":structured}), Value::Null, &|| bail!("no typed image bytes")).unwrap();
        assert!(!output.to_string().contains(PNG));
        assert!(!output.to_string().contains("data:image"));
        // The JSON text duplicate of structuredContent is stored once.
        assert_eq!(output["text"], "");
        assert_eq!(output.to_string().matches("metadata: captured page").count(), 1);
        assert_eq!(
            output["structuredContent"]["description"],
            "metadata: captured page"
        );
        // A different JSON text (or plain text) is never discarded.
        let output = normalize_at(json!({"content":[{"type":"text","text":"{\"description\":\"other\"}"},{"type":"text","text":"note"}],"structuredContent":structured}), Value::Null, &|| bail!("no typed image bytes")).unwrap();
        assert_eq!(output["text"], "{\"description\":\"other\"}\nnote");
    }

    #[test]
    fn metadata_only_video_refs_never_open_host_paths_or_broker_ids() {
        let output = normalize_at(json!({"content":[{"type":"text","text":"Video recorded"}],"structuredContent":{"artifacts":[{"artifactId":"opaque-video-id","kind":"video","mimeType":"video/webm","bytes":12345,"sha256":"a".repeat(64),"projectId":"project","profile":"private","createdAt":"2026-10-24"}]}}), json!({"tool":"browser_record"}), &|| bail!("metadata must not access storage")).unwrap();
        let reference: ArtifactRef =
            serde_json::from_value(output["artifacts"][0].clone()).unwrap();
        assert_eq!(reference.storage, ArtifactStorage::Broker);
        assert_eq!(reference.kind, "video");
        assert_eq!(reference.id, "opaque-video-id");
        assert_eq!(reference.size_bytes, 12345);
        assert_eq!(reference.provenance["projectId"], "project");
        assert!(read_image_at(Path::new("must-not-be-opened"), &reference).is_err());
    }

    #[test]
    fn trace_and_diagnostic_broker_metadata_keeps_mime_and_kind_without_host_reads() {
        let output = normalize_at(json!({"content":[{"type":"text","text":"Diagnostics captured"}],"structuredContent":{"artifacts":[
            {"artifactId":"trace-id","mimeType":"application/zip","kind":"trace","bytes":123,"sha256":"b".repeat(64)},
            {"artifactId":"cpu-id","mimeType":"application/json","kind":"cpu-profile","bytes":456},
            {"artifactId":"log-id","mimeType":"text/plain","bytes":789}
        ]}}), json!({"tool":"browser_trace"}), &|| bail!("broker diagnostics must never open host storage")).unwrap();
        let refs: Vec<ArtifactRef> = serde_json::from_value(output["artifacts"].clone()).unwrap();
        assert_eq!(refs.len(), 3);
        assert_eq!(
            (refs[0].mime_type.as_str(), refs[0].kind.as_str()),
            ("application/zip", "trace")
        );
        assert_eq!(
            (refs[1].mime_type.as_str(), refs[1].kind.as_str()),
            ("application/json", "cpu-profile")
        );
        assert_eq!(
            (refs[2].mime_type.as_str(), refs[2].kind.as_str()),
            ("text/plain", "artifact")
        );
        assert!(refs
            .iter()
            .all(|reference| reference.storage == ArtifactStorage::Broker));
        assert!(refs
            .iter()
            .all(|reference| read_image_at(Path::new("must-not-open"), reference).is_err()));
    }

    #[test]
    fn local_images_keep_matching_broker_identity_and_provenance() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("artifacts");
        let hash = format!("{:x}", Sha256::digest(STANDARD.decode(PNG).unwrap()));
        let output = normalized(
            &directory,
            json!({"content":[image()],"structuredContent":{"artifacts":[{"artifactId":"broker-screenshot-id","mimeType":"image/png","bytes":68,"sha256":hash,"width":1,"height":1,"kind":"image","projectId":"project","profile":"saved-profile","createdAt":"2026-10-24T00:00:00Z"}]}}),
        );
        assert_eq!(output["artifacts"].as_array().unwrap().len(), 1);
        let reference: ArtifactRef =
            serde_json::from_value(output["artifacts"][0].clone()).unwrap();
        assert_eq!(reference.id, hash);
        assert_eq!(reference.storage, ArtifactStorage::Local);
        assert_eq!(
            reference.provenance["brokerArtifactId"],
            "broker-screenshot-id"
        );
        assert_eq!(reference.provenance["projectId"], "project");
        assert_eq!(reference.provenance["profile"], "saved-profile");
        assert_eq!(reference.provenance["createdAt"], "2026-10-24T00:00:00Z");
        assert_eq!(reference.provenance["tool"]["toolCallId"], "screenshot-1");
        assert_eq!(
            STANDARD.encode(read_image_at(&directory, &reference).unwrap()),
            PNG
        );
    }

    #[test]
    fn malformed_oversized_images_and_duplicate_provenance_fail_soft() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("artifacts");
        let mut giant = STANDARD.decode(PNG).unwrap();
        giant[16..20].copy_from_slice(&100_000u32.to_be_bytes());
        for data in [
            "not base64".to_owned(),
            STANDARD.encode(giant),
            "A".repeat(MAX_IMAGE_BYTES.div_ceil(3) * 4 + 4),
        ] {
            let output = normalized(
                &directory,
                json!({"content":[{"type":"text","text":"Tool completed"},{"type":"image","mimeType":"image/png","data":data}]}),
            );
            assert_eq!(output["artifacts"], json!([]));
            assert!(output["text"].as_str().unwrap().contains("do not repeat"));
            assert!(!output.to_string().contains(&data));
        }
        let output = normalize_at(
            json!({"content":[image()]}),
            json!({"duplicate":PNG,"nested":{"dataUrl":format!("data:image/png;base64,{PNG}")}}),
            &|| Ok(directory.clone()),
        )
        .unwrap();
        assert!(!output.to_string().contains(PNG));
    }

    #[test]
    fn restored_missing_corrupt_and_forged_refs_fail_without_reading_arbitrary_files() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("artifacts");
        let output = normalized(&directory, json!({"content":[image()]}));
        let reference: ArtifactRef =
            serde_json::from_value(output["artifacts"][0].clone()).unwrap();
        let file = directory.join(format!("{}.bin", reference.id));
        fs::write(&file, vec![0u8; reference.size_bytes as usize]).unwrap();
        assert!(read_image_at(&directory, &reference).is_err());
        fs::remove_file(&file).unwrap();
        assert!(read_image_at(&directory, &reference).is_err());
        let mut forged = reference.clone();
        forged.id = "../../private-file".into();
        assert!(read_image_at(&directory, &forged).is_err());
        forged.id = reference.id.clone();
        forged.size_bytes = MAX_IMAGE_BYTES as u64 + 1;
        assert!(read_image_at(&directory, &forged).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn linked_and_shared_storage_is_rejected() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("artifacts");
        let output = normalized(&directory, json!({"content":[image()]}));
        let reference: ArtifactRef =
            serde_json::from_value(output["artifacts"][0].clone()).unwrap();
        let file = directory.join(format!("{}.bin", reference.id));
        let elsewhere = temp.path().join("elsewhere");
        fs::rename(&file, &elsewhere).unwrap();
        symlink(&elsewhere, &file).unwrap();
        assert!(read_image_at(&directory, &reference).is_err());
        fs::remove_file(&file).unwrap();
        fs::hard_link(&elsewhere, &file).unwrap();
        assert!(read_image_at(&directory, &reference).is_err());
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(read_image_at(&directory, &reference).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn windows_artifact_junctions_and_hardlinks_are_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("artifacts");
        let output = normalized(&directory, json!({"content":[image()]}));
        let reference: ArtifactRef =
            serde_json::from_value(output["artifacts"][0].clone()).unwrap();
        let file = directory.join(format!("{}.bin", reference.id));
        let alias = temp.path().join("alias");
        fs::hard_link(&file, &alias).unwrap();
        assert!(read_image_at(&directory, &reference).is_err());
        fs::remove_file(alias).unwrap();
        let link = temp.path().join("linked-store");
        let status = std::process::Command::new("cmd")
            .arg("/c")
            .arg("mklink")
            .arg("/J")
            .arg(&link)
            .arg(&directory)
            .output()
            .unwrap();
        assert!(status.status.success());
        assert!(read_image_at(&link, &reference).is_err());
        fs::remove_dir(link).unwrap();
    }
}
