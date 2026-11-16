pub mod db_client;
pub mod doom;
// Spec #3147 ST-2 — the installed-application package trust boundary: zip
// ingest, manifest validation, hash pinning and the on-disk store. ST-3/ST-4/ST-5
// append to this module (scheme handler, window lifecycle, theme push).
pub mod installed_apps;
pub mod llm_server;
pub mod pg_supervisor;
pub mod screenshot;
pub mod settings;
pub mod setup;
pub mod telemetry;
pub mod terminal;
pub mod wireframe;
