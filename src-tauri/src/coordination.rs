//! Coordinación entre las sesiones de un mismo proyecto: quién está trabajando,
//! qué archivos tocó cada una, qué reservó y los avisos que se dejan entre ellas.
//!
//! Todo es orientativo: nada se bloquea en el disco y nada espera. Una reserva
//! ocupada se contesta al momento con quién la tiene, las reservas caducan solas
//! y una sesión que deja de latir (se cerró o trex se colgó) deja de contar.
//!
//! El registro es un archivo por proyecto en la carpeta de datos de la app. Lo
//! comparten la ventana (latidos, ediciones detectadas, avisos) y el servidor MCP
//! de las sesiones de Codex y Antigravity, que es otro proceso: por eso cada
//! cambio se hace con el cerrojo de la carpeta tomado.
use crate::message_queue::atomic_replace;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::fs::{self, File, OpenOptions, TryLockError};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const DIR: &str = "coordination";
const LIMIT: usize = 2 * 1024 * 1024;
/// Sin latido durante este tiempo la sesión ya no cuenta: se cerró o trex se colgó.
const STALE_MS: u64 = 90_000;
/// Un latido sin cambios solo se guarda si el anterior tiene al menos esta edad.
const BEAT_MS: u64 = 20_000;
/// Dos ediciones del mismo archivo chocan si las separa menos que esto.
const EDIT_WINDOW_MS: u64 = 30 * 60_000;
const EDIT_KEEP_MS: u64 = 2 * 60 * 60_000;
/// Una sesión que no late hace tanto se olvida (sus avisos pendientes se conservan).
const SESSION_KEEP_MS: u64 = 15 * 60_000;
const NOTE_KEEP_MS: u64 = 24 * 60 * 60_000;
const CLAIM_DEFAULT_MIN: u64 = 20;
const CLAIM_MAX_MIN: u64 = 120;
const MAX_NOTES: usize = 30;
const MAX_TEXT: usize = 2_000;
const MAX_REASON: usize = 200;
const MAX_TARGETS: usize = 32;
const MAX_SESSIONS: usize = 64;
const MAX_EDITS: usize = 2_000;

pub const TOOLS: [&str; 4] = ["trex_peers", "trex_claim", "trex_release", "trex_message"];

static SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

fn uid(prefix: &str) -> String {
    format!("{prefix}-{:x}-{:x}-{:x}", now(), std::process::id(), SEQUENCE.fetch_add(1, Ordering::Relaxed))
}

// --- Registro ---------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Board {
    #[serde(default)]
    pub project: String,
    #[serde(default)]
    pub sessions: Vec<Session>,
    #[serde(default)]
    pub edits: Vec<Edit>,
    #[serde(default)]
    pub claims: Vec<Claim>,
    #[serde(default)]
    pub notes: Vec<Note>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub label: String,
    pub agent: String,
    #[serde(default)]
    pub task: Option<String>,
    #[serde(default)]
    pub working: bool,
    pub seen: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Edit {
    pub path: String,
    pub session: String,
    pub at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Claim {
    pub id: String,
    pub session: String,
    /// `path` (archivo o carpeta, relativo al proyecto si está dentro) o `resource` (git, port:1430…).
    pub kind: String,
    pub name: String,
    #[serde(default)]
    pub reason: String,
    pub at: u64,
    pub expires: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: String,
    pub to: String,
    pub from: String,
    pub from_label: String,
    /// `conflict` (la detectó trex) o `message` (la escribió otra sesión).
    pub kind: String,
    #[serde(default)]
    pub path: Option<String>,
    pub text: String,
    pub at: u64,
}

/// Lo que la ventana sabe de una sesión viva y manda en cada latido.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Presence {
    pub id: String,
    pub label: String,
    pub agent: String,
    #[serde(default)]
    pub task: Option<String>,
    #[serde(default)]
    pub working: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    pub path: String,
    pub session: String,
    pub label: String,
    pub agent: String,
    /// La otra sesión lo tiene reservado (si no, solo lo editó hace poco).
    pub claimed: bool,
    pub reason: String,
    pub at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimView {
    pub id: String,
    pub session: String,
    pub holder: String,
    pub kind: String,
    pub name: String,
    pub reason: String,
    pub at: u64,
    pub expires: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteView {
    pub id: String,
    pub to: String,
    pub from: String,
    pub from_label: String,
    pub kind: String,
    pub path: Option<String>,
    pub text: String,
    pub at: u64,
}

/// Lo que la interfaz pinta: sesiones vivas, reservas vigentes y avisos pendientes.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardView {
    pub sessions: Vec<Session>,
    pub claims: Vec<ClaimView>,
    pub notes: Vec<NoteView>,
}

// --- Rutas y nombres ------------------------------------------------------------------

fn slashes(value: &str) -> String {
    value.trim().replace('\\', "/")
}

/// En Windows las rutas no distinguen mayúsculas.
fn fold(value: &str) -> String {
    if cfg!(windows) {
        value.to_lowercase()
    } else {
        value.to_string()
    }
}

fn has_drive(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

fn absolute(value: &str) -> bool {
    value.starts_with('/') || has_drive(value)
}

/// Quita `.`, resuelve `..` y las barras repetidas; conserva el principio de una ruta absoluta.
fn clean(path: &str) -> String {
    let prefix = if path.starts_with("//") {
        "//"
    } else if path.starts_with('/') {
        "/"
    } else {
        ""
    };
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." if parts.last().is_some_and(|last| *last != ".." && !last.ends_with(':')) => {
                parts.pop();
            }
            ".." if !prefix.is_empty() || parts.last().is_some_and(|last| last.ends_with(':')) => {}
            other => parts.push(other),
        }
    }
    let joined = parts.join("/");
    match (prefix, joined.is_empty()) {
        ("", true) => ".".into(),
        ("", false) if parts.len() == 1 && has_drive(&joined) && joined.len() == 2 => format!("{joined}/"),
        _ => format!("{prefix}{joined}"),
    }
}

/// Proyecto en una forma estable: barras normales y sin la final. None si no es absoluto.
pub fn project_root(project: &str) -> Option<String> {
    let value = clean(&slashes(project));
    absolute(&value).then_some(value)
}

