//! The structural expectation evaluator (Spec #3232, ST-1; AC-2).
//!
//! Every fixture's result is a boolean decided by comparing the turn's OUTCOME
//! against the fixture's OWN [`Expectation`](super::Expectation) — an expected
//! tool call (name + required arguments) or a schema-validity predicate
//! (named top-level required fields present). Nothing here reads prose, scores
//! similarity, or consults a second model: the evaluator is a deterministic pure
//! function of `(expectation, observed_outcome)`.
//!
//! ## Why the outcome is the runner's view, not raw engine events
//!
//! The runner drains `EngineEvent`s and reduces them to an [`ObservedTurn`]: the
//! decoded tool calls, the turn's visible content, and any typed failure. The
//! evaluator is then model-free and engine-free, so it is unit-pinnable in full
//! (including the mandatory **wrong-expectation control**: a deliberately-wrong
//! expectation MUST fail, without which a green run proves nothing).

use super::Expectation;

/// One decoded tool call the runner observed for a turn.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ObservedCall {
    /// The decoded function name (absent when the template produced none).
    pub name: Option<String>,
    /// The decoded argument JSON string (absent when the call carried none).
    pub arguments: Option<String>,
}

/// The runner's reduced view of one settled turn.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ObservedTurn {
    /// The decoded tool calls (empty for a content/schema turn).
    pub calls: Vec<ObservedCall>,
    /// The turn's visible content (the JSON object for a schema turn).
    pub content: String,
    /// The typed failure detail, when the turn failed before it could settle.
    pub failure: Option<String>,
}

/// The evaluator's verdict for one fixture.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExpectationOutcome {
    /// Whether the observed outcome satisfied the fixture's expectation.
    pub passed: bool,
    /// A diagnostic detail that NAMES why the expectation failed; `""` on pass.
    /// Purely diagnostic — it never decides `passed`.
    pub detail: String,
}

impl ExpectationOutcome {
    fn pass() -> Self {
        Self {
            passed: true,
            detail: String::new(),
        }
    }

    fn fail(detail: impl Into<String>) -> Self {
        Self {
            passed: false,
            detail: detail.into(),
        }
    }
}

/// Decide one fixture's result by comparing `observed` against `expectation`.
pub fn evaluate(expectation: &Expectation, observed: &ObservedTurn) -> ExpectationOutcome {
    // A turn that failed before settling can never satisfy an expectation: the
    // typed failure is the detail (diagnostic; the verdict is `false`).
    if let Some(detail) = &observed.failure {
        return ExpectationOutcome::fail(format!("the turn failed: {detail}"));
    }
    match expectation {
        Expectation::Call {
            name,
            required_args,
        } => evaluate_call(name, required_args, observed),
        Expectation::Schema { name, require } => evaluate_schema(name, require, observed),
    }
}

/// A `Call` expectation: a call with `name` carrying every `required_args` pair
/// must be present.
///
/// A required argument VALUE is an **identity** the product resolves
/// case-insensitively (`launcherEnterAction.ts`'s `appNameMatches` lowercases
/// both sides; the CLI's `open_app` states "matching is case-insensitive"), so
/// the observed JSON string is `trim`med and Unicode-lowercased before
/// comparison — mirroring the product's `toLowerCase()` (and
/// `normalizeAppQuery`'s trim). Case and surrounding whitespace are the ONLY
/// relaxation: a DIFFERENT argument value still fails. The call NAME is
/// structural (an exact tool id), so it is compared exactly.
fn evaluate_call(
    name: &str,
    required_args: &[(&str, &str)],
    observed: &ObservedTurn,
) -> ExpectationOutcome {
    let named: Vec<&ObservedCall> = observed
        .calls
        .iter()
        .filter(|call| call.name.as_deref() == Some(name))
        .collect();
    if named.is_empty() {
        let seen: Vec<String> = observed
            .calls
            .iter()
            .map(|call| call.name.clone().unwrap_or_else(|| "<unnamed>".to_string()))
            .collect();
        return ExpectationOutcome::fail(format!(
            "expected a `{name}` call; observed calls: {seen:?}"
        ));
    }
    for call in &named {
        let Some(raw) = call.arguments.as_deref() else {
            continue;
        };
        let Ok(arguments) = serde_json::from_str::<serde_json::Value>(raw) else {
            continue;
        };
        let satisfied = required_args.iter().all(|(key, value)| {
            arguments
                .get(*key)
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .map(str::to_lowercase)
                == Some(value.to_lowercase())
        });
        if satisfied {
            return ExpectationOutcome::pass();
        }
    }
    let observed_args: Vec<Option<&str>> = named
        .iter()
        .map(|call| call.arguments.as_deref())
        .collect();
    ExpectationOutcome::fail(format!(
        "a `{name}` call was present but its arguments did not satisfy \
         {required_args:?}; observed argument JSON: {observed_args:?}"
    ))
}

