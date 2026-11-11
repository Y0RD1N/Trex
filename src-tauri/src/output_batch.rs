// Agrupa la salida de los procesos antes de enviarla a la ventana.
//
// Cada entrega a la página cuesta lo mismo sea grande o pequeña: un `eval` de JavaScript en el
// hilo principal de la ventana, un mensaje entre procesos y su decodificación en la página.
//   - Un asistente con `--include-partial-messages` escribe una línea por fragmento de texto
//     (decenas por segundo), y el frontend solo pinta cada 50 ms (`lineBatch.ts`).
//   - Una terminal con salida continua (una compilación, un `cat`) entrega lecturas de la PTY sin
//     parar, y xterm solo pinta una vez por fotograma.
// Aquí lo primero que llega tras un silencio sale al momento (la latencia al escribir o al
// empezar una respuesta no cambia) y lo que llega seguido se junta en tandas de `window` como
// mucho, o antes si la tanda alcanza `max_len` elementos.
//
// El orden se conserva: todo se entrega con el cerrojo tomado, y `flush_then`/`close_then` (antes
// de un aviso de stderr o del cierre) vacían lo pendiente antes de lo que viene detrás.
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

type Sink<T> = Box<dyn Fn(Vec<T>) + Send + Sync>;

struct State<T> {
    pending: Vec<T>,
    last_emit: Option<Instant>,
    closed: bool,
}

struct Shared<T> {
    state: Mutex<State<T>>,
    wake: Condvar,
    sink: Sink<T>,
    window: Duration,
    max_len: usize,
}

/// Sin `Clone` a propósito: al soltarse (si el proceso no llegó a arrancar, por ejemplo) cierra
/// el hilo de vaciado después de entregar lo pendiente.
pub struct OutputBatcher<T: Send + 'static>(Arc<Shared<T>>);

/// Líneas de stdout de un asistente.
pub type LineBatcher = OutputBatcher<String>;

impl<T: Send + 'static> Drop for OutputBatcher<T> {
    fn drop(&mut self) {
        if let Ok(mut state) = self.0.state.lock() {
            state.closed = true;
        }
        self.0.wake.notify_all();
    }
}

impl<T: Send + 'static> OutputBatcher<T> {
    /// Crea el agrupador y su hilo de vaciado (`name`); el hilo termina al cerrarlo o soltarlo.
    pub fn new(name: &str, window: Duration, max_len: usize, sink: impl Fn(Vec<T>) + Send + Sync + 'static) -> Self {
        let shared = Arc::new(Shared {
            state: Mutex::new(State { pending: Vec::new(), last_emit: None, closed: false }),
            wake: Condvar::new(),
            sink: Box::new(sink),
            window,
            max_len: max_len.max(1),
        });
        let worker = shared.clone();
        thread::Builder::new()
            .name(name.into())
            .spawn(move || run(&worker))
            .expect("no se pudo crear el hilo de salida");
        OutputBatcher(shared)
    }

    pub fn push(&self, item: T) {
        self.add(|pending| pending.push(item));
    }

    fn add(&self, append: impl FnOnce(&mut Vec<T>)) {
        let shared = &self.0;
        let Ok(mut state) = shared.state.lock() else { return };
        if state.closed {
            return;
        }
        let was_empty = state.pending.is_empty();
        append(&mut state.pending);
        let idle = state.last_emit.map_or(true, |at| at.elapsed() >= shared.window);
        if (idle && was_empty) || state.pending.len() >= shared.max_len {
            // Tras un silencio no se espera; una tanda llena tampoco.
            emit(shared, &mut state);
        } else {
            shared.wake.notify_one();
        }
    }

    /// Entrega ya lo pendiente y ejecuta `then` sin soltar el cerrojo (lo que venga detrás no se adelanta).
    pub fn flush_then(&self, then: impl FnOnce()) {
        let shared = &self.0;
        let Ok(mut state) = shared.state.lock() else { return then() };
        if !state.pending.is_empty() {
            emit(shared, &mut state);
        }
        then();
    }

    /// Entrega lo pendiente, ejecuta `then` y termina el hilo de vaciado.
    pub fn close_then(&self, then: impl FnOnce()) {
        let shared = &self.0;
        let Ok(mut state) = shared.state.lock() else { return then() };
        if !state.pending.is_empty() {
            emit(shared, &mut state);
        }
        state.closed = true;
        then();
        shared.wake.notify_all();
    }
}

impl<T: Copy + Send + 'static> OutputBatcher<T> {
    /// Añade varios elementos de una vez (los bytes de una lectura de la PTY).
    pub fn extend(&self, items: &[T]) {
        if !items.is_empty() {
            self.add(|pending| pending.extend_from_slice(items));
        }
    }
}

