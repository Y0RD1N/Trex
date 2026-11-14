fn main() {
    // Modo llamada: sus bibliotecas (sherpa-onnx y onnxruntime) se cargan solo
    // al usarlas. Así trex arranca aunque falten junto al ejecutable, y la voz
    // avisa de que no está disponible en vez de impedir abrir la app.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        println!("cargo:rustc-link-arg=/DELAYLOAD:sherpa-onnx-c-api.dll");
        println!("cargo:rustc-link-lib=delayimp");
    }
    tauri_build::build()
}
