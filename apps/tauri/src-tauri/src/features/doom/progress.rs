//! Doom continuous progress maintenance (Spec #2972, ST-4).
//!
//! The explicit continuous-state owner (G-123): a [`DoomProgressWriter`] maps a
//! [`DoomCampaign`] transition to ONE persisted [`DoomSave`] (via [`save::store`])
//! and is invoked on **every** level transition and on completion. This gives the
//! "WHILE the run is active, the persisted resume point tracks progress" clause a
//! single owning unit with a unit test, rather than a bare call-site.
//!
//! Write failures are **best-effort**: a failed save is logged and ignored, and
//! NEVER fails the autoplay run (NFR-3). The writer holds no `AppHandle` — the
//! loop stays engine-agnostic; the composition root injects a writer built over
//! the shared `AppStore`.

use std::sync::Arc;

use crate::infrastructure::storage::AppStore;

use super::save::{self, DoomCampaign, DoomSave};

/// The save sink a [`DoomProgressWriter`] drives: `Ok(())` on a durable write,
/// `Err(detail)` on a failure the writer logs and swallows.
type SaveSink = dyn Fn(&DoomSave) -> Result<(), String> + Send + Sync;

/// The continuous-state owner (G-123, binding name G-255).
///
/// Cheap to clone (an `Arc` around the sink) so it can be moved into the autoplay
/// loop. [`Self::record`] is idempotent per call: it writes exactly ONE
/// [`DoomSave`] for the campaign position it is handed.
#[derive(Clone)]
pub struct DoomProgressWriter {
    sink: Arc<SaveSink>,
}

impl DoomProgressWriter {
    /// Build a writer over an arbitrary save sink.
    ///
    /// Production uses [`Self::for_store`]; this constructor exists so a failing
    /// sink can be injected in tests (proving the best-effort contract).
    pub fn new(sink: impl Fn(&DoomSave) -> Result<(), String> + Send + Sync + 'static) -> Self {
        DoomProgressWriter {
            sink: Arc::new(sink),
        }
    }

    /// Build a writer that persists through [`save::store`] — the control plane
    /// (atomic upsert under [`super::state::DOOM_SAVE_KEY`]), or the
    /// `FREDO_DOOM_SAVE_FILE` seam when set.
    pub fn for_store(store: Arc<AppStore>) -> Self {
        DoomProgressWriter::new(move |save| save::store(&store, save))
    }

    /// Persist ONE [`DoomSave`] for the campaign's current position.
    ///
    /// Invoked on every level transition and on completion. A write failure is
    /// logged (best-effort) and never propagated — the autoplay run continues.
    /// Calling `record` before the first advance is what the caller must avoid
    /// (R-5); the writer itself performs no write on construction.
    pub fn record(&self, campaign: &DoomCampaign) {
        let save = DoomSave::from_campaign(campaign, chrono::Utc::now().to_rfc3339());
        if let Err(detail) = (self.sink.as_ref())(&save) {
            tracing::warn!(
                target: "fredo::doom",
                error = %detail,
                "doom progress save failed (best-effort; the run continues)"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::doom::save::load;
    use crate::features::doom::state::DOOM_SAVE_KEY;
    use crate::infrastructure::storage::engine::EngineHandle;
    use std::path::Path;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    fn open_store(dir: &Path) -> AppStore {
        AppStore::open(EngineHandle::new_pending(), dir).expect("open app store")
    }

    fn campaign(episode: i64, map: i64) -> DoomCampaign {
        DoomCampaign {
            episode,
            map,
            ..DoomCampaign::initial()
        }
    }

    #[test]
    fn record_persists_one_save_for_the_campaign_position() {
        let dir = tempfile::tempdir().expect("tempdir");
        let app_store = Arc::new(open_store(dir.path()));
        let writer = DoomProgressWriter::for_store(app_store.clone());

        writer.record(&campaign(1, 2));

        let saved = load(&app_store).expect("save present");
        assert_eq!(saved.episode, 1);
        assert_eq!(saved.map, 2);
        assert_eq!(saved.skill, save::DOOM_DEFAULT_SKILL);
        assert_eq!(saved.seed, save::DOOM_DEFAULT_SEED);
        assert!(!saved.completed);
        assert_eq!(saved.version, save::DOOM_SAVE_VERSION);

        // Only when the file seam is unset does the record live under the key.
        if std::env::var(save::DOOM_SAVE_FILE_ENV).is_err() {
            let raw = app_store
                .control_get(DOOM_SAVE_KEY)
                .expect("control read")
                .expect("present");
            assert_eq!(DoomSave::parse(&raw), Some(saved));
        }
    }

    #[test]
    fn each_transition_overwrites_the_single_slot() {
        let dir = tempfile::tempdir().expect("tempdir");
        let app_store = Arc::new(open_store(dir.path()));
        let writer = DoomProgressWriter::for_store(app_store.clone());

        writer.record(&campaign(1, 2));
        writer.record(&campaign(1, 3));
        let completed = DoomCampaign {
            completed: true,
            ..campaign(4, 9)
        };
        writer.record(&completed);

        let saved = load(&app_store).expect("save present");
        assert_eq!((saved.episode, saved.map), (4, 9));
        assert!(saved.completed);

        // ONE fixed key — no append log.
        if std::env::var(save::DOOM_SAVE_FILE_ENV).is_err() {
            let raw = app_store
                .control_get(DOOM_SAVE_KEY)
                .expect("control read")
                .expect("present");
            assert_eq!(DoomSave::parse(&raw), Some(saved));
        }
    }

    #[test]
    fn record_attempts_a_write_but_a_failure_never_propagates() {
        let calls = Arc::new(AtomicUsize::new(0));
        let seen: Arc<Mutex<Vec<DoomSave>>> = Arc::new(Mutex::new(Vec::new()));
        let counter = calls.clone();
        let sink_store = seen.clone();
        let writer = DoomProgressWriter::new(move |save| {
            counter.fetch_add(1, Ordering::SeqCst);
            sink_store.lock().expect("lock").push(save.clone());
            Err("unwritable seam path".to_string())
        });

        // A failing sink must not panic and must not stop the caller.
        writer.record(&campaign(1, 2));
        writer.record(&campaign(1, 3));

        assert_eq!(calls.load(Ordering::SeqCst), 2);
        let recorded = seen.lock().expect("lock");
        assert_eq!(recorded.len(), 2);
        assert_eq!((recorded[0].episode, recorded[0].map), (1, 2));
        assert_eq!((recorded[1].episode, recorded[1].map), (1, 3));
        assert!(recorded.iter().all(|save| !save.updated_at.is_empty()));
    }

    #[test]
    fn constructing_a_writer_persists_nothing_until_recorded() {
        // R-5 at the writer boundary: no write happens before the first advance.
        let calls = Arc::new(AtomicUsize::new(0));
        let counter = calls.clone();
        let writer = DoomProgressWriter::new(move |_save| {
            counter.fetch_add(1, Ordering::SeqCst);
            Ok(())
        });

        let _clone = writer.clone();
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        writer.record(&campaign(1, 2));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}
