//! Declared-table retention + tombstone lifecycle — `prune_declared_tables`
//! (bounded, oldest-first, `remove`-emitting) and tombstone-aware projection
//! (Spec #2896, ST-7, R-4.4/R-4.6). Implemented by ST-7.