/// Archivo o carpeta, relativo al proyecto si está dentro. «.» es el proyecto entero.
pub fn normalize_path(project: &str, raw: &str) -> Option<String> {
    let mut value = slashes(raw);
    if value.is_empty() || value.len() > 1024 || value.chars().any(char::is_control) {
        return None;
    }
    // `/C:/…`: una unidad de Windows escrita como ruta de Unix.
    if value.starts_with('/') && has_drive(&value[1..]) {
        value.remove(0);
    }
    if !absolute(&value) {
        return Some(clean(&value));
    }
    let value = clean(&value);
    let root = project_root(project)?;
    if fold(&value) == fold(&root) {
        return Some(".".into());
    }
    let base = if root.ends_with('/') { root.clone() } else { format!("{root}/") };
    if value.len() > base.len() && value.is_char_boundary(base.len()) && fold(&value[..base.len()]) == fold(&base) {
        return Some(clean(&value[base.len()..]));
    }
    Some(value)
}

fn normalize_resource(raw: &str) -> Option<String> {
    let value = raw.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase();
    (!value.is_empty() && value.chars().count() <= 64 && !value.chars().any(char::is_control)).then_some(value)
}

/// Un archivo choca con una carpeta que lo contiene; «.» (el proyecto) con todo lo de dentro.
fn overlaps(a: &str, b: &str) -> bool {
    let (a, b) = (fold(a), fold(b));
    a == b
        || a == "." && !absolute(&b)
        || b == "." && !absolute(&a)
        || b.starts_with(&format!("{}/", a.trim_end_matches('/')))
        || a.starts_with(&format!("{}/", b.trim_end_matches('/')))
}

fn valid_session(id: &str) -> bool {
    !id.is_empty() && id.len() <= 160 && id.bytes().all(|c| c.is_ascii_alphanumeric() || b"_-:.".contains(&c))
}

fn bounded(text: &str, limit: usize) -> String {
    let text = text.trim();
    if text.chars().count() <= limit {
        text.to_string()
    } else {
        format!("{}…", text.chars().take(limit.saturating_sub(1)).collect::<String>())
    }
}

fn ago(now: u64, at: u64) -> String {
    match now.saturating_sub(at) / 60_000 {
        0 => "hace un momento".into(),
        minutes if minutes < 120 => format!("hace {minutes} min"),
        minutes => format!("hace {} h", minutes / 60),
    }
}

fn left(now: u64, expires: u64) -> String {
    let minutes = expires.saturating_sub(now).div_ceil(60_000).max(1);
    format!("quedan {minutes} min")
}

// --- Operaciones sobre el registro (puras: el tiempo llega como argumento) ----------

fn alive(session: &Session, now: u64) -> bool {
    session.seen.saturating_add(STALE_MS) >= now
}

impl Board {
    fn session(&self, id: &str) -> Option<&Session> {
        self.sessions.iter().find(|session| session.id == id)
    }

    fn active(&self, id: &str, now: u64) -> bool {
        self.session(id).is_some_and(|session| alive(session, now))
    }

    fn label(&self, id: &str) -> String {
        self.session(id).map(|session| session.label.clone()).unwrap_or_else(|| "otra sesión de trex".into())
    }

    /// Reservas vigentes: sin caducar y de una sesión que sigue latiendo.
    fn live_claims(&self, now: u64) -> impl Iterator<Item = &Claim> {
        self.claims.iter().filter(move |claim| claim.expires > now && self.active(&claim.session, now))
    }

    fn prune(&mut self, now: u64) {
        self.sessions.retain(|session| session.seen.saturating_add(SESSION_KEEP_MS) >= now);
        // Una sesión que calla un rato (ventana minimizada, temporizadores frenados) no pierde
        // sus reservas: solo dejan de contar mientras calla. Se borran al olvidarla o al caducar.
        let known: Vec<String> = self.sessions.iter().map(|s| s.id.clone()).collect();
        self.claims.retain(|claim| claim.expires > now && known.contains(&claim.session));
        self.edits.retain(|edit| edit.at.saturating_add(EDIT_KEEP_MS) >= now);
        if self.edits.len() > MAX_EDITS {
            self.edits.drain(..self.edits.len() - MAX_EDITS);
        }
        self.notes.retain(|note| note.at.saturating_add(NOTE_KEEP_MS) >= now);
    }

    fn push_note(&mut self, note: Note) {
        // Un aviso igual sin leer ya basta: no se repite por cada edición.
        if note.kind == "conflict"
            && self.notes.iter().any(|old| old.to == note.to && old.from == note.from && old.kind == "conflict" && old.path == note.path)
        {
            return;
        }
        let mine = self.notes.iter().filter(|old| old.to == note.to).count();
        if mine >= MAX_NOTES {
            if let Some(index) = self.notes.iter().position(|old| old.to == note.to) {
                self.notes.remove(index);
            }
        }
        self.notes.push(note);
    }
}

/// Latido de las sesiones vivas de la ventana. Devuelve si el registro cambió.
fn sync_board(board: &mut Board, sessions: &[Presence], now: u64) -> bool {
    let mut changed = false;
    for presence in sessions {
        if !valid_session(&presence.id) {
            continue;
        }
        let next = Session {
            id: presence.id.clone(),
            label: unique_label(board, &presence.id, &bounded(&presence.label, 80), now),
            agent: bounded(&presence.agent, 24),
            task: presence.task.as_deref().map(|task| bounded(task, 200)).filter(|task| !task.is_empty()),
            working: presence.working,
            seen: now,
        };
        let full = board.sessions.len() >= MAX_SESSIONS;
        match board.sessions.iter_mut().find(|session| session.id == presence.id) {
            Some(session) => {
                let same = Session { seen: session.seen, ..next.clone() } == *session;
                if !same || session.seen.saturating_add(BEAT_MS) <= now {
                    *session = next;
                    changed = true;
                }
            }
            None if !full => {
                board.sessions.push(next);
                changed = true;
            }
            None => {}
        }
    }
    changed
}

/// El nombre con el que otras sesiones la ven y le escriben: si otra sesión viva ya
/// lo usa, se numera («Codex (2)»). Estable: la primera conserva el nombre limpio.
fn unique_label(board: &Board, id: &str, label: &str, now: u64) -> String {
    let taken = |candidate: &str| {
        board.sessions.iter().any(|other| other.id != id && alive(other, now) && other.label.to_lowercase() == candidate.to_lowercase())
    };
    if !taken(label) {
        return label.to_string();
    }
    (2..=MAX_SESSIONS + 1).map(|n| format!("{label} ({n})")).find(|candidate| !taken(candidate)).unwrap_or_else(|| format!("{label} ({id})"))
}

