//! Device enumeration, backend projection, and the TEST-ONLY force-CPU seam
//! (Spec #3141, ST-1; AC-22 / AC-23 / AC-24 / AC-25).
//!
//! Two responsibilities, both PURE where it matters:
//!
//! 1. **Report what ggml loaded.** [`device_infos`] reads ggml's typed device
//!    enumeration for a loaded model and maps it onto
//!    [`CompanionDeviceInfo`]. The reported backend ([`report_backend`]) is
//!    derived from that enumeration — NEVER from a log line and NEVER by echoing
//!    the requested setting (`AC-22.2`).
//!
//! 2. **Project a requested mode onto real devices.** [`project`] turns
//!    ([`CompanionBackendMode`], device set) into a typed outcome: `gpu` with no
//!    usable non-CPU device is a [`CompanionEngineErrorCode::GpuUnavailable`]
//!    refusal (AC-25), while `auto`/`cpu` always resolve.
//!
//! ## The force-CPU seam
//!
//! [`COMPANION_FORCE_CPU_ENV`] is a TEST-ONLY induction lever so the CPU and
//! `gpu`-unavailable legs are drivable on any host without a GPU (G-409/G-275).
//! It substitutes the DEVICE SET ONLY, at the enumeration seam itself — before
//! the mode projection runs — so the forced set is what the status actually
//! reports. It is never a persisted setting, never on the status wire, never
//! rendered, and never changes the persisted mode.
//!
//! The contract is pinned by [`force_cpu_with`], a pure rule split out so the
//! lever is testable WITHOUT mutating process-global environment state (G-222).
//! It is the exact shape of `pg_supervisor::mod::force_start_fail_with`.

use llama_cpp_4::model::{LlamaBackendDeviceType, LlamaModel};

use super::{
    CompanionBackendKind, CompanionBackendMode, CompanionDeviceInfo, CompanionEngineErrorCode,
};

/// TEST-ONLY induction seam: force the device enumeration to CPU-only.
///
/// A non-blank value other than `0` / `false` (trimmed, case-insensitive)
/// engages the lever; unset, blank, `0`, and `false` are INERT, so the default
/// enumeration is byte-identical. See [`force_cpu_with`] / [`force_cpu`].
pub const COMPANION_FORCE_CPU_ENV: &str = "FREDO_COMPANION_FORCE_CPU";

/// The pure force-CPU rule: `true` when `value` is set to a non-blank token
/// other than `0` / `false` (case-insensitive, trimmed).
///
/// Split from [`force_cpu`] so the lever contract is unit-pinnable without
/// mutating process-global env (G-222) — the same shape as
/// `pg_supervisor::mod::force_start_fail_with`.
pub fn force_cpu_with(value: Option<&str>) -> bool {
    match value {
        Some(value) => {
            let raw = value.trim();
            !raw.is_empty() && !raw.eq_ignore_ascii_case("0") && !raw.eq_ignore_ascii_case("false")
        }
        None => false,
    }
}

/// Resolve the force-CPU lever from the process environment. Inert by default.
pub fn force_cpu() -> bool {
    force_cpu_with(std::env::var(COMPANION_FORCE_CPU_ENV).ok().as_deref())
}

/// The CPU-only device set the force seam substitutes for a real enumeration.
///
/// The name/description are the values ggml's own CPU device reports, so a
/// forced run reports a set a CPU-only host would genuinely produce.
pub fn forced_cpu_devices() -> Vec<CompanionDeviceInfo> {
    vec![CompanionDeviceInfo {
        name: "CPU".to_string(),
        description: "CPU".to_string(),
        device_type: CompanionBackendKind::Cpu,
        memory_free_bytes: 0,
        memory_total_bytes: 0,
    }]
}

/// Map a ggml device class onto the wire vocabulary (a 1:1 mirror).
fn backend_kind(device_type: LlamaBackendDeviceType) -> CompanionBackendKind {
    match device_type {
        LlamaBackendDeviceType::Cpu => CompanionBackendKind::Cpu,
        LlamaBackendDeviceType::Gpu => CompanionBackendKind::Gpu,
        LlamaBackendDeviceType::IntegratedGpu => CompanionBackendKind::IntegratedGpu,
        LlamaBackendDeviceType::Accel => CompanionBackendKind::Accel,
        LlamaBackendDeviceType::Meta => CompanionBackendKind::Meta,
    }
}

/// Enumerate the devices a loaded model's tensors are spread across.
///
/// `model.devices()` is ggml's typed enumeration (AC-22.2). A device whose name
/// or description cannot be read is skipped rather than failing the whole
/// readout — a partial truth is better than a fabricated device.
pub fn enumerate(model: &LlamaModel) -> Vec<CompanionDeviceInfo> {
    model
        .devices()
        .filter_map(|device| {
            let name = device.name().ok()?.to_string();
            let description = device.description().unwrap_or_default().to_string();
            let (free, total) = device.memory();
            Some(CompanionDeviceInfo {
                name,
                description,
                device_type: backend_kind(device.device_type()),
                memory_free_bytes: free as u64,
                memory_total_bytes: total as u64,
            })
        })
        .collect()
}

