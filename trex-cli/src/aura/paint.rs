//! Dibujo del aura sin GDI: píxeles BGRA premultiplicados, que es lo que pide
//! `UpdateLayeredWindow`. Cada forma se pinta por su distancia al trazo, con
//! medio píxel de suavizado, así que no depende de ninguna biblioteca gráfica y
//! se puede probar en cualquier sistema.
use std::f32::consts::{FRAC_PI_2, PI};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rgb(pub u8, pub u8, pub u8);

impl Rgb {
    /// `#rrggbb` (el formato del acento en Ajustes).
    pub fn parse(text: &str) -> Option<Self> {
        let hex = text.trim().strip_prefix('#')?;
        if hex.len() != 6 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return None;
        }
        let value = u32::from_str_radix(hex, 16).ok()?;
        Some(Self((value >> 16) as u8, (value >> 8) as u8, value as u8))
    }

    /// `amount` de este color y el resto de `other`.
    pub fn mix(self, other: Self, amount: f32) -> Self {
        let channel = |a: u8, b: u8| (f32::from(a) * amount + f32::from(b) * (1.0 - amount)).round().clamp(0.0, 255.0) as u8;
        Self(channel(self.0, other.0), channel(self.1, other.1), channel(self.2, other.2))
    }
}

const BLACK: Rgb = Rgb(0, 0, 0);
const WHITE: Rgb = Rgb(255, 255, 255);
const GREY: Rgb = Rgb(0x8d, 0x8d, 0x8d);

/// Los colores del aura, todos sacados del acento de Ajustes.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Palette {
    pub accent: Rgb,
    /// Contorno oscuro bajo cada trazo: lo que lo sostiene sobre fondos claros.
    pub keyline: Rgb,
    pub keyline_alpha: f32,
    /// El acento apagado, cuando trex espera a que la persona termine.
    pub idle: Rgb,
    /// Texto sobre el acento.
    pub ink: Rgb,
    /// Texto y fondo de la etiqueta del visor.
    pub label_text: Rgb,
    pub label_back: Rgb,
}

impl Palette {
    pub fn from_accent(accent: Rgb) -> Self {
        Self {
            accent,
            keyline: accent.mix(BLACK, 0.3),
            keyline_alpha: 0.75,
            idle: accent.mix(GREY, 0.35),
            ink: Rgb(0x17, 0x14, 0x0f),
            label_text: accent.mix(WHITE, 0.82),
            label_back: Rgb(14, 13, 12),
        }
    }
}

/// Un lienzo sobre memoria ajena (la de un DIB, o un `Vec` en las pruebas).
pub struct Canvas<'a> {
    pub width: usize,
    pub height: usize,
    pub pixels: &'a mut [u32],
}

impl Canvas<'_> {
    pub fn clear(&mut self) {
        self.pixels.fill(0);
    }

    /// Mezcla un color con la cobertura dada (fuente sobre destino, premultiplicado).
    #[inline]
    pub fn blend(&mut self, x: usize, y: usize, color: Rgb, alpha: f32) {
        if alpha <= 0.0 || x >= self.width || y >= self.height {
            return;
        }
        let alpha = alpha.min(1.0);
        let index = y * self.width + x;
        let below = self.pixels[index];
        let keep = 1.0 - alpha;
        let channel = |shift: u32, source: u8| -> u32 {
            let under = ((below >> shift) & 0xff) as f32;
            (f32::from(source) * alpha + under * keep).round().min(255.0) as u32
        };
        let opacity = (alpha * 255.0 + ((below >> 24) & 0xff) as f32 * keep).round().min(255.0) as u32;
        self.pixels[index] = (opacity << 24) | (channel(16, color.0) << 16) | (channel(8, color.1) << 8) | channel(0, color.2);
    }

    /// Recorre `area` (izquierda, arriba, derecha, abajo; recortada al lienzo) y
    /// pinta cada píxel con la cobertura que devuelve `coverage` para su centro.
    pub fn shade(&mut self, area: [f32; 4], color: Rgb, alpha: f32, coverage: impl Fn(f32, f32) -> f32) {
        let (x0, y0, x1, y1) = self.clip(area);
        for y in y0..y1 {
            let py = y as f32 + 0.5;
            for x in x0..x1 {
                let amount = coverage(x as f32 + 0.5, py);
                if amount > 0.0 {
                    self.blend(x, y, color, alpha * amount);
                }
            }
        }
    }

    fn clip(&self, area: [f32; 4]) -> (usize, usize, usize, usize) {
        let low = |value: f32, limit: usize| (value.floor().max(0.0) as usize).min(limit);
        (low(area[0], self.width), low(area[1], self.height), low(area[2].ceil(), self.width), low(area[3].ceil(), self.height))
    }

    /// Un rectángulo redondeado relleno.
    pub fn fill_box(&mut self, area: [f32; 4], radius: f32, color: Rgb, alpha: f32) {
        self.shade(area, color, alpha, |x, y| box_coverage(x, y, area, radius));
    }
}