fn leave_board(board: &mut Board, session: &str) {
    board.sessions.retain(|entry| entry.id != session);
    board.claims.retain(|claim| claim.session != session);
}

/// Anota las ediciones de una sesión y avisa a las dos partes de cada choque.
fn record_board(board: &mut Board, project: &str, session: &str, paths: &[String], now: u64) -> Vec<Conflict> {
    let me = board.label(session);
    let mut conflicts = Vec::new();
    for raw in paths.iter().take(MAX_TARGETS) {
        let Some(path) = normalize_path(project, raw) else { continue };
        let claim = board
            .live_claims(now)
            .find(|claim| claim.session != session && claim.kind == "path" && overlaps(&claim.name, &path))
            .cloned();
        let edit = board
            .edits
            .iter()
            .rev()
            .find(|edit| {
                edit.session != session
                    && fold(&edit.path) == fold(&path)
                    && edit.at.saturating_add(EDIT_WINDOW_MS) >= now
                    && board.active(&edit.session, now)
            })
            .cloned();
        let other = claim.as_ref().map(|claim| (claim.session.clone(), claim.at)).or_else(|| edit.as_ref().map(|edit| (edit.session.clone(), edit.at)));
        if let Some((other, at)) = other {
            let label = board.label(&other);
            let agent = board.session(&other).map(|s| s.agent.clone()).unwrap_or_default();
            let reason = claim.as_ref().map(|claim| claim.reason.clone()).unwrap_or_default();
            let why = if reason.is_empty() { String::new() } else { format!(" ({reason})") };
            let (to_other, to_me) = if claim.is_some() {
                (
                    format!("«{me}» editó {path}, que tienes reservado{why}. Revisa su cambio antes de seguir y, si os vais a pisar, poneos de acuerdo con trex_message."),
                    format!("Editaste {path}, que «{label}» tiene reservado{why}. Comprueba que no has deshecho su trabajo y poneos de acuerdo con trex_message."),
                )
            } else {
                (
                    format!("«{me}» editó {path}, que tú también cambiaste hace poco. Vuelve a leerlo antes de seguir editándolo y, si os vais a pisar, poneos de acuerdo con trex_message."),
                    format!("Editaste {path}, que «{label}» cambió {}. Comprueba que no has deshecho su trabajo y poneos de acuerdo con trex_message si hace falta.", ago(now, at)),
                )
            };
            board.push_note(Note { id: uid("n"), to: other.clone(), from: session.into(), from_label: me.clone(), kind: "conflict".into(), path: Some(path.clone()), text: to_other, at: now });
            board.push_note(Note { id: uid("n"), to: session.into(), from: other.clone(), from_label: label.clone(), kind: "conflict".into(), path: Some(path.clone()), text: to_me, at: now });
            conflicts.push(Conflict { path: path.clone(), session: other, label, agent, claimed: claim.is_some(), reason, at });
        }
        board.edits.retain(|edit| !(edit.session == session && fold(&edit.path) == fold(&path)));
        board.edits.push(Edit { path, session: session.into(), at: now });
    }
    conflicts
}

fn note_view(note: &Note, now: u64) -> NoteView {
    let lead = match note.kind.as_str() {
        "message" => format!("{} · mensaje de «{}»: ", capitalized(&ago(now, note.at)), note.from_label),
        _ => format!("{} · ", capitalized(&ago(now, note.at))),
    };
    NoteView {
        id: note.id.clone(),
        to: note.to.clone(),
        from: note.from.clone(),
        from_label: note.from_label.clone(),
        kind: note.kind.clone(),
        path: note.path.clone(),
        text: format!("{lead}{}", note.text),
        at: note.at,
    }
}

fn capitalized(text: &str) -> String {
    let mut chars = text.chars();
    chars.next().map(|first| first.to_uppercase().chain(chars).collect()).unwrap_or_default()
}

fn view_board(board: &Board, now: u64) -> BoardView {
    BoardView {
        sessions: board.sessions.iter().filter(|session| alive(session, now)).cloned().collect(),
        claims: board
            .live_claims(now)
            .map(|claim| ClaimView {
                id: claim.id.clone(),
                session: claim.session.clone(),
                holder: board.label(&claim.session),
                kind: claim.kind.clone(),
                name: claim.name.clone(),
                reason: claim.reason.clone(),
                at: claim.at,
                expires: claim.expires,
            })
            .collect(),
        notes: board.notes.iter().map(|note| note_view(note, now)).collect(),
    }
}

fn take_notes(board: &mut Board, session: &str, now: u64) -> Vec<NoteView> {
    let (mine, rest): (Vec<Note>, Vec<Note>) = std::mem::take(&mut board.notes).into_iter().partition(|note| note.to == session);
    board.notes = rest;
    mine.iter().map(|note| note_view(note, now)).collect()
}

fn ack_notes(board: &mut Board, session: &str, ids: &[String]) -> bool {
    let before = board.notes.len();
    board.notes.retain(|note| !(note.to == session && ids.contains(&note.id)));
    before != board.notes.len()
}

fn force_release(board: &mut Board, claim: &str) -> bool {
    let before = board.claims.len();
    board.claims.retain(|entry| entry.id != claim);
    before != board.claims.len()
}

// --- Herramientas de los agentes ------------------------------------------------------

