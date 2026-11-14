# Licencias de dependencias

> Archivo generado con `node scripts/third-party-licenses.mjs`. No lo edites a mano:
> vuelve a generarlo antes de cada release. Los componentes que se redistribuyen
> aparte (Node, Electron, Playwright, ffmpeg…) están en
> [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md).

Una dependencia con varias licencias («`A OR B`») se puede usar con cualquiera de ellas.
Los Cargo.lock incluyen los paquetes de todas las plataformas, así que esta lista es
un máximo: cada instalador lleva solo una parte.

## Requieren atención

- cssparser (MPL-2.0)
- cssparser-macros (MPL-2.0)
- dtoa-short (MPL-2.0)
- option-ext (MPL-2.0)
- selectors (MPL-2.0)

## Rust (649 crates de crates.io)

| Licencia | Paquetes | Lista |
|---|---:|---|
| `Apache-2.0 OR MIT` | 357 | `aes`, `android_system_properties`, `annotate-snippets`, `anstream`, `anstyle`, `anstyle-parse`, `anstyle-query`, `anstyle-wincon`, `anyhow`, `arbitrary`, `arboard`, `async-broadcast`, `async-channel`, `async-executor`, `async-io`, `async-lock`, `async-process`, `async-recursion`, `async-signal`, `async-task`, `async-trait`, `atomic-waker`, `autocfg`, `base64`, `bit-set`, `bit-vec`, `bitflags`, `block-buffer`, `block-padding`, `blocking`, `bs58`, `bstr`, `bumpalo`, `bzip2`, `bzip2-sys`, `camino`, `cargo-platform`, `cargo_toml`, `cbc`, `cc`, `cesu8`, `cexpr`, `cfg-expr`, `cfg-if`, `chacha20`, `chrono`, `cipher`, `clap`, `clap_builder`, `clap_derive`, `clap_lex`, `cmake`, `cmov`, `colorchoice`, `concurrent-queue`, `const-oid`, `cookie`, `core-foundation`, `core-foundation-sys`, `core-graphics`, `core-graphics-types`, `cpubits`, `cpufeatures`, `crc32fast`, `crossbeam-channel`, `crossbeam-deque`, `crossbeam-epoch`, `crossbeam-utils`, `crypto-common`, `ctor`, `ctutils`, `dbus`, `dbus-secret-service`, `defmt`, `defmt-macros`, `defmt-parser`, `deranged`, `derive_arbitrary`, `diffy`, `digest`, `dirs`, `dirs-sys`, `displaydoc`, `downcast-rs`, `dtoa`, `dyn-clone`, `either`, `embed_plist`, `enumflags2`, `enumflags2_derive`, `equivalent`, `erased-serde`, `errno`, `event-listener`, `event-listener-strategy`, `fastrand`, `fd-lock`, `fdeflate`, `field-offset`, `filetime`, `find-msvc-tools`, `fixedbitset`, `flate2`, `fnv`, `foreign-types`, `foreign-types-macros`, `foreign-types-shared`, `form_urlencoded`, `fs2`, `futures-channel`, `futures-core`, `futures-executor`, `futures-io`, `futures-lite`, `futures-macro`, `futures-sink`, `futures-task`, `futures-util`, `getrandom`, `gif`, `glob`, `half`, `hashbrown`, `heck`, `hermit-abi`, `hex`, `hkdf`, `hmac`, `home`, `html5ever`, `http`, `httparse`, `httpdate`, `hybrid-array`, `iana-time-zone`, `iana-time-zone-haiku`, `ident_case`, `idna`, `idna_adapter`, `image`, `image-webp`, `indexmap`, `inout`, `ipnet`, `is_terminal_polyfill`, `itertools`, `itoa`, `jni`, `jni-macros`, `jni-sys`, `jni-sys-macros`, `jobserver`, `js-sys`, `json-patch`, `jsonptr`, `keyboard-types`, `keyring`, `khronos-egl`, `lazy_static`, `libappindicator`, `libappindicator-sys`, `libc`, `libdbus-sys`, `lock_api`, `log`, `mac-notification-sys`, `markup5ever`, `memmap2`, `mime`, `minimal-lexical`, `muda`, `ndk`, `ndk-context`, `ndk-sys`, `notify-rust`, `num`, `num-bigint`, `num-complex`, `num-conv`, `num-integer`, `num-iter`, `num-rational`, `num-traits`, `once_cell`, `once_cell_polyfill`, `openssl-macros`, `openssl-probe`, `openssl-src`, `ordered-stream`, `parking`, `parking_lot`, `parking_lot_core`, `pbkdf2`, `percent-encoding`, `petgraph`, `pin-project-lite`, `piper`, `pkg-config`, `png`, `polling`, `portable-atomic`, `portable-atomic-util`, `powerfmt`, `ppv-lite86`, `proc-macro-crate`, `proc-macro-error`, `proc-macro-error-attr`, `proc-macro2`, `qrcode`, `quick-error`, `quinn`, `quinn-proto`, `quinn-udp`, `quote`, `rand`, `rand_chacha`, `rand_core`, `rand_pcg`, `ref-cast`, `ref-cast-impl`, `regex`, `regex-automata`, `regex-syntax`, `reqwest`, `rustc-hash`, `rustc_version`, `rustls-pki-types`, `rustls-platform-verifier`, `rustls-platform-verifier-android`, `rustversion`, `scoped-tls`, `scopeguard`, `secret-service`, `security-framework`, `security-framework-sys`, `semver`, `serde`, `serde-untagged`, `serde_core`, `serde_derive`, `serde_derive_internals`, `serde_json`, `serde_path_to_error`, `serde_repr`, `serde_spanned`, `serde_urlencoded`, `serde_with`, `serde_with_macros`, `serialize-to-javascript`, `serialize-to-javascript-impl`, `servo_arc`, `sha1`, `sha2`, `shared_library`, `shell-words`, `shlex`, `signal-hook-registry`, `simd_cesu8`, `simdutf8`, `siphasher`, `smallvec`, `socket2`, `softbuffer`, `stable_deref_trait`, `static_assertions`, `string_cache`, `string_cache_codegen`, `swift-rs`, `syn`, `system-deps`, `tao-macros`, `tar`, `tauri`, `tauri-build`, `tauri-codegen`, `tauri-macros`, `tauri-plugin`, `tauri-plugin-clipboard-manager`, `tauri-plugin-dialog`, `tauri-plugin-fs`, `tauri-plugin-notification`, `tauri-plugin-opener`, `tauri-runtime`, `tauri-runtime-wry`, `tauri-utils`, `tauri-winrt-notification`, `tempfile`, `tendril`, `thiserror`, `thiserror-impl`, `time`, `time-core`, `time-macros`, `tokio-rustls`, `toml`, `toml_datetime`, `toml_edit`, `toml_parser`, `toml_writer`, `tray-icon`, `tungstenite`, `typed-path`, `typeid`, `typenum`, `unicode-segmentation`, `unicode-width`, `ureq`, `url`, `utf8_iter`, `utf8parse`, `uuid`, `vcpkg`, `version_check`, `wasm-bindgen`, `wasm-bindgen-futures`, `wasm-bindgen-macro`, `wasm-bindgen-macro-support`, `wasm-bindgen-shared`, `wasm-streams`, `web-sys`, `web-time`, `web_atoms`, `weezl`, `widestring`, `winapi`, `winapi-i686-pc-windows-gnu`, `winapi-x86_64-pc-windows-gnu`, `window-vibrancy`, `windows`, `windows-collections`, `windows-core`, `windows-future`, `windows-implement`, `windows-interface`, `windows-link`, `windows-numerics`, `windows-result`, `windows-strings`, `windows-sys`, `windows-targets`, `windows-threading`, `windows-version`, `windows_aarch64_gnullvm`, `windows_aarch64_msvc`, `windows_i686_gnu`, `windows_i686_gnullvm`, `windows_i686_msvc`, `windows_x86_64_gnu`, `windows_x86_64_gnullvm`, `windows_x86_64_msvc`, `wl-clipboard-rs`, `wry`, `x11rb`, `x11rb-protocol`, `xattr`, `zeroize`, `zeroize_derive` |
| `MIT` | 160 | `ashpd`, `atk`, `atk-sys`, `axum`, `axum-core`, `block2`, `bytes`, `cairo-rs`, `cairo-sys-rs`, `cargo_metadata`, `cfb`, `cfg_aliases`, `color_quant`, `combine`, `cookie-factory`, `crunchy`, `darling`, `darling_core`, `darling_macro`, `data-encoding`, `deflate64`, `derive_more`, `derive_more-impl`, `dlib`, `dlopen2`, `dlopen2_derive`, `dom_query`, `drm`, `drm-ffi`, `drm-fourcc`, `drm-sys`, `embed-resource`, `endi`, `endian-type`, `enigo`, `fax`, `filedescriptor`, `fs_extra`, `gbm`, `gbm-sys`, `gdk`, `gdk-pixbuf`, `gdk-pixbuf-sys`, `gdk-sys`, `gdkwayland-sys`, `gdkx11`, `gdkx11-sys`, `generic-array`, `gio`, `gio-sys`, `glib`, `glib-macros`, `glib-sys`, `gobject-sys`, `gtk`, `gtk-sys`, `gtk3-macros`, `http-body`, `http-body-util`, `hyper`, `hyper-util`, `ico`, `infer`, `is-docker`, `is-wsl`, `javascriptcore-rs`, `javascriptcore-rs-sys`, `libredox`, `libspa`, `libspa-sys`, `memoffset`, `mio`, `new_debug_unreachable`, `nibble_vec`, `nix`, `nom`, `nu-ansi-term`, `objc2`, `objc2-encode`, `objc2-foundation`, `open`, `openssl-sys`, `os_pipe`, `pango`, `pango-sys`, `phf`, `phf_codegen`, `phf_generator`, `phf_macros`, `phf_shared`, `pipewire`, `pipewire-sys`, `plist`, `portable-pty`, `precomputed-hash`, `quick-xml`, `radix_trie`, `redox_syscall`, `redox_users`, `rfd`, `rustyline`, `schannel`, `schemars`, `schemars_derive`, `simd-adler32`, `slab`, `soup3`, `soup3-sys`, `strsim`, `synstructure`, `tauri-winres`, `tiff`, `tokio`, `tokio-macros`, `tokio-tungstenite`, `tokio-util`, `tower`, `tower-http`, `tower-layer`, `tower-service`, `tracing`, `tracing-attributes`, `tracing-core`, `tree_magic_mini`, `try-lock`, `uds_windows`, `urlpattern`, `version-compare`, `vswhom`, `vswhom-sys`, `want`, `wayland-backend`, `wayland-client`, `wayland-protocols`, `wayland-protocols-wlr`, `wayland-scanner`, `wayland-server`, `wayland-sys`, `webkit2gtk`, `webkit2gtk-sys`, `webview2-com`, `webview2-com-macros`, `webview2-com-sys`, `winnow`, `winreg`, `x11`, `x11-dl`, `xcb`, `xdg-home`, `xkbcommon`, `xml-rs`, `zbus`, `zbus_macros`, `zbus_names`, `zcheapstr`, `zip`, `zmij`, `zvariant`, `zvariant_derive`, `zvariant_utils` |
| `Apache-2.0 OR MIT OR Zlib` | 33 | `bytemuck`, `bytemuck_derive`, `dispatch2`, `lru-slab`, `miniz_oxide`, `objc2-app-kit`, `objc2-av-foundation`, `objc2-avf-audio`, `objc2-cloud-kit`, `objc2-core-audio`, `objc2-core-audio-types`, `objc2-core-data`, `objc2-core-foundation`, `objc2-core-graphics`, `objc2-core-image`, `objc2-core-location`, `objc2-core-media`, `objc2-core-text`, `objc2-core-video`, `objc2-exception-helper`, `objc2-image-io`, `objc2-io-surface`, `objc2-media-toolbox`, `objc2-metal`, `objc2-quartz-core`, `objc2-ui-kit`, `objc2-user-notifications`, `objc2-web-kit`, `raw-window-handle`, `tinyvec`, `xkeysym`, `zune-core`, `zune-jpeg` |
| `Unicode-3.0` | 18 | `icu_collections`, `icu_locale_core`, `icu_normalizer`, `icu_normalizer_data`, `icu_properties`, `icu_properties_data`, `icu_provider`, `litemap`, `potential_utf`, `tinystr`, `writeable`, `yoke`, `yoke-derive`, `zerofrom`, `zerofrom-derive`, `zerotrie`, `zerovec`, `zerovec-derive` |
| `MIT OR Unlicense` | 14 | `aho-corasick`, `byteorder`, `byteorder-lite`, `globset`, `ignore`, `jiff`, `jiff-core`, `jiff-static`, `jiff-tzdb`, `jiff-tzdb-platform`, `memchr`, `same-file`, `walkdir`, `winapi-util` |
| `Apache-2.0` | 13 | `clang-sys`, `gethostname`, `gl`, `gl_generator`, `khronos_api`, `lzma-rust2`, `openssl`, `sherpa-onnx`, `sherpa-onnx-sys`, `sync_wrapper`, `tao`, `xcap`, `zopfli` |
| `BSD-3-Clause` | 6 | `alloc-no-stdlib`, `alloc-stdlib`, `bindgen`, `subtle`, `zstd`, `zstd-safe` |
| `Apache-2.0 OR MIT OR Apache-2.0 WITH LLVM-exception` | 5 | `linux-raw-sys`, `rustix`, `wasi`, `wasip2`, `wit-bindgen` |
| `MPL-2.0` | 5 | `cssparser`, `cssparser-macros`, `dtoa-short`, `option-ext`, `selectors` |
| `Apache-2.0 OR ISC OR MIT` | 3 | `hyper-rustls`, `rustls`, `rustls-native-certs` |
| `ISC` | 3 | `libloading`, `rustls-webpki`, `untrusted` |
| `Apache-2.0 OR BSD-2-Clause OR MIT` | 2 | `zerocopy`, `zerocopy-derive` |
| `Apache-2.0 OR BSD-3-Clause` | 2 | `moxcms`, `pxfm` |
| `Apache-2.0 OR BSD-3-Clause OR MIT` | 2 | `num_enum`, `num_enum_derive` |
| `Apache-2.0 OR CC0-1.0 OR MIT-0` | 2 | `constant_time_eq`, `dunce` |
| `BSD-3-Clause AND MIT` | 2 | `brotli`, `matchit` |
| `BSD-3-Clause OR MIT` | 2 | `brotli-decompressor`, `if-addrs` |
| `BSL-1.0` | 2 | `clipboard-win`, `error-code` |
| `CDLA-Permissive-2.0` | 2 | `webpki-root-certs`, `webpki-roots` |
| `Zlib` | 2 | `foldhash`, `zlib-rs` |
| `0BSD OR Apache-2.0 OR MIT` | 1 | `adler2` |
| `Apache-2.0 AND BSD-3-Clause AND ISC AND MIT AND (Apache-2.0 OR ISC) AND (Apache-2.0 OR ISC OR MIT) AND (Apache-2.0 OR ISC OR MIT-0)` | 1 | `aws-lc-sys` |
| `Apache-2.0 AND ISC` | 1 | `ring` |
| `Apache-2.0 AND MIT` | 1 | `dpi` |
| `Apache-2.0 OR BSD-2-Clause` | 1 | `serial2` |
| `Apache-2.0 OR BSL-1.0` | 1 | `ryu` |
| `Apache-2.0 OR LGPL-2.1-or-later OR MIT` | 1 | `r-efi` |
| `Apache-2.0 WITH LLVM-exception` | 1 | `target-lexicon` |
| `BSD-2-Clause` | 1 | `libwayshot-xcap` |
| `BSD-2-Clause AND BSD-3-Clause` | 1 | `zstd-sys` |
| `bzip2-1.0.6` | 1 | `libbz2-rs-sys` |
| `CC0-1.0 OR MIT-0` | 1 | `ppmd-rust` |
| `ISC AND (Apache-2.0 OR ISC)` | 1 | `aws-lc-rs` |
| `Unicode-3.0 AND (Apache-2.0 OR MIT)` | 1 | `unicode-ident` |

