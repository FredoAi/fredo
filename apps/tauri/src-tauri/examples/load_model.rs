/// Two-step isolation test for the `_osfile(fh) & FOPEN` assertion.
///
/// Step 1 loads the base GGUF text model only (no mmproj).
/// Step 2 loads the same model together with the mmproj.
///
/// Rename mmproj-F16.gguf → mmproj-F16.gguf.bak to skip step 2.
///
/// Run with:
///   cargo run --example load_model
use std::path::Path;

type LogCallback =
    Option<unsafe extern "C" fn(i32, *const core::ffi::c_char, *mut core::ffi::c_void)>;

extern "C" {
    fn ggml_log_set(cb: LogCallback, user_data: *mut core::ffi::c_void);
    fn llama_log_set(cb: LogCallback, user_data: *mut core::ffi::c_void);
    fn mtmd_log_set(cb: LogCallback, user_data: *mut core::ffi::c_void);
    fn mtmd_helper_log_set(cb: LogCallback, user_data: *mut core::ffi::c_void);
}

unsafe extern "C" fn noop(
    _level: i32,
    _text: *const core::ffi::c_char,
    _user_data: *mut core::ffi::c_void,
) {}

fn main() {
    unsafe {
        ggml_log_set(Some(noop), std::ptr::null_mut());
        llama_log_set(Some(noop), std::ptr::null_mut());
        mtmd_log_set(Some(noop), std::ptr::null_mut());
        mtmd_helper_log_set(Some(noop), std::ptr::null_mut());
    }

    std::env::set_var("GGML_VK_DISABLE", "1");

    let models_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("models")
        .join("gemma-e2b-it");

    let model_path  = models_dir.join("gemma-4-E2B-it-Q4_K_M.gguf");
    let mmproj_path = models_dir.join("mmproj-F16.gguf");

    println!("model:  {}", model_path.display());
    println!("mmproj: {}", mmproj_path.display());

    if !model_path.exists() {
        eprintln!("ERROR: base model not found");
        std::process::exit(1);
    }

    // A real mmproj is several hundred MB; a placeholder/empty file is skipped.
    let mmproj_real = mmproj_path
        .metadata()
        .map(|m| m.len() > 1024 * 1024)
        .unwrap_or(false);

    let model_str = model_path.to_string_lossy().into_owned();

    // ── Step 1: text-only ────────────────────────────────────────────────────
    println!("\n[1/2] TEXT-ONLY (no mmproj, n_ctx=512)...");
    match rig_llama_cpp::Client::builder(&model_str).n_ctx(512).build() {
        Ok(_)  => println!("      PASSED"),
        Err(e) => {
            eprintln!("      FAILED: {e:#}");
            eprintln!("      >> assertion fires on TEXT-ONLY path");
            std::process::exit(1);
        }
    }

    // ── Step 2: with mmproj ──────────────────────────────────────────────────
    if mmproj_real {
        let mp = mmproj_path.to_string_lossy().into_owned();
        println!("\n[2/2] WITH mmproj ({mp})...");
        match rig_llama_cpp::Client::builder(&model_str)
            .n_ctx(4096)
            .mmproj(&mp)
            .build()
        {
            Ok(_)  => println!("      PASSED"),
            Err(e) => {
                eprintln!("      FAILED: {e:#}");
                eprintln!("      >> assertion fires on MMPROJ path");
                std::process::exit(1);
            }
        }
    } else {
        println!("\n[2/2] SKIPPED — mmproj-F16.gguf is a placeholder (rename .bak back to run this step)");
    }

    println!("\nALL STEPS PASSED");
}