pub fn tools() -> Vec<Value> {
    let strings = |description: &str| json!({"type":"array","maxItems":MAX_TARGETS,"items":{"type":"string","minLength":1,"maxLength":1024},"description":description});
    let annotations = |read_only: bool| json!({"readOnlyHint":read_only,"destructiveHint":false,"idempotentHint":read_only,"openWorldHint":false});
    vec![
        json!({"name":"trex_peers",
            "description":"Other Trex sessions working in this project right now: what each one is doing, the files it edited recently and what it reserved, plus the notes left for you (each delivered once). Call it before editing files another session may touch and when Trex tells you about another session; never call it in a loop. No arguments.",
            "inputSchema":{"type":"object","properties":{},"additionalProperties":false},
            "annotations":annotations(false)}),
        json!({"name":"trex_claim",
            "description":"Reserve files, folders or shared resources (git, port:1430, cargo, a database...) so other Trex sessions see you are changing them. Advisory and non-blocking: it answers at once with what was reserved and, for anything another session holds, who holds it and why; then do other work or agree with trex_message, never wait or retry in a loop. Reservations expire after minutes (default 20, max 120); claim again to renew. Paths are relative to the project or absolute; a folder covers everything inside it.",
            "inputSchema":{"type":"object","properties":{
                "paths":strings("Files or folders you are about to change."),
                "resources":strings("Shared resources such as git, port:1430 or cargo."),
                "reason":{"type":"string","maxLength":MAX_REASON,"description":"What you are doing, shown to the other sessions."},
                "minutes":{"type":"integer","minimum":1,"maximum":CLAIM_MAX_MIN}},"additionalProperties":false},
            "annotations":annotations(false)}),
        json!({"name":"trex_release",
            "description":"Release your reservations as soon as you finish with them. Without arguments it releases all of yours.",
            "inputSchema":{"type":"object","properties":{"paths":strings("Files or folders to release."),"resources":strings("Resources to release.")},"additionalProperties":false},
            "annotations":annotations(false)}),
        json!({"name":"trex_message",
            "description":"Talk with another Trex session in this project to agree on shared files, resources or decisions: to is the name trex_peers or its note shows, or all. Trex wakes an idle session to read and answer it; a busy one gets it when its turn ends. Never wait or poll for the reply: finish or end your turn and Trex wakes you when it arrives. Keep it short and only write when it matters: a few automatic exchanges in a row pause until the user steps in.",
            "inputSchema":{"type":"object","properties":{
                "to":{"type":"string","minLength":1,"maxLength":120},
                "text":{"type":"string","minLength":1,"maxLength":MAX_TEXT}},"required":["to","text"],"additionalProperties":false},
            "annotations":annotations(false)}),
    ]
}

fn arguments<'a>(args: &'a Value, allowed: &[&str]) -> Result<&'a Map<String, Value>, String> {
    let object = match args {
        Value::Null => return Err(String::new()),
        Value::Object(object) => object,
        _ => return Err("Los argumentos deben ser un objeto.".into()),
    };
    if let Some(key) = object.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(format!("Argumento desconocido: {key}."));
    }
    Ok(object)
}

fn string_list(object: &Map<String, Value>, key: &str) -> Result<Vec<String>, String> {
    match object.get(key) {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(items)) if items.len() <= MAX_TARGETS => items
            .iter()
            .map(|item| item.as_str().map(str::to_string).ok_or_else(|| format!("{key} debe ser una lista de textos.")))
            .collect(),
        Some(_) => Err(format!("{key} debe ser una lista de hasta {MAX_TARGETS} textos.")),
    }
}

fn peers_text(board: &mut Board, session: &str, now: u64) -> String {
    let mut lines = Vec::new();
    let others: Vec<Session> = board.sessions.iter().filter(|s| s.id != session && alive(s, now)).cloned().collect();
    if others.is_empty() {
        lines.push("No hay otras sesiones de trex activas en este proyecto.".to_string());
    } else {
        lines.push("Otras sesiones de trex en este proyecto:".to_string());
        for other in &others {
            let state = if other.working { "trabajando" } else { "en espera" };
            let task = other.task.as_deref().map(|task| format!(": {task}")).unwrap_or_default();
            lines.push(format!("- «{}» ({}, {state}){task}", other.label, other.agent));
            let mut edits: Vec<&Edit> = board
                .edits
                .iter()
                .filter(|edit| edit.session == other.id && edit.at.saturating_add(EDIT_WINDOW_MS) >= now)
                .collect();
            edits.sort_by(|a, b| b.at.cmp(&a.at));
            if !edits.is_empty() {
                let list: Vec<String> = edits.iter().take(12).map(|edit| format!("{} ({})", edit.path, ago(now, edit.at))).collect();
                lines.push(format!("  Editó hace poco: {}", list.join(", ")));
            }
            let claims: Vec<String> = board.live_claims(now).filter(|claim| claim.session == other.id).map(|claim| claim_text(claim, now)).collect();
            if !claims.is_empty() {
                lines.push(format!("  Reservado: {}", claims.join(", ")));
            }
        }
    }
    let mine: Vec<String> = board.live_claims(now).filter(|claim| claim.session == session).map(|claim| claim_text(claim, now)).collect();
    if !mine.is_empty() {
        lines.push(format!("Tus reservas: {}", mine.join(", ")));
    }
    let notes = take_notes(board, session, now);
    if !notes.is_empty() {
        lines.push("Avisos para ti:".into());
        lines.extend(notes.iter().map(|note| format!("- {}", note.text)));
    }
    lines.join("\n")
}

fn claim_text(claim: &Claim, now: u64) -> String {
    let what = if claim.kind == "resource" { format!("recurso {}", claim.name) } else { claim.name.clone() };
    let why = if claim.reason.is_empty() { String::new() } else { format!(", «{}»", claim.reason) };
    format!("{what} ({}{why})", left(now, claim.expires))
}

fn targets(project: &str, object: &Map<String, Value>) -> Result<Vec<(String, String)>, String> {
    let mut list = Vec::new();
    for raw in string_list(object, "paths")? {
        let path = normalize_path(project, &raw).ok_or_else(|| format!("Ruta no válida: {raw}"))?;
        list.push(("path".to_string(), path));
    }
    for raw in string_list(object, "resources")? {
        let resource = normalize_resource(&raw).ok_or_else(|| format!("Recurso no válido: {raw}"))?;
        list.push(("resource".to_string(), resource));
    }
    list.dedup();
    if list.len() > MAX_TARGETS {
        return Err(format!("Como mucho {MAX_TARGETS} rutas y recursos a la vez."));
    }
    Ok(list)
}