## npm — Interfaz (React, xterm.js y fuentes) (124 paquetes)

| Licencia | Paquetes | Lista |
|---|---:|---|
| `MIT` | 115 | `@types/debug`, `@types/estree`, `@types/estree-jsx`, `@types/hast`, `@types/mdast`, `@types/ms`, `@types/react`, `@types/unist`, `@xterm/addon-fit`, `@xterm/addon-search`, `@xterm/addon-unicode-graphemes`, `@xterm/addon-web-links`, `@xterm/addon-webgl`, `@xterm/xterm`, `bail`, `ccount`, `character-entities`, `character-entities-html4`, `character-entities-legacy`, `character-reference-invalid`, `comma-separated-tokens`, `csstype`, `debug`, `decode-named-character-reference`, `dequal`, `devlop`, `escape-string-regexp`, `estree-util-is-identifier-name`, `extend`, `hast-util-is-element`, `hast-util-to-jsx-runtime`, `hast-util-to-text`, `hast-util-whitespace`, `html-url-attributes`, `inline-style-parser`, `is-alphabetical`, `is-alphanumerical`, `is-decimal`, `is-hexadecimal`, `is-plain-obj`, `longest-streak`, `lowlight`, `markdown-table`, `mdast-util-find-and-replace`, `mdast-util-from-markdown`, `mdast-util-gfm`, `mdast-util-gfm-autolink-literal`, `mdast-util-gfm-footnote`, `mdast-util-gfm-strikethrough`, `mdast-util-gfm-table`, `mdast-util-gfm-task-list-item`, `mdast-util-mdx-expression`, `mdast-util-mdx-jsx`, `mdast-util-mdxjs-esm`, `mdast-util-phrasing`, `mdast-util-to-hast`, `mdast-util-to-markdown`, `mdast-util-to-string`, `micromark`, `micromark-core-commonmark`, `micromark-extension-gfm`, `micromark-extension-gfm-autolink-literal`, `micromark-extension-gfm-footnote`, `micromark-extension-gfm-strikethrough`, `micromark-extension-gfm-table`, `micromark-extension-gfm-tagfilter`, `micromark-extension-gfm-task-list-item`, `micromark-factory-destination`, `micromark-factory-label`, `micromark-factory-space`, `micromark-factory-title`, `micromark-factory-whitespace`, `micromark-util-character`, `micromark-util-chunked`, `micromark-util-classify-character`, `micromark-util-combine-extensions`, `micromark-util-decode-numeric-character-reference`, `micromark-util-decode-string`, `micromark-util-edit-map`, `micromark-util-encode`, `micromark-util-html-tag-name`, `micromark-util-normalize-identifier`, `micromark-util-resolve-all`, `micromark-util-sanitize-uri`, `micromark-util-subtokenize`, `micromark-util-symbol`, `micromark-util-types`, `ms`, `parse-entities`, `property-information`, `react`, `react-dom`, `react-markdown`, `rehype-highlight`, `remark-gfm`, `remark-parse`, `remark-rehype`, `remark-stringify`, `scheduler`, `space-separated-tokens`, `stringify-entities`, `style-to-js`, `style-to-object`, `trim-lines`, `trough`, `unified`, `unist-util-find-after`, `unist-util-is`, `unist-util-position`, `unist-util-stringify-position`, `unist-util-visit`, `unist-util-visit-parents`, `vfile`, `vfile-message`, `zwitch` |
| `MIT OR Apache-2.0` | 3 | `@tauri-apps/plugin-dialog`, `@tauri-apps/plugin-notification`, `@tauri-apps/plugin-opener` |
| `OFL-1.1` | 3 | `@fontsource-variable/ibm-plex-sans`, `@fontsource-variable/jetbrains-mono`, `@fontsource/ibm-plex-mono` |
| `Apache-2.0 OR MIT` | 1 | `@tauri-apps/api` |
| `BSD-3-Clause` | 1 | `highlight.js` |
| `ISC` | 1 | `@ungap/structured-clone` |

## npm — Trex Browser: worker (2 paquetes)

| Licencia | Paquetes | Lista |
|---|---:|---|
| `Apache-2.0` | 2 | `playwright`, `playwright-core` |