/// Cobertura de un trazo de medio ancho `half` a `distance` de su eje.
#[inline]
pub fn stroke(distance: f32, half: f32) -> f32 {
    (half + 0.5 - distance).clamp(0.0, 1.0)
}

/// Cobertura de un rectángulo redondeado relleno.
pub fn box_coverage(x: f32, y: f32, area: [f32; 4], radius: f32) -> f32 {
    let (cx, cy) = ((area[0] + area[2]) / 2.0, (area[1] + area[3]) / 2.0);
    let (hx, hy) = ((area[2] - area[0]) / 2.0, (area[3] - area[1]) / 2.0);
    let radius = radius.min(hx).min(hy).max(0.0);
    let (qx, qy) = ((x - cx).abs() - hx + radius, (y - cy).abs() - hy + radius);
    let outside = qx.max(0.0).hypot(qy.max(0.0)) + qx.max(qy).min(0.0) - radius;
    (0.5 - outside).clamp(0.0, 1.0)
}

#[inline]
fn segment_distance(px: f32, py: f32, a: (f32, f32), b: (f32, f32)) -> f32 {
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let length = dx * dx + dy * dy;
    let t = if length > 0.0 { (((px - a.0) * dx + (py - a.1) * dy) / length).clamp(0.0, 1.0) } else { 0.0 };
    (px - a.0 - t * dx).hypot(py - a.1 - t * dy)
}

/// Un rectángulo redondeado visto como recorrido: para cada punto, a qué distancia
/// está del borde y en qué lugar de la vuelta (desde el final del arco de arriba a
/// la izquierda, en el sentido de las agujas del reloj).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Track {
    pub left: f32,
    pub top: f32,
    pub right: f32,
    pub bottom: f32,
    pub radius: f32,
}

impl Track {
    fn radius(&self) -> f32 {
        self.radius.min((self.right - self.left) / 2.0).min((self.bottom - self.top) / 2.0).max(0.0)
    }

    pub fn length(&self) -> f32 {
        let radius = self.radius();
        2.0 * (self.right - self.left - 2.0 * radius) + 2.0 * (self.bottom - self.top - 2.0 * radius) + 2.0 * PI * radius
    }

    /// Distancia al recorrido y posición a lo largo de él.
    pub fn locate(&self, px: f32, py: f32) -> (f32, f32) {
        let radius = self.radius();
        let across = self.right - self.left - 2.0 * radius;
        let down = self.bottom - self.top - 2.0 * radius;
        let arc = FRAC_PI_2 * radius;
        let (inner_left, inner_right) = (self.left + radius, self.right - radius);
        let (inner_top, inner_bottom) = (self.top + radius, self.bottom - radius);
        let around = |cx: f32, cy: f32| ((px - cx).hypot(py - cy) - radius).abs();
        if px < inner_left && py < inner_top {
            let angle = (inner_top - py).atan2(inner_left - px);
            return (around(inner_left, inner_top), 2.0 * across + 2.0 * down + 3.0 * arc + angle * radius);
        }
        if px > inner_right && py < inner_top {
            let angle = (px - inner_right).atan2(inner_top - py);
            return (around(inner_right, inner_top), across + angle * radius);
        }
        if px > inner_right && py > inner_bottom {
            let angle = (py - inner_bottom).atan2(px - inner_right);
            return (around(inner_right, inner_bottom), across + arc + down + angle * radius);
        }
        if px < inner_left && py > inner_bottom {
            let angle = (inner_left - px).atan2(py - inner_bottom);
            return (around(inner_left, inner_bottom), 2.0 * across + 2.0 * arc + down + angle * radius);
        }
        let mut best = (f32::MAX, 0.0);
        let mut consider = |distance: f32, position: f32| {
            if distance < best.0 {
                best = (distance, position);
            }
        };
        if (inner_left..=inner_right).contains(&px) {
            consider((py - self.top).abs(), px - inner_left);
            consider((py - self.bottom).abs(), across + 2.0 * arc + down + (inner_right - px));
        }
        if (inner_top..=inner_bottom).contains(&py) {
            consider((px - self.right).abs(), across + arc + (py - inner_top));
            consider((px - self.left).abs(), 2.0 * across + 3.0 * arc + down + (inner_bottom - py));
        }
        best
    }
}