fn claim_tool(board: &mut Board, project: &str, session: &str, args: &Value, now: u64) -> Result<String, String> {
    let object = arguments(args, &["paths", "resources", "reason", "minutes"]).map_err(|e| if e.is_empty() { "Indica paths o resources.".into() } else { e })?;
    let list = targets(project, object)?;
    if list.is_empty() {
        return Err("Indica al menos una ruta (paths) o un recurso (resources).".into());
    }
    let reason = match object.get("reason") {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(reason)) => bounded(reason, MAX_REASON),
        Some(_) => return Err("reason debe ser un texto.".into()),
    };
    let minutes = match object.get("minutes") {
        None | Some(Value::Null) => CLAIM_DEFAULT_MIN,
        Some(value) => value.as_u64().filter(|m| (1..=CLAIM_MAX_MIN).contains(m)).ok_or(format!("minutes debe ser un entero entre 1 y {CLAIM_MAX_MIN}."))?,
    };
    let expires = now + minutes * 60_000;
    let (mut granted, mut busy, mut warnings) = (Vec::new(), Vec::new(), Vec::new());
    for (kind, name) in list {
        let same_kind = |claim: &Claim| claim.kind == kind && if kind == "path" { overlaps(&claim.name, &name) } else { claim.name == name };
        if let Some(holder) = board.live_claims(now).find(|claim| claim.session != session && same_kind(claim)).cloned() {
            let why = if holder.reason.is_empty() { String::new() } else { format!(" («{}»)", holder.reason) };
            busy.push(format!("{name} → lo tiene «{}» desde {}{why}", board.label(&holder.session), ago(now, holder.at)));
            continue;
        }
        if kind == "path" {
            for edit in board.edits.iter().filter(|edit| edit.session != session && overlaps(&name, &edit.path) && edit.at.saturating_add(EDIT_WINDOW_MS) >= now && board.active(&edit.session, now)) {
                warnings.push(format!("«{}» editó {} {}", board.label(&edit.session), edit.path, ago(now, edit.at)));
            }
        }
        match board.claims.iter_mut().find(|claim| claim.session == session && claim.kind == kind && fold(&claim.name) == fold(&name)) {
            Some(claim) => {
                claim.expires = expires;
                if !reason.is_empty() {
                    claim.reason = reason.clone();
                }
            }
            None => board.claims.push(Claim { id: uid("c"), session: session.into(), kind: kind.clone(), name: name.clone(), reason: reason.clone(), at: now, expires }),
        }
        granted.push(if kind == "resource" { format!("recurso {name}") } else { name });
    }
    let mut lines = Vec::new();
    if !granted.is_empty() {
        lines.push(format!("Reservado durante {minutes} min: {}.", granted.join(", ")));
    }
    if !busy.is_empty() {
        lines.push("Ocupado, no se reservó (haz otra cosa o ponte de acuerdo con trex_message; no esperes):".into());
        lines.extend(busy.iter().map(|line| format!("- {line}")));
    }
    if !warnings.is_empty() {
        lines.push("Ojo, otras sesiones tocaron esto hace poco:".into());
        lines.extend(warnings.iter().map(|line| format!("- {line}")));
    }
    Ok(lines.join("\n"))
}

fn release_tool(board: &mut Board, project: &str, session: &str, args: &Value) -> Result<String, String> {
    let list = match arguments(args, &["paths", "resources"]) {
        Err(error) if error.is_empty() => Vec::new(),
        Err(error) => return Err(error),
        Ok(object) => targets(project, object)?,
    };
    let before = board.claims.len();
    if list.is_empty() {
        board.claims.retain(|claim| claim.session != session);
    } else {
        board.claims.retain(|claim| claim.session != session || !list.iter().any(|(kind, name)| *kind == claim.kind && fold(name) == fold(&claim.name)));
    }
    let released = before - board.claims.len();
    Ok(match released {
        0 => "No tenías reservas que coincidan.".into(),
        1 => "Liberada 1 reserva.".into(),
        count => format!("Liberadas {count} reservas."),
    })
}

fn message_tool(board: &mut Board, session: &str, args: &Value, now: u64) -> Result<String, String> {
    let object = arguments(args, &["to", "text"]).map_err(|e| if e.is_empty() { "Indica to y text.".into() } else { e })?;
    let to = object.get("to").and_then(Value::as_str).map(str::trim).filter(|to| !to.is_empty()).ok_or("Indica a quién (to).")?;
    let text = object.get("text").and_then(Value::as_str).map(str::trim).filter(|text| !text.is_empty()).ok_or("Escribe el mensaje (text).")?;
    if text.chars().count() > MAX_TEXT {
        return Err(format!("El mensaje supera {MAX_TEXT} caracteres."));
    }
    let others: Vec<Session> = board.sessions.iter().filter(|s| s.id != session && alive(s, now)).cloned().collect();
    let names = || others.iter().map(|s| format!("«{}»", s.label)).collect::<Vec<_>>().join(", ");
    let wanted = to.trim_matches(['«', '»', '"', '\'']).to_lowercase();
    let recipients: Vec<Session> = if ["all", "todos", "todas", "*"].contains(&wanted.as_str()) {
        others.clone()
    } else if let Some(exact) = others.iter().find(|s| s.id == to || s.label.to_lowercase() == wanted) {
        vec![exact.clone()]
    } else {
        let partial: Vec<Session> = others.iter().filter(|s| s.label.to_lowercase().contains(&wanted)).cloned().collect();
        if partial.len() > 1 {
            return Err(format!("Hay varias sesiones que encajan con «{to}»: {}. Usa el nombre completo.", partial.iter().map(|s| format!("«{}»", s.label)).collect::<Vec<_>>().join(", ")));
        }
        partial
    };
    if recipients.is_empty() {
        return Err(if others.is_empty() {
            "No hay otras sesiones de trex activas en este proyecto.".into()
        } else {
            format!("No hay ninguna sesión activa llamada «{to}». Sesiones: {}.", names())
        });
    }
    let me = board.label(session);
    for recipient in &recipients {
        board.push_note(Note { id: uid("n"), to: recipient.id.clone(), from: session.into(), from_label: me.clone(), kind: "message".into(), path: None, text: text.to_string(), at: now });
    }
    let list = recipients.iter().map(|s| format!("«{}»", s.label)).collect::<Vec<_>>().join(", ");
    Ok(format!("Mensaje enviado a {list}. Si está en espera, trex la despierta para que lo lea; si está trabajando, lo verá al terminar su turno. No esperes la respuesta: termina tu turno y trex te despertará cuando llegue."))
}

fn call_board(board: &mut Board, project: &str, session: &str, name: &str, args: &Value, now: u64) -> Result<String, String> {
    // Quien llama a una herramienta está vivo aunque la ventana aún no haya latido por él;
    // sin registrarlo, sus reservas se borrarían en la siguiente limpieza.
    let full = board.sessions.len() >= MAX_SESSIONS;
    match board.sessions.iter_mut().find(|entry| entry.id == session) {
        Some(me) => me.seen = me.seen.max(now),
        None if !full => board.sessions.push(Session {
            id: session.into(),
            label: format!("sesión {}", bounded(session, 24)),
            agent: String::new(),
            task: None,
            working: true,
            seen: now,
        }),
        None => return Err("Hay demasiadas sesiones registradas en este proyecto.".into()),
    }
    match name {
        "trex_peers" => match arguments(args, &[]) {
            Ok(_) => Ok(peers_text(board, session, now)),
            Err(error) if error.is_empty() => Ok(peers_text(board, session, now)),
            Err(error) => Err(error),
        },
        "trex_claim" => claim_tool(board, project, session, args, now),
        "trex_release" => release_tool(board, project, session, args),
        "trex_message" => message_tool(board, session, args, now),
        _ => Err("Herramienta de coordinación desconocida.".into()),
    }
}

