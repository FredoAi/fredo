use base64::{engine::general_purpose::STANDARD, Engine as _};
use image::{GenericImageView, ImageEncoder};

/// Clamp a screen-region crop rectangle to image bounds.
///
/// `rel_x` / `rel_y` are the top-left corner relative to the monitor origin,
/// already rounded and floored at zero.  `w` / `h` are the desired dimensions,
/// also already rounded.
///
/// Returns `(rel_x, rel_y, w, h)` clamped so the region fits within
/// `(img_w, img_h)`.
fn clamp_region(rel_x: u32, rel_y: u32, w: u32, h: u32, img_w: u32, img_h: u32) -> (u32, u32, u32, u32) {
    let rel_x = rel_x.min(img_w.saturating_sub(1));
    let rel_y = rel_y.min(img_h.saturating_sub(1));
    let w = w.min(img_w - rel_x);
    let h = h.min(img_h - rel_y);
    (rel_x, rel_y, w, h)
}

/// Capture a region of the screen and return it as a base64-encoded PNG string.
///
/// `x` and `y` are the top-left corner in physical screen pixels (the caller
/// should multiply CSS/logical pixels by `window.devicePixelRatio`).
/// `width` and `height` are also in physical pixels.
#[tauri::command]
pub fn capture_screen_region(
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<String, String> {
    let monitors = xcap::Monitor::all().map_err(|e| e.to_string())?;

    // Find the monitor whose bounds contain the top-left corner of the region.
    let monitor = monitors
        .into_iter()
        .find(|m| {
            let mx = m.x() as f64;
            let my = m.y() as f64;
            let mw = m.width() as f64;
            let mh = m.height() as f64;
            x >= mx && y >= my && x < mx + mw && y < my + mh
        })
        .ok_or_else(|| format!("No monitor found containing ({x}, {y})"))?;

    let screenshot = monitor.capture_image().map_err(|e| e.to_string())?;

    // Coordinates relative to the monitor origin (already in physical pixels).
    let rel_x = (x - monitor.x() as f64).round().max(0.0) as u32;
    let rel_y = (y - monitor.y() as f64).round().max(0.0) as u32;
    let w = width.round() as u32;
    let h = height.round() as u32;

    // Clamp to screenshot bounds to avoid out-of-bounds crops.
    let img_w = screenshot.width();
    let img_h = screenshot.height();
    let (rel_x, rel_y, w, h) = clamp_region(rel_x, rel_y, w, h, img_w, img_h);

    let cropped = screenshot.view(rel_x, rel_y, w, h).to_image();

    // Encode the RGBA image as PNG and return it as a base64 string.
    let mut buf = std::io::Cursor::new(Vec::new());
    image::codecs::png::PngEncoder::new(&mut buf)
        .write_image(
            cropped.as_raw(),
            w,
            h,
            image::ExtendedColorType::Rgba8,
        )
        .map_err(|e| e.to_string())?;

    Ok(STANDARD.encode(buf.into_inner()))
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── clamp_region ───────────────────────────────────────────────────────

    #[test]
    fn clamp_region_within_bounds_stays_unchanged() {
        // Region fits entirely within the 1920×1080 image
        let (rx, ry, w, h) = clamp_region(100, 100, 800, 600, 1920, 1080);
        assert_eq!(rx, 100);
        assert_eq!(ry, 100);
        assert_eq!(w, 800);
        assert_eq!(h, 600);
    }

    #[test]
    fn clamp_region_clamps_rel_x_to_max() {
        // rel_x beyond right edge → clamped to img_w-1, w is 0
        let (rx, ry, w, h) = clamp_region(2000, 100, 800, 600, 1920, 1080);
        assert_eq!(rx, 1919);
        assert_eq!(ry, 100);
        assert_eq!(w, 1);
        assert_eq!(h, 600);
    }

    #[test]
    fn clamp_region_clamps_rel_y_to_max() {
        // rel_y beyond bottom edge → clamped to img_h-1
        let (rx, ry, w, h) = clamp_region(100, 2000, 800, 600, 1920, 1080);
        assert_eq!(rx, 100);
        assert_eq!(ry, 1079);
        assert_eq!(w, 800);
        assert_eq!(h, 1);
    }

    #[test]
    fn clamp_region_reduces_width_when_overflowing() {
        // x=1800, width=200 overflows the 1920-width image → width trimmed
        let (rx, _ry, w, _h) = clamp_region(1800, 500, 200, 100, 1920, 1080);
        assert_eq!(rx, 1800);
        assert_eq!(w, 120); // 1920 - 1800 = 120
    }

    #[test]
    fn clamp_region_reduces_height_when_overflowing() {
        // y=1000, height=200 overflows the 1080-height image → height trimmed
        let (_rx, ry, _w, h) = clamp_region(100, 1000, 500, 200, 1920, 1080);
        assert_eq!(ry, 1000);
        assert_eq!(h, 80); // 1080 - 1000 = 80
    }

    #[test]
    fn clamp_region_handles_zero_dimensions() {
        let (rx, ry, w, h) = clamp_region(0, 0, 0, 0, 1920, 1080);
        assert_eq!(rx, 0);
        assert_eq!(ry, 0);
        assert_eq!(w, 0);
        assert_eq!(h, 0);
    }

    #[test]
    fn clamp_region_handles_rel_at_edge() {
        // rel_x at the last valid pixel, width should be 1
        let (rx, _ry, w, _h) = clamp_region(1919, 500, 100, 100, 1920, 1080);
        assert_eq!(rx, 1919);
        assert_eq!(w, 1); // img_w - 1919 = 1
    }
}
