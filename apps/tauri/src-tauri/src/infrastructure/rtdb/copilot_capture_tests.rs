//! Spec #2933 ST-4 — GitHub Copilot CLI capture harness.
//!
//! The deterministic mocked capture suite was removed with the SQLite data
//! plane (Spec #2979 CU-2): it composed a temp SQLite `RtdbStore` data plane,
//! which no longer exists. The live Copilot capture path is covered by the
//! mission-monitor E2E suite on the PostgreSQL-default build.