// --- Almacenamiento ---------------------------------------------------------------------

fn fnv(text: &str) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in text.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    hash
}

fn regular(path: &Path) -> Result<(), String> {
    let meta = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return Err("El registro de coordinación no admite enlaces.".into());
        }
    }
    if meta.file_type().is_symlink() {
        return Err("El registro de coordinación no admite enlaces.".into());
    }
    Ok(())
}

fn directory(root: &Path) -> Result<PathBuf, String> {
    if !root.is_absolute() {
        return Err("La carpeta de datos debe ser absoluta.".into());
    }
    let dir = root.join(DIR);
    fs::create_dir_all(&dir).map_err(|e| format!("No se pudo crear el registro de coordinación: {e}"))?;
    regular(&dir)?;
    Ok(dir)
}

fn lock(dir: &Path) -> Result<File, String> {
    let path = dir.join(".lock");
    if path.exists() {
        regular(&path)?;
    }
    let file = OpenOptions::new().read(true).write(true).create(true).truncate(false).open(path).map_err(|e| e.to_string())?;
    let start = Instant::now();
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(file),
            Err(TryLockError::WouldBlock) if start.elapsed() < Duration::from_secs(3) => std::thread::sleep(Duration::from_millis(10)),
            _ => return Err("El registro de coordinación está ocupado.".into()),
        }
    }
}

fn load(path: &Path, root: &str) -> Result<Board, String> {
    if !path.exists() {
        return Ok(Board { project: fold(root), ..Board::default() });
    }
    regular(path)?;
    let mut bytes = Vec::new();
    File::open(path).map_err(|e| e.to_string())?.take((LIMIT + 1) as u64).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    // Un registro dañado o ajeno no debe dejar a las sesiones sin coordinarse: se empieza de nuevo.
    match serde_json::from_slice::<Board>(&bytes) {
        Ok(board) if bytes.len() <= LIMIT && board.project == fold(root) => Ok(board),
        _ => Ok(Board { project: fold(root), ..Board::default() }),
    }
}

fn save(path: &Path, board: &Board) -> Result<(), String> {
    let bytes = serde_json::to_vec(board).map_err(|e| e.to_string())?;
    if bytes.len() > LIMIT {
        return Err("El registro de coordinación supera su límite.".into());
    }
    let temporary = path.with_file_name(format!(".{}.tmp", uid("t")));
    let written = (|| -> std::io::Result<()> {
        let mut file = OpenOptions::new().write(true).create_new(true).open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        atomic_replace(&temporary, path)
    })();
    if written.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    written.map_err(|e| format!("No se pudo guardar el registro de coordinación: {e}"))
}

/// Lee el registro del proyecto con el cerrojo tomado, aplica `change` y guarda si hizo falta.
fn with_board<T>(root: &Path, project: &str, change: impl FnOnce(&mut Board, &str, u64) -> (T, bool)) -> Result<T, String> {
    let project = project_root(project).ok_or("La carpeta del proyecto debe ser una ruta absoluta.")?;
    let dir = directory(root)?;
    let _lock = lock(&dir)?;
    let path = dir.join(format!("{:016x}.json", fnv(&fold(&project))));
    let mut board = load(&path, &project)?;
    let now = now();
    let before = (board.sessions.len(), board.edits.len(), board.claims.len(), board.notes.len());
    board.prune(now);
    let (value, changed) = change(&mut board, &project, now);
    let pruned = before != (board.sessions.len(), board.edits.len(), board.claims.len(), board.notes.len());
    if changed || pruned {
        save(&path, &board)?;
    }
    Ok(value)
}

// --- API para el servidor MCP (otro proceso) y para la ventana ---------------------------

/// Resultado MCP de una herramienta de coordinación llamada por `session`.
pub fn call(root: &Path, project: &str, session: &str, name: &str, args: &Value) -> Value {
    if !valid_session(session) {
        return tool_result(Err("Sesión no válida.".into()));
    }
    let result = with_board(root, project, |board, project, now| {
        let result = call_board(board, project, session, name, args, now);
        let changed = result.is_ok();
        (result, changed)
    })
    .and_then(|result| result);
    tool_result(result)
}

fn tool_result(result: Result<String, String>) -> Value {
    match result {
        Ok(text) => json!({"content":[{"type":"text","text":text}],"isError":false}),
        Err(text) => json!({"content":[{"type":"text","text":text}],"isError":true}),
    }
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|error| format!("No se encontró la carpeta de datos de la app: {error}"))
}

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|error| error.to_string())?
}

/// Latido de las sesiones vivas de la ventana en un proyecto; devuelve el registro para pintarlo.
#[tauri::command]
pub async fn coordination_sync(app: AppHandle, project: String, sessions: Vec<Presence>) -> Result<BoardView, String> {
    let root = data_dir(&app)?;
    blocking(move || with_board(&root, &project, |board, _, now| {
        let changed = sync_board(board, &sessions, now);
        (view_board(board, now), changed)
    }))
    .await
}

/// La sesión se cerró: deja de contar y suelta sus reservas.
#[tauri::command]
pub async fn coordination_leave(app: AppHandle, project: String, session: String) -> Result<(), String> {
    let root = data_dir(&app)?;
    blocking(move || with_board(&root, &project, |board, _, _| {
        leave_board(board, &session);
        ((), true)
    }))
    .await
}

/// Ediciones que la ventana vio hacer a una sesión; devuelve con quién chocan.
#[tauri::command]
pub async fn coordination_record_edits(app: AppHandle, project: String, session: String, paths: Vec<String>) -> Result<Vec<Conflict>, String> {
    if !valid_session(&session) {
        return Err("Sesión no válida.".into());
    }
    let root = data_dir(&app)?;
    blocking(move || with_board(&root, &project, |board, project, now| (record_board(board, project, &session, &paths, now), !paths.is_empty()))).await
}

