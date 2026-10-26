# Strict evidence decoding

Source: jpeg-decoder 0.3.2, https://crates.io/crates/jpeg-decoder/0.3.2 (image-rs, MIT OR Apache-2.0). Original source and license notices are retained.

The upstream entropy reader deliberately pads a completed scan with synthetic zero bits. Trex uses this copy only to validate JPEG evidence before storage/replay. The local change in `src/huffman.rs` tracks real buffered bits and rejects a scan if coefficient decoding consumed synthesized padding. Read-ahead and unused padding do not fail valid files. Decoder output remains subject to the caller's dimension, pixel and allocation limits.

Regression coverage lives in `tests/browser_cases/mod.rs`: valid baseline/progressive images, missing and partially truncated scans, and hash-correct malformed artifacts after restart. The actual image renderer continues to use the image crate.
