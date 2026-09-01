pub mod merge;
pub mod rows;
// TEMPORARY (Spec #2788, P2.2): `query` aliases `query_tmp.rs` until P2.1's
// real `query/mod.rs` lands on `spec/2788`. AT INTEGRATION: keep the peer's
// `pub mod query;` line, DELETE the `#[path]` line below, and DELETE
// `query_tmp.rs` — imports already use the `rtdb::query` path. See the
// `query_tmp.rs` header for the full integration checklist.
#[path = "query_tmp.rs"]
pub mod query;
pub mod project;
pub mod subscriptions;