/// Tramos de la cinta. El periodo se ajusta para que quepa un número entero en
/// la vuelta: así no hay costura donde empieza y acaba.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Dashes {
    pub period: f32,
    pub on: f32,
}

impl Dashes {
    pub fn fit(length: f32, period: f32, on_ratio: f32) -> Self {
        let count = (length / period).round().max(1.0);
        let period = length / count;
        Self { period, on: period * on_ratio }
    }

    /// Distancia, a lo largo del recorrido, al tramo más cercano (0 dentro de uno).
    pub fn gap(&self, position: f32) -> f32 {
        let within = position.rem_euclid(self.period);
        if within <= self.on {
            0.0
        } else {
            (within - self.on).min(self.period - within)
        }
    }
}

/// Medidas de la cinta en píxeles físicos.
#[derive(Clone, Copy, Debug)]
pub struct Tape {
    pub track: Track,
    pub dashes: Dashes,
    pub line_half: f32,
    pub keyline_half: f32,
    /// Cuánto ha avanzado la cinta.
    pub phase: f32,
}

/// Lo que no cambia de un paso a otro de la cinta mientras la ventana no se
/// mueva: por cada píxel de la banda, la distancia al recorrido, su lugar en la
/// vuelta y el contorno oscuro ya mezclado. Cada paso solo calcula los tramos, y
/// los píxeles fuera de la banda no se vuelven a tocar.
pub struct TapeField {
    origin: (i32, i32),
    width: usize,
    height: usize,
    track: Track,
    dashes: Dashes,
    keyline: (Rgb, f32, f32),
    cells: Vec<Cell>,
}

#[derive(Clone, Copy)]
struct Cell {
    index: u32,
    distance: f32,
    /// Lugar en la vuelta, ya reducido al periodo de los tramos.
    offset: f32,
    base: u32,
}

impl TapeField {
    /// Si sirve para esta cinta en este lienzo.
    pub fn fits(&self, tape: &Tape, origin: (i32, i32), width: usize, height: usize, palette: &Palette) -> bool {
        self.origin == origin
            && self.width == width
            && self.height == height
            && self.track == tape.track
            && self.dashes == tape.dashes
            && self.keyline == (palette.keyline, palette.keyline_alpha, tape.keyline_half)
    }
}

/// `color` con opacidad `alpha` sobre un píxel premultiplicado.
#[inline]
fn over(below: u32, color: Rgb, alpha: f32) -> u32 {
    let keep = 1.0 - alpha;
    let channel = |shift: u32, source: u8| -> u32 { (f32::from(source) * alpha + ((below >> shift) & 0xff) as f32 * keep + 0.5) as u32 };
    let opacity = (alpha * 255.0 + ((below >> 24) & 0xff) as f32 * keep + 0.5) as u32;
    (opacity.min(255) << 24) | (channel(16, color.0).min(255) << 16) | (channel(8, color.1).min(255) << 8) | channel(0, color.2).min(255)
}

impl Tape {
    fn reach(&self) -> f32 {
        self.keyline_half.max(self.line_half) + 1.0
    }