/// Apply the TEST-ONLY force seam to a real enumeration.
///
/// When the lever is engaged the result is exactly one CPU device — the
/// coercion happens HERE, at the enumeration seam, so the forced set is what
/// every downstream reader (backend report, status) sees. When it is inert the
/// input is returned unchanged (byte-identical default path).
pub fn apply_force_cpu(devices: Vec<CompanionDeviceInfo>, force_cpu: bool) -> Vec<CompanionDeviceInfo> {
    if force_cpu {
        forced_cpu_devices()
    } else {
        devices
    }
}

/// The backend to report for a device set: the first genuinely
/// non-CPU device if one exists, else CPU.
///
/// This reads the ENUMERATION, so on a loaded CPU-only model it reports
/// [`CompanionBackendKind::Cpu`] — the reported backend can never over-claim a
/// GPU (AC-23.2).
pub fn report_backend(devices: &[CompanionDeviceInfo]) -> Option<CompanionBackendKind> {
    if devices.is_empty() {
        return None;
    }
    let non_cpu = devices
        .iter()
        .find(|device| device.device_type != CompanionBackendKind::Cpu);
    Some(
        non_cpu
            .map(|device| device.device_type)
            .unwrap_or(CompanionBackendKind::Cpu),
    )
}

/// Whether the device set contains at least one usable non-CPU device.
pub fn has_usable_gpu(devices: &[CompanionDeviceInfo]) -> bool {
    devices
        .iter()
        .any(|device| device.device_type != CompanionBackendKind::Cpu)
}

/// The outcome of projecting a requested mode onto a device set.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModeProjection {
    /// Full GPU offload (mode `auto`/`gpu`, a usable GPU present).
    FullOffload,
    /// Zero GPU offload (mode `cpu`, or `auto` with no usable GPU).
    CpuOnly,
    /// Mode is `gpu` but the device set has no usable non-CPU device.
    GpuUnavailable,
}

/// The number of GPU layers to request for a projection.
///
/// `FullOffload` ⇒ `u32::MAX` (the crate clamps to `i32::MAX` = every layer);
/// `CpuOnly` ⇒ `0`. `GpuUnavailable` never reaches this function — the refusal
/// happens first.
pub fn gpu_layers_for(projection: ModeProjection) -> u32 {
    match projection {
        ModeProjection::FullOffload => u32::MAX,
        ModeProjection::CpuOnly | ModeProjection::GpuUnavailable => 0,
    }
}

/// Project a requested backend mode onto a device set.
///
/// * `cpu` ⇒ [`ModeProjection::CpuOnly`] regardless of devices.
/// * `gpu` ⇒ [`ModeProjection::FullOffload`] when a usable GPU exists,
///   otherwise [`ModeProjection::GpuUnavailable`] (a typed refusal, NEVER a
///   silent CPU fallback — AC-25).
/// * `auto` ⇒ [`ModeProjection::FullOffload`] when a usable GPU exists,
///   otherwise [`ModeProjection::CpuOnly`] (AC-23: a GPU-less machine still
///   starts).
pub fn project(mode: CompanionBackendMode, devices: &[CompanionDeviceInfo]) -> ModeProjection {
    match mode {
        CompanionBackendMode::Cpu => ModeProjection::CpuOnly,
        CompanionBackendMode::Gpu => {
            if has_usable_gpu(devices) {
                ModeProjection::FullOffload
            } else {
                ModeProjection::GpuUnavailable
            }
        }
        CompanionBackendMode::Auto => {
            if has_usable_gpu(devices) {
                ModeProjection::FullOffload
            } else {
                ModeProjection::CpuOnly
            }
        }
    }
}