/// Avisos ya entregados a la sesión (con su siguiente mensaje): se borran.
#[tauri::command]
pub async fn coordination_ack_notes(app: AppHandle, project: String, session: String, ids: Vec<String>) -> Result<(), String> {
    let root = data_dir(&app)?;
    blocking(move || with_board(&root, &project, |board, _, _| ((), ack_notes(board, &session, &ids)))).await
}

/// La persona libera una reserva desde la interfaz.
#[tauri::command]
pub async fn coordination_release(app: AppHandle, project: String, claim: String) -> Result<(), String> {
    let root = data_dir(&app)?;
    blocking(move || with_board(&root, &project, |board, _, _| ((), force_release(board, &claim)))).await
}

/// Herramientas de una sesión de Claude en su proyecto: coordinación y memoria de Trex.
#[tauri::command]
pub fn coordination_tools() -> Vec<Value> {
    let mut list = tools();
    list.extend(crate::memory::tools());
    list
}

/// Herramientas de las sesiones de Claude (su servidor MCP lo sirve la ventana): las de memoria
/// van a `memory.rs`, con Claude y la sesión como procedencia.
#[tauri::command]
pub async fn coordination_call(app: AppHandle, project: String, session: String, name: String, arguments: Value) -> Result<Value, String> {
    let root = data_dir(&app)?;
    if crate::memory::TOOLS.contains(&name.as_str()) {
        return blocking(move || Ok(crate::memory::call(&root, Some(&project), &format!("claude · sesión {session}"), &name, &arguments))).await;
    }
    blocking(move || Ok(call(&root, &project, &session, &name, &arguments))).await
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROOT: &str = if cfg!(windows) { "D:/proyecto" } else { "/home/ana/proyecto" };

    fn presence(id: &str, label: &str) -> Presence {
        Presence { id: id.into(), label: label.into(), agent: "codex".into(), task: None, working: true }
    }

    fn board(now: u64) -> Board {
        let mut board = Board::default();
        sync_board(&mut board, &[presence("a", "Claude · Iconos"), presence("b", "Codex · Login")], now);
        board
    }

    fn text(result: Result<String, String>) -> String {
        result.unwrap_or_else(|error| panic!("{error}"))
    }

    #[test]
    fn paths_are_relative_to_the_project_and_tolerate_agent_spellings() {
        let inside = format!("{ROOT}/src/app.ts");
        assert_eq!(normalize_path(ROOT, &inside).unwrap(), "src/app.ts");
        assert_eq!(normalize_path(ROOT, "./src//b/../app.ts").unwrap(), "src/app.ts");
        assert_eq!(normalize_path(ROOT, "src\\styles.css").unwrap(), "src/styles.css");
        assert_eq!(normalize_path(ROOT, ROOT).unwrap(), ".");
        assert_eq!(normalize_path(ROOT, "").as_deref(), None);
        if cfg!(windows) {
            assert_eq!(normalize_path(ROOT, "/d:/Proyecto/src/a.ts").unwrap(), "src/a.ts");
            assert_eq!(normalize_path(ROOT, "C:\\Users\\ana\\a.png").unwrap(), "C:/Users/ana/a.png");
            assert_eq!(normalize_path("D:\\", "D:\\x\\a.ts").unwrap(), "x/a.ts");
        }
        assert!(overlaps("src", "src/app.ts") && overlaps("src/app.ts", "src") && overlaps(".", "src/a.ts"));
        assert!(!overlaps("src/app", "src/application.ts") && !overlaps(".", "/tmp/a"));
    }

    #[test]
    fn editing_what_another_live_session_changed_warns_both_once() {
        let mut board = board(1_000);
        assert!(record_board(&mut board, ROOT, "a", &["src/app.ts".into()], 1_000).is_empty());
        let conflicts = record_board(&mut board, ROOT, "b", &[format!("{ROOT}/src/app.ts")], 61_000);
        assert_eq!(conflicts.len(), 1);
        assert_eq!((conflicts[0].session.as_str(), conflicts[0].claimed), ("a", false));
        // Otra edición igual no repite el aviso mientras siga sin leerse.
        record_board(&mut board, ROOT, "b", &["src/app.ts".into()], 62_000);
        let for_a: Vec<&Note> = board.notes.iter().filter(|note| note.to == "a").collect();
        let for_b: Vec<&Note> = board.notes.iter().filter(|note| note.to == "b").collect();
        assert_eq!((for_a.len(), for_b.len()), (1, 1));
        assert!(for_a[0].text.contains("«Codex · Login» editó src/app.ts"));
        assert!(for_b[0].text.contains("«Claude · Iconos» cambió hace 1 min"));
    }

    #[test]
    fn closed_or_silent_sessions_never_cause_conflicts_or_hold_claims() {
        let mut board = board(0);
        record_board(&mut board, ROOT, "a", &["src/a.ts".into()], 0);
        text(claim_tool(&mut board, ROOT, "a", &json!({"paths":["src"]}), 0));
        // «a» deja de latir; «b» sigue viva.
        sync_board(&mut board, &[presence("b", "Codex · Login")], STALE_MS + 1);
        assert!(record_board(&mut board, ROOT, "b", &["src/a.ts".into()], STALE_MS + 1).is_empty());
        let reply = text(claim_tool(&mut board, ROOT, "b", &json!({"paths":["src/a.ts"]}), STALE_MS + 1));
        assert!(reply.starts_with("Reservado"), "{reply}");
    }

    #[test]
    fn claims_never_wait_cover_folders_expire_and_renew() {
        let mut board = board(0);
        let reply = text(claim_tool(&mut board, ROOT, "a", &json!({"paths":["src/auth"],"resources":["Git"],"reason":"refactor auth","minutes":5}), 0));
        assert!(reply.contains("src/auth") && reply.contains("recurso git"), "{reply}");
        let busy = text(claim_tool(&mut board, ROOT, "b", &json!({"paths":["src/auth/login.ts","src/ui.ts"],"resources":["git"]}), 1_000));
        assert!(busy.contains("Reservado durante 20 min: src/ui.ts."), "{busy}");
        assert!(busy.contains("src/auth/login.ts → lo tiene «Claude · Iconos»") && busy.contains("«refactor auth»") && busy.contains("git → lo tiene"), "{busy}");
        // Editar lo reservado avisa como reserva, no como edición.
        let conflicts = record_board(&mut board, ROOT, "b", &["src/auth/login.ts".into()], 2_000);
        assert!(conflicts[0].claimed && conflicts[0].reason == "refactor auth");
        // Renovar no duplica; al caducar queda libre (las dos siguen latiendo).
        text(claim_tool(&mut board, ROOT, "a", &json!({"resources":["git"]}), 3_000));
        assert_eq!(board.claims.iter().filter(|c| c.session == "a").count(), 2);
        let later = 3_000 + 21 * 60_000;
        sync_board(&mut board, &[presence("a", "Claude · Iconos"), presence("b", "Codex · Login")], later);
        let free = text(claim_tool(&mut board, ROOT, "b", &json!({"paths":["src/auth"]}), later));
        assert!(free.starts_with("Reservado"), "{free}");
        assert!(claim_tool(&mut board, ROOT, "b", &json!({}), later).is_err());
        assert!(claim_tool(&mut board, ROOT, "b", &json!({"paths":["x"],"minutes":500}), later).is_err());
    }

    #[test]
    fn release_drops_some_or_all_of_your_own_claims_only() {
        let mut board = board(0);
        text(claim_tool(&mut board, ROOT, "a", &json!({"paths":["a.ts","b.ts"],"resources":["git"]}), 0));
        text(claim_tool(&mut board, ROOT, "b", &json!({"paths":["c.ts"]}), 0));
        assert_eq!(text(release_tool(&mut board, ROOT, "a", &json!({"paths":["a.ts"]}))), "Liberada 1 reserva.");
        assert_eq!(text(release_tool(&mut board, ROOT, "a", &json!({}))), "Liberadas 2 reservas.");
        assert_eq!(text(release_tool(&mut board, ROOT, "a", &Value::Null)), "No tenías reservas que coincidan.");
        assert_eq!(board.claims.len(), 1);
    }

    #[test]
    fn messages_reach_peers_by_name_once_through_trex_peers() {
        let mut board = board(0);
        sync_board(&mut board, &[presence("c", "Codex · Docs")], 0);
        let sent = text(message_tool(&mut board, "a", &json!({"to":"codex · login","text":"No toques auth hasta que acabe."}), 0));
        assert!(sent.contains("«Codex · Login»"), "{sent}");
        assert!(message_tool(&mut board, "a", &json!({"to":"codex","text":"x"}), 0).unwrap_err().contains("varias sesiones"));
        assert!(message_tool(&mut board, "a", &json!({"to":"nadie","text":"x"}), 0).unwrap_err().contains("Sesiones:"));
        text(message_tool(&mut board, "a", &json!({"to":"all","text":"Voy a hacer commit."}), 0));
        let peers = peers_text(&mut board, "b", 60_000);
        assert!(peers.contains("«Claude · Iconos» (codex, trabajando)"), "{peers}");
        assert!(peers.contains("Hace 1 min · mensaje de «Claude · Iconos»: No toques auth"), "{peers}");
        assert!(peers.contains("Voy a hacer commit."), "{peers}");
        assert!(!peers_text(&mut board, "b", 60_000).contains("Avisos para ti"), "notes are delivered once");
    }

    #[test]
    fn sessions_with_the_same_name_are_numbered_so_replies_reach_the_right_one() {
        let mut board = board(0);
        sync_board(&mut board, &[presence("c", "Codex · Login"), presence("d", "codex · login")], 0);
        let labels: Vec<_> = board.sessions.iter().map(|s| s.label.clone()).collect();
        assert_eq!(labels, ["Claude · Iconos", "Codex · Login", "Codex · Login (2)", "codex · login (3)"]);
        assert!(!sync_board(&mut board, &[presence("c", "Codex · Login"), presence("b", "Codex · Login")], 5_000), "names stay stable");
        // A reply goes back by the name shown in the note, even with look-alikes around.
        text(message_tool(&mut board, "c", &json!({"to":"Claude · Iconos","text":"¿Puedo tocar src/auth?"}), 0));
        let note = take_notes(&mut board, "a", 0).remove(0);
        assert!(note.text.contains("mensaje de «Codex · Login (2)»"), "{}", note.text);
        let sent = text(message_tool(&mut board, "a", &json!({"to":note.from_label,"text":"Sí, ya terminé."}), 0));
        assert!(sent.contains("trex la despierta"), "{sent}");
        assert_eq!(take_notes(&mut board, "c", 0).len(), 1);
        assert!(take_notes(&mut board, "b", 0).is_empty() && take_notes(&mut board, "d", 0).is_empty());
        leave_board(&mut board, "b");
        sync_board(&mut board, &[presence("e", "Codex · Login")], 0);
        assert_eq!(board.sessions.last().unwrap().label, "Codex · Login", "a freed name is reused");
    }

    #[test]
    fn heartbeats_only_write_when_something_changed_or_aged() {
        let mut board = board(0);
        assert!(!sync_board(&mut board, &[presence("a", "Claude · Iconos")], 5_000));
        assert!(sync_board(&mut board, &[Presence { task: Some("Arreglar iconos".into()), ..presence("a", "Claude · Iconos") }], 6_000));
        assert!(sync_board(&mut board, &[Presence { task: Some("Arreglar iconos".into()), ..presence("a", "Claude · Iconos") }], 6_000 + BEAT_MS));
        assert!(!sync_board(&mut board, &[presence("bad id!", "x")], 0));
    }

    #[test]
    fn the_store_is_shared_between_processes_through_one_file_per_project() {
        let dir = std::env::temp_dir().join(format!("trex coordination {}", uid("test")));
        fs::create_dir_all(&dir).unwrap();
        let project = if cfg!(windows) { "D:\\Proyecto Uno" } else { "/home/ana/Proyecto Uno" };
        with_board(&dir, project, |board, _, now| ((), sync_board(board, &[presence("a", "A"), presence("b", "B")], now))).unwrap();
        let claimed = call(&dir, project, "a", "trex_claim", &json!({"resources":["port:1430"]}));
        assert_eq!(claimed["isError"], false, "{claimed}");
        let busy = call(&dir, &format!("{project}/"), "b", "trex_claim", &json!({"resources":["PORT:1430"]}));
        assert!(busy["content"][0]["text"].as_str().unwrap().contains("lo tiene «A»"), "{busy}");
        assert_eq!(call(&dir, project, "b", "trex_nope", &json!({}))["isError"], true);
        assert_eq!(call(&dir, "relativo", "b", "trex_peers", &json!({}))["isError"], true);
        let _ = fs::remove_dir_all(&dir);
    }
}
