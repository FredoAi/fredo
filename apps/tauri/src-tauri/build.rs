use std::env;
use std::fs;
use std::io::Write;
use std::path::PathBuf;

fn main() {
    let skip_models = env::var("SKIP_MODEL_RESOURCES").unwrap_or_default();

    if skip_models == "1" {
        // Read tauri.conf.json from the current directory (src-tauri/)
        let config_path = PathBuf::from("tauri.conf.json");
        let config_str = fs::read_to_string(&config_path)
            .expect("Failed to read tauri.conf.json");

        let mut config: serde_json::Value = serde_json::from_str(&config_str)
            .expect("Failed to parse tauri.conf.json");

        // Strip GGUF model resource entries from bundle.resources
        // Matches any resource key whose source path contains ".gguf"
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

        // Write filtered config to a temp file
        let temp_dir = env::temp_dir();
        let temp_config_path = temp_dir.join("fredo-tauri-conf-skip-models.json");
        let temp_config_str =
            serde_json::to_string_pretty(&config).expect("Failed to serialize config");

        let mut file =
            fs::File::create(&temp_config_path).expect("Failed to create temp config file");
        file.write_all(temp_config_str.as_bytes())
            .expect("Failed to write temp config file");

        // Point tauri_build at the filtered config
        env::set_var(
            "TAURI_CONFIG",
            temp_config_path
                .to_str()
                .expect("Invalid temp config path"),
        );

        println!("cargo:warning=GGUF model resources stripped from config (SKIP_MODEL_RESOURCES=1)");
    }

    tauri_build::build();
}