/// The typed error for a projection that refuses to start, if any.
pub fn projection_error(projection: ModeProjection) -> Option<CompanionEngineErrorCode> {
    match projection {
        ModeProjection::GpuUnavailable => Some(CompanionEngineErrorCode::GpuUnavailable),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cpu_device() -> CompanionDeviceInfo {
        CompanionDeviceInfo {
            name: "CPU".to_string(),
            description: "CPU".to_string(),
            device_type: CompanionBackendKind::Cpu,
            memory_free_bytes: 0,
            memory_total_bytes: 0,
        }
    }

    fn gpu_device() -> CompanionDeviceInfo {
        CompanionDeviceInfo {
            name: "CUDA0".to_string(),
            description: "NVIDIA GeForce RTX 4090".to_string(),
            device_type: CompanionBackendKind::Gpu,
            memory_free_bytes: 20_000_000_000,
            memory_total_bytes: 25_000_000_000,
        }
    }

    // ── The PURE force-CPU rule (never skipped; needs no hardware) ───────────

    #[test]
    fn force_cpu_accepts_every_non_blank_non_false_token() {
        for value in ["1", "true", " TRUE ", "yes", "on", "anything"] {
            assert!(
                force_cpu_with(Some(value)),
                "expected {value:?} to engage the force-CPU lever"
            );
        }
    }

    #[test]
    fn force_cpu_is_inert_when_unset_blank_zero_or_false() {
        for value in [None, Some(""), Some("   "), Some("0"), Some("false"), Some(" FALSE ")] {
            assert!(
                !force_cpu_with(value),
                "expected {value:?} to leave the lever inert"
            );
        }
    }

    // ── The enumeration-seam coercion ────────────────────────────────────────

    #[test]
    fn forced_enumeration_is_exactly_one_cpu_device() {
        let coerced = apply_force_cpu(vec![gpu_device(), cpu_device()], true);
        assert_eq!(coerced, forced_cpu_devices());
        assert_eq!(coerced.len(), 1);
        assert_eq!(coerced[0].device_type, CompanionBackendKind::Cpu);
        assert_eq!(report_backend(&coerced), Some(CompanionBackendKind::Cpu));
    }

    /// The INERT-UNSET control: with the lever off the enumeration (and the
    /// reported backend) is byte-identical to the unforced path.
    #[test]
    fn unset_enumeration_is_byte_identical_to_the_unforced_path() {
        let devices = vec![gpu_device(), cpu_device()];
        let coerced = apply_force_cpu(devices.clone(), false);
        assert_eq!(coerced, devices);
        assert_eq!(report_backend(&coerced), Some(CompanionBackendKind::Gpu));
    }

    // ── Mode projection on a FORCED enumeration (the engine-level guarantee) ──

    /// AC-23: a forced CPU-only set starts in `auto` mode (CPU fallback).
    #[test]
    fn auto_mode_starts_on_a_forced_cpu_enumeration() {
        let forced = apply_force_cpu(vec![gpu_device()], true);
        let projection = project(CompanionBackendMode::Auto, &forced);
        assert_eq!(projection, ModeProjection::CpuOnly);
        assert_eq!(gpu_layers_for(projection), 0);
        assert_eq!(projection_error(projection), None);
    }

    /// AC-25: a forced CPU-only set refuses `gpu` mode with `GpuUnavailable`.
    #[test]
    fn gpu_mode_refuses_a_forced_cpu_enumeration() {
        let forced = apply_force_cpu(vec![gpu_device()], true);
        let projection = project(CompanionBackendMode::Gpu, &forced);
        assert_eq!(projection, ModeProjection::GpuUnavailable);
        assert_eq!(
            projection_error(projection),
            Some(CompanionEngineErrorCode::GpuUnavailable)
        );
    }

    #[test]
    fn cpu_mode_is_zero_offload_on_any_enumeration() {
        for devices in [vec![gpu_device()], vec![cpu_device()], Vec::new()] {
            assert_eq!(project(CompanionBackendMode::Cpu, &devices), ModeProjection::CpuOnly);
            assert_eq!(gpu_layers_for(ModeProjection::CpuOnly), 0);
        }
    }

    #[test]
    fn auto_and_gpu_request_full_offload_when_a_gpu_is_present() {
        for mode in [CompanionBackendMode::Auto, CompanionBackendMode::Gpu] {
            let projection = project(mode, &[gpu_device(), cpu_device()]);
            assert_eq!(projection, ModeProjection::FullOffload);
            assert_eq!(gpu_layers_for(projection), u32::MAX);
            assert_eq!(projection_error(projection), None);
        }
    }

    #[test]
    fn auto_mode_falls_back_to_cpu_without_a_gpu() {
        assert_eq!(
            project(CompanionBackendMode::Auto, &[cpu_device()]),
            ModeProjection::CpuOnly
        );
        assert_eq!(project(CompanionBackendMode::Auto, &[]), ModeProjection::CpuOnly);
    }

    #[test]
    fn reported_backend_never_over_claims_a_gpu() {
        assert_eq!(report_backend(&[cpu_device()]), Some(CompanionBackendKind::Cpu));
        assert_eq!(report_backend(&[]), None);
        assert_eq!(
            report_backend(&[cpu_device(), gpu_device()]),
            Some(CompanionBackendKind::Gpu)
        );
    }

    #[test]
    fn an_integrated_gpu_counts_as_usable_non_cpu() {
        let integrated = CompanionDeviceInfo {
            name: "Vulkan0".to_string(),
            description: "Intel Iris Xe".to_string(),
            device_type: CompanionBackendKind::IntegratedGpu,
            memory_free_bytes: 1,
            memory_total_bytes: 2,
        };
        assert!(has_usable_gpu(&[integrated.clone()]));
        assert_eq!(
            project(CompanionBackendMode::Gpu, &[integrated]),
            ModeProjection::FullOffload
        );
    }
}