    /// Prepara un lienzo de `width` × `height` cuya esquina está en `origin` (pantalla).
    pub fn field(&self, origin: (i32, i32), width: usize, height: usize, palette: &Palette) -> TapeField {
        let reach = self.reach();
        let mut cells = Vec::new();
        for y in 0..height {
            let py = origin.1 as f32 + y as f32 + 0.5;
            for x in 0..width {
                let px = origin.0 as f32 + x as f32 + 0.5;
                let (distance, position) = self.track.locate(px, py);
                if distance <= reach {
                    let base = over(0, palette.keyline, palette.keyline_alpha * stroke(distance, self.keyline_half));
                    cells.push(Cell { index: (y * width + x) as u32, distance, offset: position.rem_euclid(self.dashes.period), base });
                }
            }
        }
        TapeField { origin, width, height, track: self.track, dashes: self.dashes, keyline: (palette.keyline, palette.keyline_alpha, self.keyline_half), cells }
    }

    /// Pinta un paso de la cinta. Con `fresh` (lienzo nuevo o reutilizado) borra
    /// antes lo de fuera de la banda; si no, eso ya está transparente.
    pub fn paint_field(&self, field: &TapeField, canvas: &mut Canvas, line: Rgb, fresh: bool) {
        if fresh {
            canvas.clear();
        }
        let reach = self.line_half + 0.5;
        let Dashes { period, on } = field.dashes;
        let phase = self.phase.rem_euclid(period);
        for cell in &field.cells {
            let Some(pixel) = canvas.pixels.get_mut(cell.index as usize) else { continue };
            // Lo mismo que `Dashes::gap`, sin dividir en cada píxel.
            let mut within = cell.offset - phase;
            if within < 0.0 {
                within += period;
            }
            let gap = if within <= on { 0.0 } else { (within - on).min(period - within) };
            // Extremos redondos: distancia a la cápsula de cada tramo.
            *pixel = if gap >= reach {
                cell.base
            } else {
                let capsule = if gap > 0.0 { gap.hypot(cell.distance) } else { cell.distance };
                let cover = stroke(capsule, self.line_half);
                if cover > 0.0 { over(cell.base, line, cover) } else { cell.base }
            };
        }
    }

    /// Prepara y pinta de una vez (para lienzos que no se repiten).
    pub fn paint(&self, canvas: &mut Canvas, origin: (i32, i32), line: Rgb, palette: &Palette) {
        let field = self.field(origin, canvas.width, canvas.height, palette);
        self.paint_field(&field, canvas, line, true);
    }
}

/// Una esquina del visor: el punto de la esquina y hacia dónde queda el interior.
#[derive(Clone, Copy, Debug)]
pub struct Corner {
    pub x: f32,
    pub y: f32,
    pub inward_x: f32,
    pub inward_y: f32,
}

impl Corner {
    /// Distancia a la «L» redondeada de la esquina (dos brazos de `arm` y el arco de `radius`).
    pub fn distance(&self, px: f32, py: f32, radius: f32, arm: f32) -> f32 {
        let u = (px - self.x) * self.inward_x;
        let v = (py - self.y) * self.inward_y;
        let mut distance = segment_distance(u, v, (0.0, arm), (0.0, radius)).min(segment_distance(u, v, (radius, 0.0), (arm, 0.0)));
        if u <= radius && v <= radius {
            distance = distance.min(((u - radius).hypot(v - radius) - radius).abs());
        }
        distance
    }

    /// Pinta la esquina: primero el contorno oscuro y encima el acento.
    pub fn paint(&self, canvas: &mut Canvas, radius: f32, arm: f32, line_half: f32, keyline_half: f32, line: Rgb, palette: &Palette) {
        let reach = keyline_half + 1.0;
        let far = (self.x + self.inward_x * (arm + reach), self.y + self.inward_y * (arm + reach));
        let near = (self.x - self.inward_x * reach, self.y - self.inward_y * reach);
        let area = [near.0.min(far.0), near.1.min(far.1), near.0.max(far.0), near.1.max(far.1)];
        canvas.shade(area, palette.keyline, palette.keyline_alpha, |x, y| stroke(self.distance(x, y, radius, arm), keyline_half));
        canvas.shade(area, line, 1.0, |x, y| stroke(self.distance(x, y, radius, arm), line_half));
    }
}

