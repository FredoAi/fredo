use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
    let skip_models = env::var("SKIP_MODEL_RESOURCES").unwrap_or_default();

    // When SKIP_MODEL_RESOURCES=1, temporarily swap in a filtered config
    // that excludes GGUF model resource entries (which don't exist on CI).
    let restore = if skip_models == "1" {
        let config_path = PathBuf::from("tauri.conf.json");
        let backup_path = PathBuf::from("tauri.conf.json.bak");

        let config_str =
            fs::read_to_string(&config_path).expect("Failed to read tauri.conf.json");

        let mut config: serde_json::Value =
            serde_json::from_str(&config_str).expect("Failed to parse tauri.conf.json");

        // Strip GGUF model resource entries – match any key containing ".gguf"
        if let Some(bundle) = config.get_mut("bundle") {
            if let Some(resources) = bundle.get_mut("resources") {
                if let Some(obj) = resources.as_object_mut() {
                    let gguf_keys: Vec<String> = obj
                        .keys()
                        .filter(|k| k.contains(".gguf"))
                        .cloned()
                        .collect();
                    for key in gguf_keys {
                        obj.remove(&key);
                    }
                }
            }
        }

        let filtered =
            serde_json::to_string_pretty(&config).expect("Failed to serialize config");

        // Swap: backup original, write filtered in its place
        fs::rename(&config_path, &backup_path)
            .expect("Failed to backup tauri.conf.json");
        fs::write(&config_path, filtered.as_bytes())
            .expect("Failed to write filtered tauri.conf.json");

        println!("cargo:warning=GGUF model resources stripped (SKIP_MODEL_RESOURCES=1)");

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
