//! Durable team tasks. Models can address configured members, never choose a
//! command, credential, workspace, execution policy or another team's epoch.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs::{self, File, OpenOptions, TryLockError},
    io::{self, BufRead, Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

const LIMIT: usize = 8 * 1024 * 1024;
const FLAG: &str = "--trex-team-mcp";
const CALL_FLAG: &str = "--trex-team-call";
const ACTIVE: [&str; 3] = ["queued", "claimed", "running"];
static SEQUENCE: AtomicU64 = AtomicU64::new(0);
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn uid() -> String {
    format!(
        "task-{}-{}-{}",
        now(),
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    )
}
fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
}
fn clean(value: &str, limit: usize) -> Result<String, String> {
    if value.is_empty() || value.len() > limit {
        return Err(format!("El texto debe ocupar entre 1 y {limit} bytes."));
    }
    let value = crate::handoff::sanitize_handoff_text(value);
    if value.trim().is_empty() {
        return Err("El texto no contiene instrucciones utilizables.".into());
    }
    Ok(value)
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Member {
    pub id: String,
    pub name: String,
    pub role: String,
    pub can_write: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub epoch: String,
    pub key: String,
    pub member_id: String,
    pub instruction: String,
    pub status: String,
    pub report: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanStep {
    pub task_key: String,
    pub member_id: String,
    pub task: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub depends_on: Option<Vec<String>>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub id: String,
    pub epoch: String,
    pub phase: String,
    pub tasks: Vec<Task>,
    #[serde(default)]
    pub plan: Vec<PlanStep>,
    pub heartbeat: u64,
    cwd: String,
    members: Vec<Member>,
    #[serde(default)]
    coordinator_can_write: bool,
}
fn regular(path: &Path) -> Result<(), String> {
    let meta = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return Err("El almacén del equipo no admite enlaces.".into());
        }
    }
    if meta.file_type().is_symlink() {
        return Err("El almacén del equipo no admite enlaces.".into());
    }
    Ok(())
}
fn store_path(root: &Path, id: &str) -> Result<PathBuf, String> {
    if !root.is_absolute() || !valid_id(id) {
        return Err("Identificador de equipo no válido.".into());
    }
    let dir = root.join("agent-teams");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    regular(&dir)?;
    Ok(dir.join(format!("{id}.json")))
}
fn lock(root: &Path) -> Result<File, String> {
    let dir = root.join("agent-teams");
    regular(&dir)?;
    let path = dir.join(".lock");
    if path.exists() {
        regular(&path)?;
    }
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(path).map_err(|e| e.to_string())?;
    let start = Instant::now();
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(file),
            Err(TryLockError::WouldBlock) if start.elapsed() < Duration::from_secs(3) => {
                std::thread::sleep(Duration::from_millis(10))
            }
            _ => return Err("El almacén del equipo está ocupado.".into()),
        }
    }
}
fn load(path: &Path) -> Result<Snapshot, String> {
    regular(path)?;
    let mut bytes = Vec::new();
    File::open(path)
        .map_err(|e| e.to_string())?
        .take((LIMIT + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > LIMIT {
        return Err("El historial del equipo supera el límite de almacenamiento.".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "El historial del equipo no es válido.".into())
}
fn save(path: &Path, state: &Snapshot) -> Result<(), String> {
    let bytes = serde_json::to_vec(state).map_err(|e| e.to_string())?;
    save_bytes(path, &bytes)
}
fn save_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if bytes.len() > LIMIT {
        return Err("El historial del equipo supera 8 MiB.".into());
    }
    let tmp = path.with_file_name(format!(".{}.tmp", uid()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| -> io::Result<()> {
        let mut file = options.open(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStrExt;
            #[link(name = "kernel32")]
            extern "system" {
                fn MoveFileExW(a: *const u16, b: *const u16, flags: u32) -> i32;
            }
            let a: Vec<_> = tmp.as_os_str().encode_wide().chain(Some(0)).collect();
            let b: Vec<_> = path.as_os_str().encode_wide().chain(Some(0)).collect();
            if unsafe { MoveFileExW(a.as_ptr(), b.as_ptr(), 0x1 | 0x8) } == 0 {
                return Err(io::Error::last_os_error());
            }
        }
        #[cfg(not(windows))]
        {
            fs::rename(&tmp, path)?;
            File::open(path.parent().unwrap())?.sync_all()?;
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result.map_err(|_| "No se pudo guardar el estado del equipo.".into())
}
fn load_live(path: &Path) -> Result<Snapshot, String> {
    let mut state = load(path)?;
    let lease = path.with_extension("lease");
    if lease.exists() {
        regular(&lease)?;
        let mut bytes = Vec::new();
        File::open(lease)
            .map_err(|e| e.to_string())?
            .take(2049)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() > 2048 {
            return Err("La conexión del equipo no es válida.".into());
        }
        let value: Value =
            serde_json::from_slice(&bytes).map_err(|_| "La conexión del equipo no es válida.")?;
        if value["epoch"] == state.epoch {
            state.heartbeat = value["heartbeat"]
                .as_u64()
                .ok_or("La conexión del equipo no es válida.")?;
        }
    }
    Ok(state)
}
fn heartbeat(path: &Path, epoch: &str) -> Result<u64, String> {
    let stamp = now();
    save_bytes(
        &path.with_extension("lease"),
        &serde_json::to_vec(&json!({"epoch":epoch,"heartbeat":stamp}))
            .map_err(|e| e.to_string())?,
    )?;
    Ok(stamp)
}
fn mutate(
    root: &Path,
    id: &str,
    epoch: &str,
    work: impl FnOnce(&mut Snapshot) -> Result<(), String>,
) -> Result<Snapshot, String> {
    let path = store_path(root, id)?;
    let _guard = lock(root)?;
    let mut state = load_live(&path)?;
    if state.id != id || state.epoch != epoch {
        return Err("Esta generación del equipo ya no está activa.".into());
    }
    work(&mut state)?;
    save(&path, &state)?;
    Ok(state)
}
fn live(state: &Snapshot) -> Result<(), String> {
    if state.phase != "running" || now().saturating_sub(state.heartbeat) > 15000 {
        return Err(
            "El equipo está pausado o desconectado. Revisa su estado antes de continuar.".into(),
        );
    }
    Ok(())
}
fn pause(state: &mut Snapshot) {
    state.phase = "paused".into();
    for task in &mut state.tasks {
        if ACTIVE.contains(&task.status.as_str()) {
            task.status = if task.status == "queued" {
                "cancelled"
            } else {
                "uncertain"
            }
            .into();
            task.report=Some("Tarea detenida. Revisa el historial y los archivos; no se volverá a ejecutar automáticamente.".into());
            task.updated_at = now();
        }
    }
}
#[cfg(test)]
fn open(
    root: &Path,
    id: &str,
    epoch: &str,
    cwd: &str,
    members: Vec<Member>,
    resume: bool,
) -> Result<Snapshot, String> {
    open_with_permissions(root, id, epoch, cwd, members, resume, false)
}
fn open_with_permissions(
    root: &Path,
    id: &str,
    epoch: &str,
    cwd: &str,
    mut members: Vec<Member>,
    resume: bool,
    coordinator_can_write: bool,
) -> Result<Snapshot, String> {
    if !valid_id(epoch)
        || members.is_empty()
        || members.len() > 8
        || !Path::new(cwd).is_absolute()
        || !Path::new(cwd).is_dir()
    {
        return Err("La configuración del equipo no es válida.".into());
    }
    let mut seen = std::collections::HashSet::new();
    for m in &mut members {
        if !valid_id(&m.id)
            || !seen.insert(m.id.clone())
            || m.name.trim().is_empty()
            || m.name.len() > 200
            || ![
                "implementation",
                "review",
                "fix",
                "research",
                "validation",
                "custom",
            ]
            .contains(&m.role.as_str())
        {
            return Err("Un subagente no es válido.".into());
        }
        m.name = clean(&m.name, 200)?;
    }
    let path = store_path(root, id)?;
    let _guard = lock(root)?;
    let existed = path.exists();
    let mut state = if existed {
        load(&path)?
    } else {
        Snapshot {
            id: id.into(),
            epoch: epoch.into(),
            phase: "running".into(),
            cwd: cwd.into(),
            members: members.clone(),
            coordinator_can_write,
            heartbeat: now(),
            tasks: vec![],
            plan: vec![],
        }
    };
    if state.id != id
        || state.cwd != cwd
        || state.members != members
        || state.coordinator_can_write != coordinator_can_write
    {
        return Err(
            "Los participantes y el proyecto de un equipo existente son inmutables.".into(),
        );
    }
    if state.epoch != epoch || state.phase != "running" {
        if !resume {
            return Err("Este equipo requiere revisión y reanudación explícita.".into());
        }
        pause(&mut state);
        state.epoch = epoch.into();
        state.phase = "running".into();
    } else if resume && existed {
        return Err("Para reanudar usa una generación nueva.".into());
    }
    state.heartbeat = now();
    save(&path, &state)?;
    heartbeat(&path, epoch)?;
    Ok(state)
}
fn dependencies(plan: &[PlanStep], key: &str) -> Vec<String> {
    let Some(index) = plan.iter().position(|step| step.task_key == key) else {
        return vec![];
    };
    plan[index].depends_on.clone().unwrap_or_else(|| {
        if index > 0 {
            vec![plan[index - 1].task_key.clone()]
        } else {
            vec![]
        }
    })
}
fn runnable(state: &Snapshot, task: &Task) -> bool {
    let active: Vec<_> = state
        .tasks
        .iter()
        .filter(|t| t.epoch == state.epoch && ["claimed", "running"].contains(&t.status.as_str()))
        .collect();
    if active.len() >= 4 || active.iter().any(|t| t.member_id == task.member_id) {
        return false;
    }
    let writes = |member: &str| {
        state
            .members
            .iter()
            .find(|m| m.id == member)
            .is_some_and(|m| m.can_write)
    };
    if !active.is_empty()
        && (writes(&task.member_id) || active.iter().any(|t| writes(&t.member_id)))
    {
        return false;
    }
    let Some(step) = state.plan.iter().find(|step| step.task_key == task.key) else {
        return active.is_empty()
            && !state
                .tasks
                .iter()
                .take_while(|t| t.id != task.id)
                .any(|t| t.epoch == state.epoch && ACTIVE.contains(&t.status.as_str()));
    };
    // Unannotated plans keep their original sequential semantics.
    if step.depends_on.is_none() && !active.is_empty() {
        return false;
    }
    dependencies(&state.plan, &task.key).iter().all(|key| {
        state
            .tasks
            .iter()
            .any(|t| t.key == *key && t.status == "completed")
    })
}
fn settle_blocked(state: &mut Snapshot) {
    for _ in 0..32 {
        let blocked: Vec<_> = state
            .tasks
            .iter()
            .filter(|task| {
                task.epoch == state.epoch
                    && task.status == "queued"
                    && dependencies(&state.plan, &task.key).iter().any(|key| {
                        state.tasks.iter().any(|t| {
                            t.key == *key
                                && ["failed", "cancelled", "uncertain"].contains(&t.status.as_str())
                        })
                    })
            })
            .map(|task| task.id.clone())
            .collect();
        if blocked.is_empty() {
            break;
        }
        for task in &mut state.tasks {
            if blocked.contains(&task.id) {
                task.status = "cancelled".into();
                task.report =
                    Some("No se ejecutó: una dependencia no terminó correctamente.".into());
                task.updated_at = now();
            }
        }
    }
}
#[cfg(test)]
fn claim(root: &Path, id: &str, epoch: &str) -> Result<Snapshot, String> {
    claim_for(root, id, epoch, None)
}
fn claim_for(
    root: &Path,
    id: &str,
    epoch: &str,
    task_id: Option<&str>,
) -> Result<Snapshot, String> {
    mutate(root, id, epoch, |state| {
        live(state)?;
        let blocked: Vec<_> = state
            .tasks
            .iter()
            .filter(|task| {
                task.epoch == epoch
                    && task.status == "queued"
                    && dependencies(&state.plan, &task.key).iter().any(|key| {
                        state.tasks.iter().any(|t| {
                            t.key == *key
                                && ["failed", "cancelled", "uncertain"].contains(&t.status.as_str())
                        })
                    })
            })
            .map(|t| t.id.clone())
            .collect();
        for task in &mut state.tasks {
            if blocked.contains(&task.id) {
                task.status = "cancelled".into();
                task.report =
                    Some("No se ejecutó: una dependencia no terminó correctamente.".into());
                task.updated_at = now();
            }
        }
        let selected = state.tasks.iter().position(|task| {
            task.epoch == epoch
                && task.status == "queued"
                && task_id.is_none_or(|id| task.id == id)
                && runnable(state, task)
        });
        if let Some(index) = selected {
            state.tasks[index].status = "claimed".into();
            state.tasks[index].updated_at = now();
        }
        Ok(())
    })
}
fn finish(
    root: &Path,
    id: &str,
    epoch: &str,
    task_id: &str,
    status: &str,
    report: Option<&str>,
) -> Result<Snapshot, String> {
    if !["running", "completed", "failed", "uncertain"].contains(&status) {
        return Err("Estado de tarea no válido.".into());
    }
    let report = report.map(|value| clean(value, 32 * 1024)).transpose()?;
    mutate(root, id, epoch, |state| {
        live(state)?;
        let task = state
            .tasks
            .iter_mut()
            .find(|t| t.id == task_id && t.epoch == epoch)
            .ok_or("La tarea no pertenece a este equipo.")?;
        if !["claimed", "running"].contains(&task.status.as_str()) {
            return Err("La tarea ya no está pendiente.".into());
        }
        if status == "running" && task.status != "claimed" {
            return Err("El envío de esta tarea ya se había iniciado.".into());
        }
        if status != "running" && report.is_none() {
            return Err("La tarea necesita un resultado verificable.".into());
        }
        task.status = status.into();
        task.report = report;
        task.updated_at = now();
        settle_blocked(state);
        Ok(())
    })
}
pub fn tool_definitions() -> Value {
    json!([
        {"name":"trex_team_plan","description":"Publica la lista de tareas del equipo antes de delegar. No ejecuta trabajo. Usa las mismas taskKey, memberId y task al delegar; el progreso se obtiene de los resultados reales. Puedes revisar pasos aún no enviados, sin ocultar tareas ya emitidas.","inputSchema":{"type":"object","properties":{"steps":{"type":"array","minItems":1,"maxItems":32,"items":{"type":"object","properties":{"taskKey":{"type":"string","maxLength":100},"memberId":{"type":"string"},"task":{"type":"string","maxLength":16384},"dependsOn":{"type":"array","maxItems":8,"items":{"type":"string"}}},"required":["taskKey","memberId","task"],"additionalProperties":false}}},"required":["steps"],"additionalProperties":false},"annotations":{"readOnlyHint":false,"destructiveHint":false,"idempotentHint":true}},
        {"name":"trex_team_members","description":"Lista los subagentes configurados, sus funciones y permisos. No crea participantes ni cambia modelos.","inputSchema":{"type":"object","properties":{},"additionalProperties":false},"annotations":{"readOnlyHint":true}},
        {"name":"trex_delegate_task","description":"Delega una tarea a un subagente configurado y espera su resultado. Si el principal puede editar, devuelve la tarea en cola y awaitCoordinatorTurnEnd:true: termina el turno para que empiece el subagente. Con wait:false solo encola y devuelve el taskId: úsalo para enviar tareas independientes antes de esperar sus resultados. El plan dependsOn define dependencias; las escrituras son exclusivas y hay hasta cuatro lectores simultáneos. Usa un taskKey único y estable; reutilízalo solo para recuperar la misma tarea, nunca para repetir una tarea incierta o cancelada.","inputSchema":{"type":"object","properties":{"memberId":{"type":"string"},"taskKey":{"type":"string","maxLength":100},"task":{"type":"string","maxLength":16384},"wait":{"type":"boolean","default":true}},"required":["memberId","taskKey","task"],"additionalProperties":false},"annotations":{"readOnlyHint":false,"destructiveHint":false,"idempotentHint":true}},
        {"name":"trex_task_status","description":"Consulta el estado de las tareas. Con taskId devuelve también el resultado conservado. waitMs (0..30000) espera cambios o la finalización sin ejecutar trabajo ni gastar turnos en consultas repetidas.","inputSchema":{"type":"object","properties":{"taskId":{"type":"string"},"waitMs":{"type":"integer","minimum":0,"maximum":30000}},"additionalProperties":false},"annotations":{"readOnlyHint":true}}
    ])
}
fn result(value: Value, is_error: bool) -> Value {
    json!({"content":[{"type":"text","text":value.to_string()}],"structuredContent":value,"isError":is_error})
}
fn error(message: String) -> Value {
    result(json!({"error":message}), true)
}
fn tool(root: &Path, id: &str, epoch: &str, name: &str, args: &Value) -> Result<Value, String> {
    let args = args
        .as_object()
        .ok_or("Los argumentos deben ser un objeto.")?;
    let allowed: &[&str] = match name {
        "trex_team_plan" => &["steps"],
        "trex_team_members" => &[],
        "trex_delegate_task" => &["memberId", "taskKey", "task", "wait"],
        "trex_task_status" => &["taskId", "waitMs"],
        _ => return Err("Herramienta de equipo desconocida.".into()),
    };
    if args.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(
            "La herramienta no admite cambiar participantes, permisos, modelos ni proyecto.".into(),
        );
    }
    let text = |key: &str| {
        args.get(key)
            .and_then(Value::as_str)
            .ok_or_else(|| format!("Falta {key}."))
    };
    if name == "trex_team_plan" {
        if serde_json::to_vec(args)
            .map_err(|_| "Plan no válido.")?
            .len()
            > 48 * 1024
        {
            return Err("El plan completo no debe superar 48 KiB.".into());
        }
        let mut steps: Vec<PlanStep> =
            serde_json::from_value(args.get("steps").cloned().ok_or("Falta steps.")?)
                .map_err(|_| "La lista de tareas no es válida.")?;
        if steps.is_empty() || steps.len() > 32 {
            return Err("El plan debe tener entre 1 y 32 tareas.".into());
        }
        let mut keys = std::collections::HashSet::new();
        for step in &mut steps {
            if !valid_id(&step.task_key) || !keys.insert(step.task_key.clone()) {
                return Err("Cada tarea necesita una taskKey única y válida.".into());
            }
            step.task = clean(&step.task, 16 * 1024)?;
        }
        for (index, step) in steps.iter().enumerate() {
            if let Some(deps) = &step.depends_on {
                let mut seen = std::collections::HashSet::new();
                if deps.len() > 8
                    || deps.iter().any(|key| {
                        !seen.insert(key)
                            || !steps[..index].iter().any(|prior| prior.task_key == *key)
                    })
                {
                    return Err(
                        "dependsOn solo admite claves anteriores, sin duplicados ni ciclos.".into(),
                    );
                }
            }
        }
        let state = mutate(root, id, epoch, |state| {
            live(state)?;
            for step in &steps {
                if !state.members.iter().any(|m| m.id == step.member_id) {
                    return Err("El plan apunta a un subagente no configurado.".into());
                }
                if state.tasks.iter().any(|t| t.key == step.task_key)
                    && state
                        .plan
                        .iter()
                        .any(|prior| prior.task_key == step.task_key)
                    && dependencies(&state.plan, &step.task_key)
                        != dependencies(&steps, &step.task_key)
                {
                    return Err("No se pueden cambiar dependencias de una tarea enviada.".into());
                }
                if state.tasks.iter().any(|t| {
                    t.key == step.task_key
                        && (t.member_id != step.member_id || t.instruction != step.task)
                }) {
                    return Err("No se puede cambiar una tarea que ya fue enviada.".into());
                }
            }
            if state
                .tasks
                .iter()
                .filter(|t| t.epoch == epoch)
                .any(|t| !steps.iter().any(|s| s.task_key == t.key))
            {
                return Err("El plan debe conservar las tareas ya enviadas en este ciclo.".into());
            }
            state.plan = steps;
            Ok(())
        })?;
        return Ok(result(json!({"plan":state.plan}), false));
    }
    if name == "trex_team_members" {
        let state = mutate(root, id, epoch, |s| live(s))?;
        return Ok(result(
            json!({"members":state.members,"coordinatorCanWrite":state.coordinator_can_write}),
            false,
        ));
    }
    if name == "trex_task_status" {
        let mut state = mutate(root, id, epoch, |s| live(s))?;
        let task_id = args
            .get("taskId")
            .map(|v| v.as_str().ok_or("taskId no válido."))
            .transpose()?;
        let wait_ms = args
            .get("waitMs")
            .map(|value| {
                value
                    .as_u64()
                    .filter(|ms| *ms <= 30000)
                    .ok_or("waitMs debe ser un entero entre 0 y 30000.")
            })
            .transpose()?
            .unwrap_or(0);
        let deadline = Instant::now() + Duration::from_millis(wait_ms);
        while !state.coordinator_can_write
            && Instant::now() < deadline
            && state.tasks.iter().any(|task| {
                task_id.is_none_or(|id| id == task.id) && ACTIVE.contains(&task.status.as_str())
            })
        {
            std::thread::sleep(Duration::from_millis(100));
            let path = store_path(root, id)?;
            let _guard = lock(root)?;
            state = load_live(&path)?;
            if state.epoch != epoch {
                return Err("La generación del equipo cambió durante la consulta.".into());
            }
            live(&state)?;
        }
        if let Some(task_id) = task_id {
            let task = state
                .tasks
                .iter()
                .find(|t| t.id == task_id)
                .ok_or("No se encontró la tarea.")?;
            return Ok(result(json!({"task":task}), false));
        }
        return Ok(result(
            json!({"plan":state.plan,"tasks":state.tasks.iter().map(|t|json!({"id":t.id,"key":t.key,"memberId":t.member_id,"status":t.status})).collect::<Vec<_>>()}),
            false,
        ));
    }
    let wait = args
        .get("wait")
        .map(|value| value.as_bool().ok_or("wait debe ser booleano."))
        .transpose()?
        .unwrap_or(true);
    let member_id = text("memberId")?;
    let key = text("taskKey")?;
    let instruction = clean(text("task")?, 16 * 1024)?;
    if !valid_id(key) {
        return Err("taskKey debe ser un identificador estable de hasta 100 caracteres.".into());
    }
    let mut selected = String::new();
    let initial = mutate(root, id, epoch, |state| {
        live(state)?;
        if !state.members.iter().any(|m| m.id == member_id) {
            return Err("El subagente no está configurado en este equipo.".into());
        }
        if state.plan.iter().any(|step| {
            step.task_key == key && (step.member_id != member_id || step.task != instruction)
        }) {
            return Err("La delegación no coincide con la tarea publicada en el plan.".into());
        }
        if let Some(task) = state.tasks.iter().find(|t| t.key == key) {
            if task.member_id != member_id || task.instruction != instruction {
                return Err("Esta taskKey ya pertenece a una tarea diferente.".into());
            }
            selected = task.id.clone();
            return Ok(());
        }
        if state.tasks.len() >= 128 || state.tasks.iter().filter(|t| t.epoch == epoch).count() >= 32
        {
            return Err("Se alcanzó el límite de tareas. Revisa los resultados e inicia un ciclo nuevo o un equipo nuevo.".into());
        }
        let stamp = now();
        selected = uid();
        state.tasks.push(Task {
            id: selected.clone(),
            epoch: epoch.into(),
            key: key.into(),
            member_id: member_id.into(),
            instruction,
            status: "queued".into(),
            report: None,
            created_at: stamp,
            updated_at: stamp,
        });
        settle_blocked(state);
        Ok(())
    })?;
    if !wait || initial.coordinator_can_write {
        let task = initial
            .tasks
            .iter()
            .find(|task| task.id == selected)
            .ok_or("La tarea no está disponible.")?;
        return Ok(result(
            json!({"task":task,"queued":ACTIVE.contains(&task.status.as_str()),"awaitCoordinatorTurnEnd":initial.coordinator_can_write && ACTIVE.contains(&task.status.as_str())}),
            ["failed", "cancelled", "uncertain"].contains(&task.status.as_str()),
        ));
    }
    let path = store_path(root, id)?;
    let deadline = Instant::now() + Duration::from_secs(1800);
    let mut state = initial;
    loop {
        if state.epoch != epoch {
            return Err("La generación de la delegación fue sustituida. Revisa la tarea antes de continuar.".into());
        }
        let task = state
            .tasks
            .iter()
            .find(|t| t.id == selected)
            .ok_or("La tarea ya no está disponible.")?;
        if !ACTIVE.contains(&task.status.as_str()) {
            let task = task.clone();
            if ["uncertain", "cancelled"].contains(&task.status.as_str()) {
                let _ = mutate(root, id, epoch, |state| {
                    pause(state);
                    Ok(())
                });
            }
            return Ok(result(json!({"task":task}), task.status != "completed"));
        }
        if live(&state).is_err() || Instant::now() > deadline {
            let stopped = mutate(root, id, epoch, |state| {
                pause(state);
                Ok(())
            })?;
            let task = stopped
                .tasks
                .iter()
                .find(|task| task.id == selected)
                .ok_or("No se pudo recuperar la entrega pendiente.")?;
            return Ok(result(json!({"task":task,"manualReview":true}), true));
        }
        std::thread::sleep(Duration::from_millis(250));
        let _guard = lock(root)?;
        state = load_live(&path)?;
    }
}
fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn agent_team_open(
    app: AppHandle,
    id: String,
    epoch: String,
    cwd: String,
    members: Vec<Member>,
    resume: bool,
    coordinator_can_write: Option<bool>,
) -> Result<Snapshot, String> {
    let root = data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        open_with_permissions(&root, &id, &epoch, &cwd, members, resume, coordinator_can_write.unwrap_or(false))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn agent_team_snapshot(app: AppHandle, id: String) -> Result<Snapshot, String> {
    let root = data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let path = store_path(&root, &id)?;
        let _guard = lock(&root)?;
        load(&path)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn agent_team_poll(
    app: AppHandle,
    id: String,
    epoch: String,
) -> Result<Snapshot, String> {
    let root = data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let path = store_path(&root, &id)?;
        let _guard = lock(&root)?;
        let mut state = load(&path)?;
        if state.id != id || state.epoch != epoch {
            return Err("Esta generación del equipo ya no está activa.".into());
        }
        state.heartbeat = heartbeat(&path, &epoch)?;
        Ok(state)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn agent_team_claim(
    app: AppHandle,
    id: String,
    epoch: String,
    task_id: Option<String>,
) -> Result<Snapshot, String> {
    let root = data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || claim_for(&root, &id, &epoch, task_id.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn agent_team_finish(
    app: AppHandle,
    id: String,
    epoch: String,
    task_id: String,
    status: String,
    report: Option<String>,
) -> Result<Snapshot, String> {
    let root = data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        finish(&root, &id, &epoch, &task_id, &status, report.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn agent_team_pause(
    app: AppHandle,
    id: String,
    epoch: String,
) -> Result<Snapshot, String> {
    let root = data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        mutate(&root, &id, &epoch, |s| {
            pause(s);
            Ok(())
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn agent_team_mcp_config(
    app: AppHandle,
    id: String,
    epoch: String,
) -> Result<Value, String> {
    let root = data_dir(&app)?;
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move|| {
        let state=mutate(&root,&id,&epoch,|s|live(s))?;
        Ok::<_,String>(json!({"command":executable,"args":[FLAG,root,state.id,state.epoch],"callArgs":[CALL_FLAG,root,id,epoch]}))
    }).await.map_err(|e|e.to_string())?
}

/// This dispatch precedes Tauri startup, including for malformed invocations.
pub fn run_if_requested() -> bool {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    let Some(flag) = args.first().and_then(|v| v.to_str()) else {
        return false;
    };
    if flag != FLAG && flag != CALL_FLAG {
        return false;
    }
    if args.len() != 4 {
        eprintln!("trex team: invalid launch");
        return true;
    }
    let root = PathBuf::from(&args[1]);
    let id = args[2].to_string_lossy();
    let epoch = args[3].to_string_lossy();
    if !root.is_absolute() || !valid_id(&id) || !valid_id(&epoch) {
        eprintln!("trex team: invalid binding");
        return true;
    }
    let stdin = io::stdin();
    let mut reader = stdin.lock();
    let stdout = io::stdout();
    let mut writer = stdout.lock();
    let mut cache = std::collections::HashMap::<String, (Value, Value)>::new();
    loop {
        let mut bytes = Vec::new();
        match reader
            .by_ref()
            .take(64 * 1024 + 1)
            .read_until(b'\n', &mut bytes)
        {
            Ok(0) | Err(_) => break,
            _ => {}
        }
        if bytes.len() > 64 * 1024 {
            break;
        }
        let request: Value = match serde_json::from_slice(&bytes) {
            Ok(v) => v,
            Err(_) => break,
        };
        let response = if flag == CALL_FLAG {
            tool(
                &root,
                &id,
                &epoch,
                request["name"].as_str().unwrap_or(""),
                &request["arguments"],
            )
            .unwrap_or_else(error)
        } else {
            let rpc_id = &request["id"];
            let method = request["method"].as_str().unwrap_or("");
            if rpc_id.is_null() {
                continue;
            }
            if request["jsonrpc"] != "2.0" || !(rpc_id.is_string() || rpc_id.is_number()) {
                let reply = json!({"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"Invalid team RPC request"}});
                let _ = serde_json::to_writer(&mut writer, &reply);
                let _ = writer.write_all(b"\n");
                let _ = writer.flush();
                continue;
            }
            let cache_key = rpc_id.to_string();
            if let Some((prior, reply)) = cache.get(&cache_key) {
                if prior == &request {
                    if serde_json::to_writer(&mut writer, reply).is_err() {
                        break;
                    }
                    let _ = writer.write_all(b"\n");
                    let _ = writer.flush();
                    continue;
                }
                let reply = json!({"jsonrpc":"2.0","id":rpc_id,"error":{"code":-32600,"message":"RPC id reused with a different request"}});
                let _ = serde_json::to_writer(&mut writer, &reply);
                let _ = writer.write_all(b"\n");
                let _ = writer.flush();
                continue;
            }
            let arguments = request["params"]
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let requested_version = request["params"]["protocolVersion"]
                .as_str()
                .unwrap_or("2025-11-25");
            let version = if ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]
                .contains(&requested_version)
            {
                requested_version
            } else {
                "2025-11-25"
            };
            let result = match method {
                "initialize" => {
                    json!({"protocolVersion":version,"capabilities":{"tools":{}},"serverInfo":{"name":"trex_team","version":"1.0.0"},"instructions":"Publish dependencies with trex_team_plan dependsOn; [] marks independent work. Enqueue independent delegations with wait:false, then retrieve reports using trex_task_status. When browser integration is enabled, each member has a separate browser space. Workspace writers are exclusive; up to four independent readers run at once. Never replay uncertain work."})
                }
                "ping" => json!({}),
                "tools/list" => json!({"tools":tool_definitions()}),
                "tools/call" => tool(
                    &root,
                    &id,
                    &epoch,
                    request["params"]["name"].as_str().unwrap_or(""),
                    &arguments,
                )
                .unwrap_or_else(error),
                _ => error("Método de equipo desconocido.".into()),
            };
            let reply = json!({"jsonrpc":"2.0","id":rpc_id,"result":result});
            if method == "tools/call" && cache.len() < 256 {
                cache.insert(cache_key, (request.clone(), reply.clone()));
            }
            reply
        };
        if serde_json::to_writer(&mut writer, &response).is_err() {
            break;
        }
        let _ = writer.write_all(b"\n");
        if writer.flush().is_err() {
            break;
        }
        if flag == CALL_FLAG {
            break;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture {
        root: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("trex-team-test-{}", uid()));
            fs::create_dir(&root).unwrap();
            Self { root }
        }
        fn open(&self, epoch: &str, resume: bool) -> Result<Snapshot, String> {
            open(
                &self.root,
                "team",
                epoch,
                self.root.to_str().unwrap(),
                members(),
                resume,
            )
        }
        fn read(&self) -> Snapshot {
            load_live(&store_path(&self.root, "team").unwrap()).unwrap()
        }
        fn queued(&self, key: &str) -> String {
            let id = uid();
            mutate(&self.root, "team", "epoch", |s| {
                s.tasks.push(Task {
                    id: id.clone(),
                    epoch: "epoch".into(),
                    key: key.into(),
                    member_id: "impl".into(),
                    instruction: "Implement the task".into(),
                    status: "queued".into(),
                    report: None,
                    created_at: now(),
                    updated_at: now(),
                });
                Ok(())
            })
            .unwrap();
            id
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
    fn members() -> Vec<Member> {
        vec![
            Member {
                id: "impl".into(),
                name: "Implementation".into(),
                role: "implementation".into(),
                can_write: true,
            },
            Member {
                id: "review".into(),
                name: "Review".into(),
                role: "review".into(),
                can_write: false,
            },
        ]
    }
    #[test]
    fn writable_coordinator_defers_delegation_and_waits_until_its_turn_ends() {
        let fixture = Fixture::new();
        let cwd = fixture.root.to_str().unwrap();
        let state = open_with_permissions(
            &fixture.root, "team", "epoch", cwd, members(), false, true,
        ).unwrap();
        assert!(state.coordinator_can_write);
        let result = tool(
            &fixture.root, "team", "epoch", "trex_delegate_task",
            &json!({"memberId":"impl","taskKey":"change","task":"Implement the change","wait":true}),
        ).unwrap();
        assert_eq!(result["structuredContent"]["task"]["status"], "queued");
        assert_eq!(result["structuredContent"]["awaitCoordinatorTurnEnd"], true);
        let stamp = Instant::now();
        let status = tool(&fixture.root, "team", "epoch", "trex_task_status", &json!({"waitMs":30000})).unwrap();
        assert!(stamp.elapsed() < Duration::from_secs(2));
        assert_eq!(status["structuredContent"]["tasks"][0]["status"], "queued");
        assert!(open_with_permissions(&fixture.root, "team", "epoch", cwd, members(), false, false).is_err());
    }
    #[test]
    fn configuration_is_bound_to_workspace_members_and_fresh_epoch() {
        let f = Fixture::new();
        f.open("epoch", false).unwrap();
        let mut changed = members();
        changed[0].can_write = false;
        assert!(open(
            &f.root,
            "team",
            "epoch",
            f.root.to_str().unwrap(),
            changed,
            false
        )
        .is_err());
        assert!(f.open("next", false).is_err());
        assert!(f.open("epoch", true).is_err());
        assert_eq!(f.open("next", true).unwrap().epoch, "next");
        assert!(claim(&f.root, "team", "epoch").is_err());
    }
    #[test]
    fn only_one_claim_is_allowed_across_concurrent_consumers() {
        let f = Fixture::new();
        f.open("epoch", false).unwrap();
        let first = f.queued("one");
        let second = f.queued("two");
        std::thread::scope(|scope| {
            for _ in 0..6 {
                scope.spawn(|| {
                    claim(&f.root, "team", "epoch").unwrap();
                });
            }
        });
        let s = f.read();
        assert_eq!(s.tasks.iter().filter(|t| t.status == "claimed").count(), 1);
        assert_eq!(s.tasks[0].id, first);
        assert_eq!(s.tasks[1].id, second);
        assert_eq!(s.tasks[1].status, "queued");
        finish(
            &f.root,
            "team",
            "epoch",
            &first,
            "completed",
            Some("Validated implementation"),
        )
        .unwrap();
        assert_eq!(
            claim(&f.root, "team", "epoch").unwrap().tasks[1].status,
            "claimed"
        );
    }
    #[test]
    fn pause_and_restore_never_replay_started_or_queued_work() {
        let f = Fixture::new();
        f.open("epoch", false).unwrap();
        let first = f.queued("one");
        f.queued("two");
        claim(&f.root, "team", "epoch").unwrap();
        mutate(&f.root, "team", "epoch", |s| {
            pause(s);
            Ok(())
        })
        .unwrap();
        assert_eq!(
            f.read()
                .tasks
                .iter()
                .map(|t| t.status.as_str())
                .collect::<Vec<_>>(),
            ["uncertain", "cancelled"]
        );
        assert!(finish(
            &f.root,
            "team",
            "epoch",
            &first,
            "completed",
            Some("late result")
        )
        .is_err());
        assert!(f.open("epoch", false).is_err());
        let next = f.open("next", true).unwrap();
        assert_eq!(next.tasks[0].status, "uncertain");
        assert_eq!(next.tasks[1].status, "cancelled");
        assert!(!claim(&f.root, "team", "next")
            .unwrap()
            .tasks
            .iter()
            .any(|t| t.status == "claimed"));
    }
    #[test]
    fn publishes_plan_without_enqueuing_or_completing_work() {
        let f = Fixture::new();
        f.open("epoch", false).unwrap();
        let plan = json!({"steps":[{"taskKey":"first","memberId":"impl","task":"Implement the task"},{"taskKey":"second","memberId":"review","task":"Review the changes"}]});
        let result = tool(&f.root, "team", "epoch", "trex_team_plan", &plan).unwrap();
        assert_eq!(result["structuredContent"]["plan"][0]["taskKey"], "first");
        assert_eq!(f.read().tasks.len(), 0);
        assert_eq!(f.read().plan.len(), 2);
        assert_eq!(
            tool(&f.root, "team", "epoch", "trex_team_plan", &plan).unwrap(),
            result
        );
        let task = f.queued("first");
        claim(&f.root, "team", "epoch").unwrap();
        finish(
            &f.root,
            "team",
            "epoch",
            &task,
            "completed",
            Some("Verified implementation"),
        )
        .unwrap();
        let snapshot = f.read();
        assert_eq!(snapshot.tasks[0].status, "completed");
        assert_eq!(snapshot.plan.len(), 2);
        assert!(tool(
            &f.root,
            "team",
            "epoch",
            "trex_team_plan",
            &json!({"steps":[{"taskKey":"first","memberId":"impl","task":"Changed instruction"}]})
        )
        .is_err());
        assert!(tool(
            &f.root,
            "team",
            "epoch",
            "trex_team_plan",
            &json!({"steps":[{"taskKey":"second","memberId":"review","task":"Review the changes"}]})
        )
        .is_err());
        assert_eq!(f.read().plan, snapshot.plan);
    }
    #[test]
    fn plan_validation_is_atomic_and_never_changes_permissions() {
        let f = Fixture::new();
        f.open("epoch", false).unwrap();
        for steps in [
            json!([]),
            json!([{"taskKey":"a","memberId":"unknown","task":"bad owner"}]),
            json!([{"taskKey":"a","memberId":"impl","task":"safe"},{"taskKey":"a","memberId":"review","task":"duplicate"}]),
            json!([{"taskKey":"a","memberId":"impl","task":"safe","status":"completed"}]),
            json!([{"taskKey":"a","memberId":"impl","task":"safe"},null]),
        ] {
            assert!(tool(
                &f.root,
                "team",
                "epoch",
                "trex_team_plan",
                &json!({"steps":steps})
            )
            .is_err());
            assert!(f.read().plan.is_empty());
            assert!(f.read().tasks.is_empty());
        }
        tool(
            &f.root,
            "team",
            "epoch",
            "trex_team_plan",
            &json!({"steps":[{"taskKey":"a","memberId":"impl","task":"safe"}]}),
        )
        .unwrap();
        assert!(tool(
            &f.root,
            "team",
            "epoch",
            "trex_delegate_task",
            &json!({"taskKey":"a","memberId":"impl","task":"different"})
        )
        .is_err());
        assert!(f.read().tasks.is_empty());
        let path = store_path(&f.root, "team").unwrap();
        let mut old = serde_json::to_value(f.read()).unwrap();
        old.as_object_mut().unwrap().remove("plan");
        save_bytes(&path, &serde_json::to_vec(&old).unwrap()).unwrap();
        assert!(load(&path).unwrap().plan.is_empty());
    }
    #[test]
    fn delegate_returns_report_and_retry_is_deduplicated() {
        let f = Fixture::new();
        f.open("epoch", false).unwrap();
        let root = f.root.clone();
        let args = json!({"memberId":"impl","taskKey":"stable-key","task":"Implement search"});
        let request = args.clone();
        let task = std::thread::spawn(move || {
            tool(&root, "team", "epoch", "trex_delegate_task", &request)
        });
        let deadline = Instant::now() + Duration::from_secs(5);
        while f.read().tasks.is_empty() {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(10));
        }
        let claimed = claim(&f.root, "team", "epoch").unwrap();
        let id = &claimed.tasks[0].id;
        finish(&f.root, "team", "epoch", id, "running", None).unwrap();
        finish(
            &f.root,
            "team",
            "epoch",
            id,
            "completed",
            Some("Search implemented; tests pass."),
        )
        .unwrap();
        let reply = task.join().unwrap().unwrap();
        assert_eq!(reply["isError"], false);
        assert_eq!(
            reply["structuredContent"]["task"]["report"],
            "Search implemented; tests pass."
        );
        assert_eq!(
            tool(&f.root, "team", "epoch", "trex_delegate_task", &args).unwrap(),
            reply
        );
        assert_eq!(f.read().tasks.len(), 1);
        let changed = json!({"memberId":"impl","taskKey":"stable-key","task":"Different task"});
        assert!(tool(&f.root, "team", "epoch", "trex_delegate_task", &changed).is_err());
    }
    #[test]
    fn cancelled_key_is_still_not_reexecuted_in_a_new_cycle() {
        let f = Fixture::new();
        f.open("epoch", false).unwrap();
        let id = f.queued("stable");
        f.open("next", true).unwrap();
        let reply = tool(
            &f.root,
            "team",
            "next",
            "trex_delegate_task",
            &json!({"memberId":"impl","taskKey":"stable","task":"Implement the task"}),
        )
        .unwrap();
        assert_eq!(reply["structuredContent"]["task"]["id"], id);
        assert_eq!(reply["structuredContent"]["task"]["status"], "cancelled");
        assert_eq!(f.read().phase, "paused");
        assert_eq!(f.read().tasks.len(), 1);
    }
    #[test]
    fn status_of_old_uncertain_work_is_read_only() {
        let f = Fixture::new();
        f.open("epoch", false).unwrap();
        let id = f.queued("old");
        claim(&f.root, "team", "epoch").unwrap();
        f.open("next", true).unwrap();
        let reply = tool(
            &f.root,
            "team",
            "next",
            "trex_task_status",
            &json!({"taskId":id}),
        )
        .unwrap();
        assert_eq!(reply["isError"], false);
        assert_eq!(reply["structuredContent"]["task"]["status"], "uncertain");
        assert_eq!(f.read().phase, "running");
    }
    #[test]
    fn model_cannot_override_policy_or_create_a_worker() {
        let f = Fixture::new();
        f.open("epoch", false).unwrap();
        for args in [
            json!({"memberId":"unknown","taskKey":"key","task":"task"}),
            json!({"memberId":"impl","taskKey":"key","task":"task","cwd":"other"}),
            json!({"memberId":"impl","taskKey":"key","task":"task","model":"other"}),
            json!({"memberId":"impl","taskKey":"../key","task":"task"}),
        ] {
            assert!(tool(&f.root, "team", "epoch", "trex_delegate_task", &args).is_err());
        }
        assert!(tool(&f.root, "team", "epoch", "create_agent", &json!({})).is_err());
        assert!(f.read().tasks.is_empty());
    }
    #[test]
    fn stale_lease_refuses_new_work_but_heartbeat_does_not_rewrite_journal() {
        let f = Fixture::new();
        f.open("epoch", false).unwrap();
        let path = store_path(&f.root, "team").unwrap();
        let original = fs::read(&path).unwrap();
        heartbeat(&path, "epoch").unwrap();
        assert_eq!(fs::read(&path).unwrap(), original);
        save_bytes(
            &path.with_extension("lease"),
            br#"{"epoch":"epoch","heartbeat":1}"#,
        )
        .unwrap();
        assert!(tool(&f.root, "team", "epoch", "trex_team_members", &json!({})).is_err());
        assert!(claim(&f.root, "team", "epoch").is_err());
    }
    #[test]
    fn report_bounds_and_secret_redaction_are_enforced_before_completion() {
        let f = Fixture::new();
        f.open("epoch", false).unwrap();
        let id = f.queued("task");
        claim(&f.root, "team", "epoch").unwrap();
        assert!(finish(
            &f.root,
            "team",
            "epoch",
            &id,
            "completed",
            Some(&"x".repeat(32769))
        )
        .is_err());
        assert_eq!(f.read().tasks[0].status, "claimed");
        finish(
            &f.root,
            "team",
            "epoch",
            &id,
            "completed",
            Some("api_key=AUDIT_FAKE_ONLY\nTests passed."),
        )
        .unwrap();
        let saved = fs::read_to_string(store_path(&f.root, "team").unwrap()).unwrap();
        assert!(!saved.contains("AUDIT_FAKE_ONLY"));
        assert!(saved.contains("Tests passed."));
    }
    #[test]
    fn rejects_invalid_identity_configuration_and_unknown_finish() {
        let f = Fixture::new();
        assert!(f.open("../epoch", false).is_err());
        assert!(open(
            &f.root,
            "../team",
            "epoch",
            f.root.to_str().unwrap(),
            members(),
            false
        )
        .is_err());
        let mut duplicated = members();
        duplicated[1].id = "impl".into();
        assert!(open(
            &f.root,
            "team",
            "epoch",
            f.root.to_str().unwrap(),
            duplicated,
            false
        )
        .is_err());
        f.open("epoch", false).unwrap();
        let id = f.queued("task");
        assert!(finish(
            &f.root,
            "team",
            "epoch",
            &id,
            "completed",
            Some("not yet claimed")
        )
        .is_err());
        assert!(finish(&f.root, "team", "epoch", "unknown", "running", None).is_err());
    }
    #[test]
    fn independent_readers_finish_out_of_order_and_dependencies_block_writers() {
        let f = Fixture::new();
        let mut configured = members();
        configured[0].can_write = false;
        configured.push(Member {
            id: "writer".into(),
            name: "Writer".into(),
            role: "implementation".into(),
            can_write: true,
        });
        open(
            &f.root,
            "team",
            "epoch",
            f.root.to_str().unwrap(),
            configured,
            false,
        )
        .unwrap();
        let steps = json!({"steps":[{"taskKey":"a","memberId":"impl","task":"Inspect A","dependsOn":[]},{"taskKey":"b","memberId":"review","task":"Inspect B","dependsOn":[]},{"taskKey":"write","memberId":"writer","task":"Implement findings","dependsOn":["a","b"]},{"taskKey":"verify","memberId":"impl","task":"Verify implementation","dependsOn":["write"]}]});
        tool(&f.root, "team", "epoch", "trex_team_plan", &steps).unwrap();
        let mut ids = vec![];
        for step in steps["steps"].as_array().unwrap() {
            let reply=tool(&f.root,"team","epoch","trex_delegate_task",&json!({"memberId":step["memberId"],"taskKey":step["taskKey"],"task":step["task"],"wait":false})).unwrap();
            ids.push(
                reply["structuredContent"]["task"]["id"]
                    .as_str()
                    .unwrap()
                    .to_owned(),
            );
        }
        claim_for(&f.root, "team", "epoch", Some(&ids[0])).unwrap();
        let state = claim_for(&f.root, "team", "epoch", Some(&ids[1])).unwrap();
        assert_eq!(
            state.tasks.iter().filter(|t| t.status == "claimed").count(),
            2
        );
        assert_eq!(
            claim_for(&f.root, "team", "epoch", Some(&ids[2]))
                .unwrap()
                .tasks[2]
                .status,
            "queued"
        );
        finish(
            &f.root,
            "team",
            "epoch",
            &ids[1],
            "completed",
            Some("B verified"),
        )
        .unwrap();
        assert_eq!(
            claim_for(&f.root, "team", "epoch", Some(&ids[2]))
                .unwrap()
                .tasks[2]
                .status,
            "queued"
        );
        finish(
            &f.root,
            "team",
            "epoch",
            &ids[0],
            "completed",
            Some("A verified"),
        )
        .unwrap();
        assert_eq!(
            claim_for(&f.root, "team", "epoch", Some(&ids[2]))
                .unwrap()
                .tasks[2]
                .status,
            "claimed"
        );
        assert_eq!(
            claim_for(&f.root, "team", "epoch", Some(&ids[3]))
                .unwrap()
                .tasks[3]
                .status,
            "queued"
        );
        let state = finish(
            &f.root,
            "team",
            "epoch",
            &ids[2],
            "failed",
            Some("Implementation failed"),
        )
        .unwrap();
        assert_eq!(state.tasks[3].status, "cancelled");
    }
    #[test]
    fn dependency_validation_and_immutable_issued_plan_fail_before_mutation() {
        let f = Fixture::new();
        f.open("epoch", false).unwrap();
        for deps in [json!(["missing"]), json!(["a"]), json!(["b", "b"])] {
            assert!(tool(
                &f.root,
                "team",
                "epoch",
                "trex_team_plan",
                &json!({"steps":[{"taskKey":"a","memberId":"impl","task":"A","dependsOn":deps}]})
            )
            .is_err());
            assert!(f.read().plan.is_empty());
        }
        tool(&f.root,"team","epoch","trex_team_plan",&json!({"steps":[{"taskKey":"a","memberId":"impl","task":"A","dependsOn":[]},{"taskKey":"b","memberId":"review","task":"B","dependsOn":["a"]}]})).unwrap();
        let request = json!({"memberId":"review","taskKey":"b","task":"B","wait":false});
        let first = tool(&f.root, "team", "epoch", "trex_delegate_task", &request).unwrap();
        assert_eq!(
            first,
            tool(&f.root, "team", "epoch", "trex_delegate_task", &request).unwrap()
        );
        assert_eq!(f.read().tasks.len(), 1);
        assert!(tool(&f.root,"team","epoch","trex_team_plan",&json!({"steps":[{"taskKey":"a","memberId":"impl","task":"A","dependsOn":[]},{"taskKey":"b","memberId":"review","task":"B","dependsOn":[]}]})).is_err());
    }
    #[test]
    fn explicit_independent_work_still_excludes_workspace_writers() {
        let f = Fixture::new();
        f.open("epoch", false).unwrap();
        tool(&f.root,"team","epoch","trex_team_plan",&json!({"steps":[{"taskKey":"a","memberId":"impl","task":"A","dependsOn":[]},{"taskKey":"b","memberId":"review","task":"B","dependsOn":[]}]})).unwrap();
        for (key, member) in [("a", "impl"), ("b", "review")] {
            tool(
                &f.root,
                "team",
                "epoch",
                "trex_delegate_task",
                &json!({"taskKey":key,"memberId":member,"task":key.to_uppercase(),"wait":false}),
            )
            .unwrap();
        }
        claim(&f.root, "team", "epoch").unwrap();
        let state = claim(&f.root, "team", "epoch").unwrap();
        assert_eq!(state.tasks[0].status, "claimed");
        assert_eq!(state.tasks[1].status, "queued");
    }
    #[test]
    fn concurrent_readers_are_bounded_to_four_and_one_task_per_member() {
        let f = Fixture::new();
        let configured: Vec<_> = (0..5)
            .map(|i| Member {
                id: format!("reader{i}"),
                name: format!("Reader {i}"),
                role: "research".into(),
                can_write: false,
            })
            .collect();
        open(
            &f.root,
            "team",
            "epoch",
            f.root.to_str().unwrap(),
            configured,
            false,
        )
        .unwrap();
        let steps:Vec<_>=(0..5).map(|i|json!({"taskKey":format!("task{i}"),"memberId":format!("reader{i}"),"task":"Inspect","dependsOn":[]})).collect();
        tool(
            &f.root,
            "team",
            "epoch",
            "trex_team_plan",
            &json!({"steps":steps}),
        )
        .unwrap();
        for i in 0..5 {
            tool(&f.root,"team","epoch","trex_delegate_task",&json!({"taskKey":format!("task{i}"),"memberId":format!("reader{i}"),"task":"Inspect","wait":false})).unwrap();
        }
        for _ in 0..6 {
            claim(&f.root, "team", "epoch").unwrap();
        }
        let state = f.read();
        assert_eq!(
            state
                .tasks
                .iter()
                .filter(|task| task.status == "claimed")
                .count(),
            4
        );
        assert_eq!(state.tasks[4].status, "queued");
    }
    #[test]
    fn status_long_poll_wakes_on_a_report_without_dispatching_work() {
        let f = Fixture::new();
        f.open("epoch", false).unwrap();
        let id = f.queued("inspect");
        claim(&f.root, "team", "epoch").unwrap();
        std::thread::scope(|scope| {
            let waiter = scope.spawn(|| {
                tool(
                    &f.root,
                    "team",
                    "epoch",
                    "trex_task_status",
                    &json!({"taskId":id,"waitMs":5000}),
                )
                .unwrap()
            });
            std::thread::sleep(Duration::from_millis(150));
            finish(&f.root, "team", "epoch", &id, "completed", Some("Verified")).unwrap();
            let reply = waiter.join().unwrap();
            assert_eq!(reply["structuredContent"]["task"]["status"], "completed");
        });
        assert_eq!(f.read().tasks.len(), 1);
        assert!(tool(
            &f.root,
            "team",
            "epoch",
            "trex_task_status",
            &json!({"waitMs":30001})
        )
        .is_err());
    }
}