/// La línea fina del visor alrededor de la pantalla. Solo se recorren las
/// bandas del borde: el centro de la pantalla no se toca.
pub fn paint_outline(canvas: &mut Canvas, track: &Track, half: f32, color: Rgb, alpha: f32) {
    let reach = half + 1.0;
    let band = track.radius + reach + 1.0;
    let (width, height) = (canvas.width as f32, canvas.height as f32);
    let bands = [
        [0.0, 0.0, width, track.top + band],
        [0.0, track.bottom - band, width, height],
        [0.0, track.top + band, track.left + band, track.bottom - band],
        [track.right - band, track.top + band, width, track.bottom - band],
    ];
    for area in bands {
        if area[2] > area[0] && area[3] > area[1] {
            canvas.shade(area, color, alpha, |x, y| stroke(track.locate(x, y).0, half));
        }
    }
}

/// Una onda (anillo) con su contorno oscuro.
pub fn paint_ring(canvas: &mut Canvas, center: (f32, f32), radius: f32, line_half: f32, keyline_half: f32, alpha: f32, palette: &Palette) {
    let reach = radius + keyline_half + 1.0;
    let area = [center.0 - reach, center.1 - reach, center.0 + reach, center.1 + reach];
    let distance = |x: f32, y: f32| ((x - center.0).hypot(y - center.1) - radius).abs();
    canvas.shade(area, palette.keyline, palette.keyline_alpha * alpha, |x, y| stroke(distance(x, y), keyline_half));
    canvas.shade(area, palette.accent, alpha, |x, y| stroke(distance(x, y), line_half));
}

/// Un círculo relleno.
pub fn paint_disc(canvas: &mut Canvas, center: (f32, f32), radius: f32, color: Rgb, alpha: f32) {
    let area = [center.0 - radius - 1.0, center.1 - radius - 1.0, center.0 + radius + 1.0, center.1 + radius + 1.0];
    canvas.shade(area, color, alpha, |x, y| (radius + 0.5 - (x - center.0).hypot(y - center.1)).clamp(0.0, 1.0));
}

/// Un segmento recto.
pub fn paint_segment(canvas: &mut Canvas, from: (f32, f32), to: (f32, f32), half: f32, color: Rgb, alpha: f32) {
    let reach = half + 1.0;
    let area = [from.0.min(to.0) - reach, from.1.min(to.1) - reach, from.0.max(to.0) + reach, from.1.max(to.1) + reach];
    canvas.shade(area, color, alpha, |x, y| stroke(segment_distance(x, y, from, to), half));
}

/// Tras dibujar texto con GDI sobre un fondo opaco: deja el rectángulo con la
/// opacidad `alpha` dentro de la caja redondeada (y transparente fuera),
/// premultiplicando el color que dejó GDI.
pub fn settle_label(canvas: &mut Canvas, area: [f32; 4], radius: f32, alpha: f32) {
    let (x0, y0, x1, y1) = canvas.clip(area);
    for y in y0..y1 {
        for x in x0..x1 {
            let opacity = alpha * box_coverage(x as f32 + 0.5, y as f32 + 0.5, area, radius);
            let index = y * canvas.width + x;
            let pixel = canvas.pixels[index];
            let scale = |shift: u32| ((((pixel >> shift) & 0xff) as f32) * opacity).round() as u32;
            canvas.pixels[index] = (((opacity * 255.0).round() as u32) << 24) | (scale(16) << 16) | (scale(8) << 8) | scale(0);
        }
    }
}

/// Curvas de las animaciones (t de 0 a 1).
pub fn ease_out(t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    1.0 - (1.0 - t).powi(3)
}