fn emit<T>(shared: &Shared<T>, state: &mut State<T>) {
    let items = std::mem::take(&mut state.pending);
    state.last_emit = Some(Instant::now());
    (shared.sink)(items);
}

fn run<T>(shared: &Shared<T>) {
    let Ok(mut state) = shared.state.lock() else { return };
    loop {
        if state.pending.is_empty() {
            if state.closed {
                return;
            }
            state = match shared.wake.wait(state) {
                Ok(state) => state,
                Err(_) => return,
            };
            continue;
        }
        let due = state.last_emit.map_or_else(Instant::now, |at| at + shared.window);
        let now = Instant::now();
        if now >= due {
            emit(shared, &mut state);
        } else {
            state = match shared.wake.wait_timeout(state, due - now) {
                Ok((state, _)) => state,
                Err(_) => return,
            };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    fn batcher<T: Send + 'static>(window_ms: u64, max_len: usize) -> (OutputBatcher<T>, mpsc::Receiver<Vec<T>>) {
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        (OutputBatcher::new("test-output", Duration::from_millis(window_ms), max_len, move |items| { let _ = tx.lock().unwrap().send(items); }), rx)
    }

    #[test]
    fn the_first_line_after_silence_is_not_delayed() {
        let (lines, rx) = batcher::<String>(200, usize::MAX);
        let start = Instant::now();
        lines.push("a".into());
        assert_eq!(rx.recv_timeout(Duration::from_millis(100)).unwrap(), vec!["a"]);
        assert!(start.elapsed() < Duration::from_millis(100));
    }

    #[test]
    fn lines_that_arrive_together_are_delivered_together_and_in_order() {
        let (lines, rx) = batcher::<String>(40, usize::MAX);
        lines.push("1".into());
        assert_eq!(rx.recv_timeout(Duration::from_secs(1)).unwrap(), vec!["1"]);
        for n in 2..=50 {
            lines.push(n.to_string());
        }
        let mut seen = vec!["1".to_string()];
        let mut deliveries = 1;
        while seen.len() < 50 {
            seen.extend(rx.recv_timeout(Duration::from_secs(1)).unwrap());
            deliveries += 1;
        }
        assert_eq!(seen, (1..=50).map(|n| n.to_string()).collect::<Vec<_>>());
        assert!(deliveries <= 3, "{deliveries} entregas");
    }

    #[test]
    fn flush_and_close_keep_what_follows_behind_the_pending_lines() {
        let (lines, rx) = batcher::<String>(1000, usize::MAX);
        let (order_tx, order_rx) = mpsc::channel();
        lines.push("a".into());
        lines.push("b".into());
        let tx = order_tx.clone();
        lines.flush_then(move || tx.send("stderr").unwrap());
        lines.push("c".into());
        lines.close_then(move || order_tx.send("exit").unwrap());
        assert_eq!(rx.recv().unwrap(), vec!["a"]);
        assert_eq!(rx.recv().unwrap(), vec!["b"]);
        assert_eq!(order_rx.recv().unwrap(), "stderr");
        assert_eq!(rx.recv().unwrap(), vec!["c"]);
        assert_eq!(order_rx.recv().unwrap(), "exit");
        lines.push("tarde".into());
        assert!(rx.recv_timeout(Duration::from_millis(50)).is_err());
    }

    #[test]
    fn dropping_the_batcher_delivers_the_rest_and_ends_the_thread() {
        let (lines, rx) = batcher::<String>(1000, usize::MAX);
        lines.push("a".into());
        lines.push("b".into());
        drop(lines);
        assert_eq!(rx.recv_timeout(Duration::from_secs(1)).unwrap(), vec!["a"]);
        assert_eq!(rx.recv_timeout(Duration::from_secs(2)).unwrap(), vec!["b"]);
        // El emisor se soltó con el hilo: el canal se cierra.
        assert!(rx.recv_timeout(Duration::from_secs(2)).is_err());
    }

    #[test]
    fn bytes_are_joined_in_order_and_a_full_batch_does_not_wait() {
        let (bytes, rx) = batcher::<u8>(1000, 8);
        bytes.extend(b"ab");
        assert_eq!(rx.recv_timeout(Duration::from_millis(100)).unwrap(), b"ab");
        bytes.extend(b"cd");
        bytes.extend(b"ef");
        assert!(rx.recv_timeout(Duration::from_millis(50)).is_err(), "dentro de la ventana se acumula");
        bytes.extend(b"ghij");
        // Llega a 8: sale sin esperar a la ventana.
        assert_eq!(rx.recv_timeout(Duration::from_millis(100)).unwrap(), b"cdefghij");
    }
}
