//! Los asistentes no deben sobrevivir a trex.
//!
//! En Windows cada asistente se añade a un «job» del sistema que trex mantiene
//! abierto. Cuando trex termina —también si se cuelga o aborta, sin pasar por
//! el cierre ordenado— el sistema cierra el job y con él el asistente y todo
//! lo que haya lanzado. El cierre normal de una sesión sigue siendo el de
//! `agent.rs`; esto solo cubre lo que antes quedaba huérfano.
//!
//! El job permite a un proceso salirse si lo pide al crearse: Trex Browser
//! lanza así su servicio, que debe seguir vivo para otras sesiones.
//!
//! En Linux y macOS no hay un equivalente fiable (la señal de «padre muerto»
//! de Linux sigue al hilo que lanzó el proceso, no a la app), así que allí se
//! mantiene el cierre por grupo de procesos.

#[cfg(windows)]
mod windows {
    use std::ffi::c_void;
    use std::io;
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;
    use std::sync::OnceLock;

    type Handle = *mut c_void;

    #[repr(C)]
    #[derive(Default)]
    struct BasicLimits {
        per_process_user_time_limit: i64,
        per_job_user_time_limit: i64,
        limit_flags: u32,
        minimum_working_set_size: usize,
        maximum_working_set_size: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }
    /// JOBOBJECT_EXTENDED_LIMIT_INFORMATION.
    #[repr(C)]
    #[derive(Default)]
    struct ExtendedLimits {
        basic: BasicLimits,
        io_counters: [u64; 6],
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory_used: usize,
        peak_job_memory_used: usize,
    }
    // El sistema rechaza la llamada si el tamaño no es exactamente el suyo.
    #[cfg(target_pointer_width = "64")]
    const _: () = assert!(std::mem::size_of::<ExtendedLimits>() == 144);
    #[cfg(target_pointer_width = "32")]
    const _: () = assert!(std::mem::size_of::<ExtendedLimits>() == 112);

    const EXTENDED_LIMIT_INFORMATION: i32 = 9;
    pub(super) const KILL_ON_JOB_CLOSE: u32 = 0x2000;
    pub(super) const BREAKAWAY_OK: u32 = 0x0800;

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateJobObjectW(attributes: *const c_void, name: *const u16) -> Handle;
        fn SetInformationJobObject(job: Handle, class: i32, information: *const c_void, length: u32) -> i32;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
        fn CloseHandle(handle: Handle) -> i32;
    }
    #[cfg(test)]
    #[link(name = "kernel32")]
    extern "system" {
        fn QueryInformationJobObject(job: Handle, class: i32, information: *mut c_void, length: u32, returned: *mut u32) -> i32;
    }

    /// Un job que mata a sus procesos cuando se cierra su último manejador.
    pub(super) struct Job(Handle);
    // El manejador solo se usa en llamadas al sistema que admiten varios hilos.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Job {
        pub(super) fn new() -> io::Result<Self> {
            // Sin nombre y no heredable: solo trex lo tiene abierto.
            let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if handle.is_null() {
                return Err(io::Error::last_os_error());
            }
            let job = Self(handle);
            let mut limits = ExtendedLimits::default();
            limits.basic.limit_flags = KILL_ON_JOB_CLOSE | BREAKAWAY_OK;
            let size = std::mem::size_of::<ExtendedLimits>() as u32;
            if unsafe { SetInformationJobObject(job.0, EXTENDED_LIMIT_INFORMATION, (&limits as *const ExtendedLimits).cast(), size) } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(job)
        }

        pub(super) fn assign(&self, child: &Child) -> io::Result<()> {
            if unsafe { AssignProcessToJobObject(self.0, child.as_raw_handle().cast()) } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }

        #[cfg(test)]
        pub(super) fn limit_flags(&self) -> io::Result<u32> {
            let mut limits = ExtendedLimits::default();
            let size = std::mem::size_of::<ExtendedLimits>() as u32;
            if unsafe { QueryInformationJobObject(self.0, EXTENDED_LIMIT_INFORMATION, (&mut limits as *mut ExtendedLimits).cast(), size, std::ptr::null_mut()) } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(limits.basic.limit_flags)
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }

    /// El job de la app: se crea con el primer asistente y no se cierra nunca a mano.
    static APP_JOB: OnceLock<Option<Job>> = OnceLock::new();

    pub fn adopt(child: &Child) -> bool {
        APP_JOB.get_or_init(|| Job::new().ok()).as_ref().is_some_and(|job| job.assign(child).is_ok())
    }
}

/// Ata el proceso recién lanzado a la vida de trex. Devuelve false si el
/// sistema no lo permite (o fuera de Windows); el asistente funciona igual.
pub fn adopt(child: &std::process::Child) -> bool {
    #[cfg(windows)]
    {
        windows::adopt(child)
    }
    #[cfg(not(windows))]
    {
        let _ = child;
        false
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::windows::{Job, BREAKAWAY_OK, KILL_ON_JOB_CLOSE};
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    const NO_WINDOW: u32 = 0x0800_0000;

    /// Un proceso que por sí solo duraría un minuto.
    fn sleeper() -> std::process::Child {
        Command::new("ping").args(["-n", "60", "127.0.0.1"]).creation_flags(NO_WINDOW)
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().expect("ping is part of Windows")
    }

    fn exits_within(child: &mut std::process::Child, limit: Duration) -> bool {
        let started = Instant::now();
        while started.elapsed() < limit {
            if child.try_wait().unwrap().is_some() { return true; }
            std::thread::sleep(Duration::from_millis(50));
        }
        false
    }

    #[test]
    fn closing_the_job_ends_the_processes_in_it() {
        let job = Job::new().unwrap();
        let mut child = sleeper();
        job.assign(&child).unwrap();
        assert!(!exits_within(&mut child, Duration::from_millis(400)), "the process keeps running while the job is open");
        // What Windows does by itself when trex ends, however it ends.
        drop(job);
        assert!(exits_within(&mut child, Duration::from_secs(5)), "the process ends with the job");
    }

    #[test]
    fn the_job_kills_on_close_and_lets_a_process_leave_when_it_asks_to() {
        // Trex Browser starts its service with "break away from job" from inside an assistant;
        // Windows refuses that launch unless the job allows it.
        let job = Job::new().unwrap();
        assert_eq!(job.limit_flags().unwrap() & (KILL_ON_JOB_CLOSE | BREAKAWAY_OK), KILL_ON_JOB_CLOSE | BREAKAWAY_OK);
    }

    #[test]
    fn a_process_started_by_a_member_ends_with_the_job_too() {
        let job = Job::new().unwrap();
        // cmd waits a moment and only then starts the long ping, so the grandchild is born inside the job.
        let mut shell = Command::new("cmd").args(["/c", "ping -n 2 127.0.0.1 >NUL & ping -n 60 127.0.0.1 >NUL"]).creation_flags(NO_WINDOW)
            .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap();
        job.assign(&shell).unwrap();
        // The grandchild inherits the pipe: it reads end-of-file only when every process holding it is gone.
        let mut output = shell.stdout.take().unwrap();
        std::thread::sleep(Duration::from_millis(1800));
        drop(job);
        assert!(exits_within(&mut shell, Duration::from_secs(5)));
        let started = Instant::now();
        let mut rest = Vec::new();
        std::io::Read::read_to_end(&mut output, &mut rest).unwrap();
        assert!(started.elapsed() < Duration::from_secs(5), "the long ping started by cmd was ended as well");
    }
}
