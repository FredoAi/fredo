use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
    // CI environment variable is set to "true" by GitHub Actions (and other CI
    // providers). On CI runners, the OpenCode plugin dist doesn't exist, so we
    // temporarily clear bundle resources before the build and restore the
    // original config afterward. Locally (no CI), resources are left intact.
    let is_ci = env::var("CI").unwrap_or_default() == "true";

    let restore = if is_ci {
        let config_path = PathBuf::from("tauri.conf.json");
        let backup_path = PathBuf::from("tauri.conf.json.bak");

        let config_str =
            fs::read_to_string(&config_path).expect("Failed to read tauri.conf.json");

        let mut config: serde_json::Value =
            serde_json::from_str(&config_str).expect("Failed to parse tauri.conf.json");

        // Clear all bundle resources — none exist on CI
        if let Some(bundle) = config.get_mut("bundle") {
            if let Some(resources) = bundle.get_mut("resources") {
                *resources = serde_json::Value::Object(serde_json::Map::new());
            }
        }

        let filtered =
            serde_json::to_string_pretty(&config).expect("Failed to serialize config");

        // Swap: backup original, write filtered in its place
        fs::rename(&config_path, &backup_path)
            .expect("Failed to backup tauri.conf.json");
        fs::write(&config_path, filtered.as_bytes())
            .expect("Failed to write filtered tauri.conf.json");

        println!("cargo:warning=Bundle resources cleared (CI build)");

        Some((config_path.clone(), backup_path, config_str))
    } else {
        None
    };

    tauri_build::build();

    // Restore original config so the working tree stays clean
    if let Some((_config_path, backup_path, original)) = restore {
        fs::write(&_config_path, original.as_bytes())
            .expect("Failed to restore tauri.conf.json");
        fs::remove_file(&backup_path).expect("Failed to remove config backup");
    }
}
