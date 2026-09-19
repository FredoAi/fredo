//! Projection engine — turns every canonical RTDB row upsert into declared-table
//! writes, unconditionally and without any feature-side write (Spec #2896, ST-3,
//! R-4.2). Implemented by ST-3.