/// Sube deprisa y vuelve despacio: el visor que se cierra y se abre.
pub fn bump(t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    if t < 0.3 {
        ease_out(t / 0.3)
    } else {
        let back = (t - 0.3) / 0.7;
        1.0 - back * back * (3.0 - 2.0 * back)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn canvas(width: usize, height: usize) -> (usize, usize, Vec<u32>) {
        (width, height, vec![0; width * height])
    }

    fn alpha(pixels: &[u32], width: usize, x: usize, y: usize) -> u32 {
        pixels[y * width + x] >> 24
    }

    #[test]
    fn the_accent_comes_from_settings_as_hex() {
        assert_eq!(Rgb::parse("#dcaa4a"), Some(Rgb(0xdc, 0xaa, 0x4a)));
        assert_eq!(Rgb::parse(" #F06A8D "), Some(Rgb(0xf0, 0x6a, 0x8d)));
        for wrong in ["dcaa4a", "#dca", "#dcaa4g", "", "#dcaa4a00"] {
            assert_eq!(Rgb::parse(wrong), None, "{wrong}");
        }
        let palette = Palette::from_accent(Rgb(0xdc, 0xaa, 0x4a));
        assert!(palette.keyline.0 < 0x50, "the keyline is dark enough to hold the line over white");
    }

    #[test]
    fn blending_is_premultiplied_source_over() {
        let (width, height, mut pixels) = canvas(2, 1);
        let mut surface = Canvas { width, height, pixels: &mut pixels };
        surface.blend(0, 0, Rgb(200, 100, 50), 0.5);
        let pixel = surface.pixels[0];
        assert_eq!(pixel >> 24, 128);
        assert_eq!((pixel >> 16) & 0xff, 100, "red is premultiplied");
        surface.blend(0, 0, Rgb(200, 100, 50), 1.0);
        assert_eq!(surface.pixels[0], 0xffc8_6432);
        surface.blend(5, 5, Rgb(1, 1, 1), 1.0);
    }

    #[test]
    fn the_track_measures_distance_and_runs_clockwise() {
        let track = Track { left: 10.0, top: 10.0, right: 110.0, bottom: 60.0, radius: 10.0 };
        let length = track.length();
        assert!((length - (2.0 * 80.0 + 2.0 * 30.0 + 2.0 * PI * 10.0)).abs() < 0.01);
        let (distance, position) = track.locate(20.0, 7.0);
        assert!((distance - 3.0).abs() < 1e-4 && position.abs() < 1e-4, "start of the top edge");
        let (distance, position) = track.locate(113.0, 35.0);
        assert!((distance - 3.0).abs() < 1e-4);
        assert!((position - (80.0 + FRAC_PI_2 * 10.0 + 15.0)).abs() < 1e-3, "right edge comes after the top-right arc");
        let (_, bottom) = track.locate(60.0, 60.0);
        let (_, left) = track.locate(10.0, 35.0);
        assert!(position < bottom && bottom < left && left < length, "clockwise order");
        // El arco de arriba a la izquierda cierra la vuelta.
        let (distance, position) = track.locate(10.0 + 10.0 - 10.0 * (PI / 4.0).cos(), 10.0 + 10.0 - 10.0 * (PI / 4.0).sin());
        assert!(distance < 1e-3);
        assert!((position - (length - FRAC_PI_2 * 5.0)).abs() < 1e-2);
    }

    #[test]
    fn dashes_fit_the_loop_without_a_seam() {
        let dashes = Dashes::fit(1000.0, 30.0, 0.5);
        let count = 1000.0 / dashes.period;
        assert!((count - count.round()).abs() < 1e-4);
        assert_eq!(dashes.gap(0.0), 0.0);
        assert_eq!(dashes.gap(dashes.on), 0.0);
        assert!((dashes.gap(dashes.on + 2.0) - 2.0).abs() < 1e-4);
        assert!((dashes.gap(dashes.period - 1.0) - 1.0).abs() < 1e-4, "the gap closes on the next dash");
        assert!((dashes.gap(-1.0) - 1.0).abs() < 1e-4, "negative positions wrap");
    }

    #[test]
    fn the_tape_stays_on_its_band_and_moves_with_the_phase() {
        let (width, height, mut pixels) = canvas(140, 90);
        let track = Track { left: 20.0, top: 20.0, right: 120.0, bottom: 70.0, radius: 12.0 };
        let mut tape = Tape { track, dashes: Dashes::fit(track.length(), 30.0, 0.56), line_half: 2.5, keyline_half: 4.0, phase: 0.0 };
        let palette = Palette::from_accent(Rgb(0xdc, 0xaa, 0x4a));
        Tape::paint(&tape, &mut Canvas { width, height, pixels: &mut pixels }, (0, 0), palette.accent, &palette);
        assert_eq!(alpha(&pixels, width, 70, 45), 0, "the middle of the window stays clear");
        assert_eq!(alpha(&pixels, width, 70, 10), 0, "nothing far outside the band");
        assert!(alpha(&pixels, width, 120, 45) > 200, "the band is painted on the right edge");
        let before = pixels.clone();
        tape.phase = 7.0;
        pixels.fill(0);
        Tape::paint(&tape, &mut Canvas { width, height, pixels: &mut pixels }, (0, 0), palette.accent, &palette);
        assert_ne!(before, pixels, "advancing the phase moves the dashes");
        // Pintar por trozos (las tiras) da lo mismo que pintar entero.
        let (strip_w, strip_h, mut strip) = canvas(140, 30);
        Tape::paint(&tape, &mut Canvas { width: strip_w, height: strip_h, pixels: &mut strip }, (0, 60), palette.accent, &palette);
        assert_eq!(&strip[..], &pixels[60 * width..90 * width]);
    }

    #[test]
    fn a_corner_is_an_l_with_a_rounded_joint() {
        let corner = Corner { x: 100.0, y: 10.0, inward_x: -1.0, inward_y: 1.0 };
        assert!(corner.distance(60.0, 10.0, 16.0, 64.0) < 1e-4, "on the top arm");
        assert!(corner.distance(100.0, 50.0, 16.0, 64.0) < 1e-4, "on the side arm");
        assert!(corner.distance(100.0, 10.0, 16.0, 64.0) > 4.0, "the sharp corner is cut by the arc");
        assert!(corner.distance(20.0, 10.0, 16.0, 64.0) > 10.0, "the arm ends");
        let (width, height, mut pixels) = canvas(120, 90);
        let palette = Palette::from_accent(Rgb(0x4f, 0xb8, 0xa3));
        corner.paint(&mut Canvas { width, height, pixels: &mut pixels }, 16.0, 64.0, 2.5, 4.5, palette.accent, &palette);
        assert!(alpha(&pixels, width, 70, 10) > 200);
        assert_eq!(alpha(&pixels, width, 20, 60), 0);
    }

    #[test]
    fn labels_get_rounded_and_premultiplied() {
        let (width, height, mut pixels) = canvas(20, 10);
        pixels.fill(0x00ff_ffff);
        let mut surface = Canvas { width, height, pixels: &mut pixels };
        settle_label(&mut surface, [0.0, 0.0, 20.0, 10.0], 4.0, 0.5);
        assert_eq!(surface.pixels[5 * 20 + 10], 0x8080_8080);
        assert_eq!(surface.pixels[0] >> 24, 0, "the rounded corner is clear");
    }

    /// Lo que cuesta un paso de la cinta alrededor de una ventana maximizada a 1920 × 1200.
    /// `cargo test --release -- --ignored tape_step_cost --nocapture`
    #[test]
    #[ignore]
    fn tape_step_cost() {
        let track = Track { left: 5.0, top: 5.0, right: 1915.0, bottom: 1147.0, radius: 6.0 };
        let tape = Tape { track, dashes: Dashes::fit(track.length(), 30.0, 0.56), line_half: 2.5, keyline_half: 4.0, phase: 3.0 };
        let palette = Palette::from_accent(Rgb(0xdc, 0xaa, 0x4a));
        let strips = [(0, 0, 1920, 17), (0, 1135, 1920, 17), (0, 17, 11, 1118), (1909, 17, 11, 1118)];
        let mut buffers: Vec<Vec<u32>> = strips.iter().map(|(_, _, w, h)| vec![0; w * h]).collect();
        let started = std::time::Instant::now();
        let fields: Vec<TapeField> = strips.iter().map(|(x, y, w, h)| tape.field((*x as i32, *y as i32), *w, *h, &palette)).collect();
        println!("preparing (the window moved): {:?}", started.elapsed());
        let started = std::time::Instant::now();
        let rounds = 50;
        for round in 0..rounds {
            let tape = Tape { phase: round as f32 * 2.0, ..tape };
            for ((_, _, w, h), (buffer, field)) in strips.iter().zip(buffers.iter_mut().zip(&fields)) {
                tape.paint_field(field, &mut Canvas { width: *w, height: *h, pixels: buffer }, palette.accent, round == 0);
            }
        }
        println!("one tape step: {:?}", started.elapsed() / rounds);
    }

    #[test]
    fn the_curves_start_and_end_at_rest() {
        assert_eq!(ease_out(0.0), 0.0);
        assert_eq!(ease_out(1.0), 1.0);
        assert_eq!(bump(0.0), 0.0);
        assert!((bump(0.3) - 1.0).abs() < 1e-4);
        assert!(bump(1.0).abs() < 1e-4);
    }
}