/// A `Schema` expectation: the turn's content must be a JSON object carrying
/// every named top-level required field.
fn evaluate_schema(name: &str, require: &[&str], observed: &ObservedTurn) -> ExpectationOutcome {
    let trimmed = observed.content.trim();
    let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) else {
        return ExpectationOutcome::fail(format!(
            "expected a `{name}` JSON object; content was not valid JSON: {trimmed:?}"
        ));
    };
    let Some(object) = value.as_object() else {
        return ExpectationOutcome::fail(format!(
            "expected a `{name}` JSON object; content was a non-object JSON value: {trimmed:?}"
        ));
    };
    let missing: Vec<&str> = require
        .iter()
        .copied()
        .filter(|field| !object.contains_key(*field))
        .collect();
    if missing.is_empty() {
        ExpectationOutcome::pass()
    } else {
        ExpectationOutcome::fail(format!(
            "the `{name}` object is missing required top-level field(s) {missing:?}: {trimmed:?}"
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(name: &str, arguments: &str) -> ObservedCall {
        ObservedCall {
            name: Some(name.to_string()),
            arguments: Some(arguments.to_string()),
        }
    }

    /// THE MANDATORY WRONG-EXPECTATION CONTROL (unit tier).
    ///
    /// A matched expectation passes and its deliberately-WRONG twin FAILS — for
    /// every way an expectation can be wrong (wrong NAME, wrong ARG, missing
    /// required schema field). Without this control a green run proves nothing.
    #[test]
    fn the_wrong_expectation_control_fails_the_mismatched_twin() {
        let open_app = ObservedTurn {
            calls: vec![call("open_app", r#"{"app":"Mission Monitor"}"#)],
            content: String::new(),
            failure: None,
        };

        // Matched CALL expectation ⇒ PASS.
        assert!(
            evaluate(
                &Expectation::Call {
                    name: "open_app",
                    required_args: &[("app", "Mission Monitor")],
                },
                &open_app
            )
            .passed
        );

        // Wrong NAME ⇒ FAIL.
        assert!(
            !evaluate(
                &Expectation::Call {
                    name: "close_app",
                    required_args: &[("app", "Mission Monitor")],
                },
                &open_app
            )
            .passed
        );

        // Right name, wrong ARG value ⇒ FAIL.
        assert!(
            !evaluate(
                &Expectation::Call {
                    name: "open_app",
                    required_args: &[("app", "Settings")],
                },
                &open_app
            )
            .passed
        );

        // Right name, required ARG absent ⇒ FAIL.
        assert!(
            !evaluate(
                &Expectation::Call {
                    name: "open_app",
                    required_args: &[("target", "Mission Monitor")],
                },
                &open_app
            )
            .passed
        );

        let doom = ObservedTurn {
            calls: Vec::new(),
            content: r#"{"steps":[{"op":"move","bearing":10,"distance":5}]}"#.to_string(),
            failure: None,
        };

        // Matched SCHEMA expectation ⇒ PASS.
        assert!(
            evaluate(
                &Expectation::Schema {
                    name: "doom_plan",
                    require: &["steps"],
                },
                &doom
            )
            .passed
        );

        // A required schema field that is ABSENT ⇒ FAIL.
        assert!(
            !evaluate(
                &Expectation::Schema {
                    name: "doom_plan",
                    require: &["steps", "reasoning"],
                },
                &doom
            )
            .passed
        );
    }

    /// ST-6: a `Call` argument VALUE is an identity the product resolves
    /// case-insensitively, so the observed value is matched after trimming and
    /// Unicode-lowercasing — the instrument fix that stops the harness measuring
    /// string case. The comparison can still FAIL (a different app name fails).
    #[test]
    fn a_call_argument_is_matched_case_insensitively_like_the_product() {
        let expected = Expectation::Call {
            name: "open_app",
            required_args: &[("app", "Mission Monitor")],
        };

        // The committed image renders upper case; the expectation is title case.
        // The product resolves them to the SAME application, so the harness must.
        let upper = ObservedTurn {
            calls: vec![call("open_app", r#"{"app":"MISSION MONITOR"}"#)],
            ..ObservedTurn::default()
        };
        assert!(
            evaluate(&expected, &upper).passed,
            "an upper-case identity must match the title-case expectation"
        );

        // Surrounding whitespace is ignored too (mirrors `normalizeAppQuery`'s trim).
        let spaced = ObservedTurn {
            calls: vec![call("open_app", r#"{"app":"  mission monitor  "}"#)],
            ..ObservedTurn::default()
        };
        assert!(
            evaluate(&expected, &spaced).passed,
            "a trimmed, differently-cased identity must match"
        );

        // A DIFFERENT application still FAILS — the case-insensitivity is the
        // ONLY relaxation, so the assertion is not made unfalsifiable.
        let other = ObservedTurn {
            calls: vec![call("open_app", r#"{"app":"Settings"}"#)],
            ..ObservedTurn::default()
        };
        assert!(
            !evaluate(&expected, &other).passed,
            "a different app name must still fail"
        );
    }

    /// A turn that failed before settling can never satisfy ANY expectation, and
    /// the failure is the detail (never a silent pass).
    #[test]
    fn a_failed_turn_never_passes() {
        let failed = ObservedTurn {
            calls: vec![call("open_app", r#"{"app":"Mission Monitor"}"#)],
            content: r#"{"steps":[]}"#.to_string(),
            failure: Some("the model could not be loaded".to_string()),
        };
        for expectation in [
            Expectation::Call {
                name: "open_app",
                required_args: &[],
            },
            Expectation::Schema {
                name: "doom_plan",
                require: &["steps"],
            },
        ] {
            let outcome = evaluate(&expectation, &failed);
            assert!(!outcome.passed, "{expectation:?}");
            assert!(outcome.detail.contains("the turn failed"), "{outcome:?}");
        }
    }

    /// An empty `required_args` list means "a call with this name, arguments
    /// irrelevant" — but the call must still be present.
    #[test]
    fn an_empty_required_args_list_still_requires_the_call() {
        let with_call = ObservedTurn {
            calls: vec![call("doom_mode", "{}")],
            content: String::new(),
            failure: None,
        };
        assert!(
            evaluate(
                &Expectation::Call {
                    name: "doom_mode",
                    required_args: &[],
                },
                &with_call
            )
            .passed
        );
        let without_call = ObservedTurn::default();
        assert!(
            !evaluate(
                &Expectation::Call {
                    name: "doom_mode",
                    required_args: &[],
                },
                &without_call
            )
            .passed
        );
    }

    /// The detail is diagnostic only: a passing outcome always carries `""`,
    /// and a failing outcome always NAMES the reason.
    #[test]
    fn the_detail_is_diagnostic_only() {
        let turn = ObservedTurn {
            calls: vec![call("open_app", r#"{"app":"Mission Monitor"}"#)],
            content: String::new(),
            failure: None,
        };
        let pass = evaluate(
            &Expectation::Call {
                name: "open_app",
                required_args: &[("app", "Mission Monitor")],
            },
            &turn,
        );
        assert!(pass.passed);
        assert_eq!(pass.detail, "");

        let fail = evaluate(
            &Expectation::Schema {
                name: "fredo_reply",
                require: &["reply"],
            },
            &turn,
        );
        assert!(!fail.passed);
        assert!(!fail.detail.is_empty());
    }
}
