use base64::{engine::general_purpose::STANDARD, Engine as _};
use image::{GenericImageView, ImageEncoder};

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
    let rel_x = rel_x.min(img_w.saturating_sub(1));
    let rel_y = rel_y.min(img_h.saturating_sub(1));
    let w = w.min(img_w - rel_x);
    let h = h.min(img_h - rel_y);

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
