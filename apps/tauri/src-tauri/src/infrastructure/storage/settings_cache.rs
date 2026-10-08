//! The volatile synchronous settings cache (Spec #3005, ST-2).
//!
//! PostgreSQL is the ONLY durable store. Several consumers read settings
//! SYNCHRONOUSLY (the log-filter refresh, the per-emit terminal label, the
//! metrics collector, the retention knobs) and the tracing subscriber is
//! initialized before the pool exists, so they cannot await. This cache is the
//! synchronous seam: a process-local, volatile `HashMap<String, String>` that
//! [`super::AppStore::hydrate`] fills ONCE from the PostgreSQL `settings` table
//! and that [`super::AppStore::cached_set`] write-throughs back to PostgreSQL.
//!
//! It holds no persistent state of its own - a process restart starts empty and
//! re-hydrates. A read of an unknown key returns `None` (consumers keep their
//! existing default-on-`None` rule); it never synthesizes an empty-string
//! sentinel.

use std::collections::HashMap;
use std::sync::{RwLock, RwLockReadGuard, RwLockWriteGuard};

/// A process-local, volatile key-value cache behind an `RwLock`.
pub struct SettingsCache {
    inner: RwLock<HashMap<String, String>>,
}

impl SettingsCache {
    /// An empty cache.
    pub fn new() -> Self {
        Self {
            inner: RwLock::new(HashMap::new()),
        }
    }

    /// Read one value; an absent key yields `None` (never `Some("")`).
    pub fn get(&self, key: &str) -> Option<String> {
        lock_read(&self.inner).get(key).cloned()
    }

    /// Insert or replace one value.
    pub fn set(&self, key: &str, value: &str) {
        lock_write(&self.inner).insert(key.to_string(), value.to_string());
    }

    /// Replace the whole cache with `rows` (the hydration load).
    pub fn replace_all(&self, rows: HashMap<String, String>) {
        *lock_write(&self.inner) = rows;
    }

    /// A point-in-time copy of the cache.
    pub fn snapshot(&self) -> HashMap<String, String> {
        lock_read(&self.inner).clone()
    }
}

impl Default for SettingsCache {
    fn default() -> Self {
        Self::new()
    }
}

fn lock_read<T>(rwlock: &RwLock<T>) -> RwLockReadGuard<'_, T> {
    rwlock.read().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn lock_write<T>(rwlock: &RwLock<T>) -> RwLockWriteGuard<'_, T> {
    rwlock.write().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_absent_key_is_none() {
        let cache = SettingsCache::new();
        assert_eq!(cache.get("absent"), None);
    }

    #[test]
    fn set_and_get_round_trip_including_a_changed_value() {
        let cache = SettingsCache::new();
        cache.set("a", "1");
        assert_eq!(cache.get("a"), Some("1".to_string()));
        cache.set("a", "2");
        assert_eq!(cache.get("a"), Some("2".to_string()));
    }

    #[test]
    fn replace_all_swaps_the_whole_map() {
        let cache = SettingsCache::new();
        cache.set("stale", "old");
        let mut rows = HashMap::new();
        rows.insert("fresh".to_string(), "new".to_string());
        cache.replace_all(rows);

        assert_eq!(cache.get("stale"), None, "replace_all drops prior keys");
        assert_eq!(cache.get("fresh"), Some("new".to_string()));
    }

    #[test]
    fn snapshot_is_a_copy() {
        let cache = SettingsCache::new();
        cache.set("a", "1");
        let snap = cache.snapshot();
        assert_eq!(snap.get("a").map(String::as_str), Some("1"));
        cache.set("a", "2");
        assert_eq!(
            snap.get("a").map(String::as_str),
            Some("1"),
            "the snapshot must not track later mutations"
        );
    }
}
