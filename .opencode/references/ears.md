# EARS Syntax Reference

> On-demand reference for Architect and Reviewer. Loaded when writing or reviewing specs.

Every requirement follows:
> While `<optional precondition>`, when `<optional trigger>`, the `<system name>` shall `<system response>`

| Pattern | Syntax | Example |
|---------|--------|---------|
| Ubiquitous | The `<system>` shall `<response>` | The system shall display a loading indicator |
| State-Driven | While `<precondition>`, the `<system>` shall `<response>` | While offline, the system shall show offline banner |
| Event-Driven | When `<trigger>`, the `<system>` shall `<response>` | When the user clicks save, the system shall persist |
| Optional Feature | Where `<feature>`, the `<system>` shall `<response>` | Where dark mode is enabled, the system shall use dark tokens |
| Unwanted Behaviour | If `<trigger>`, then the `<system>` shall `<response>` | If the input is invalid, then the system shall display error |
| Complex | While `<precondition>`, when `<trigger>`, the `<system>` shall `<response>` | While offline, when user submits, the system shall queue |

## Requirement ID Convention

- `REQ-1`, `REQ-2`, etc. — globally unique per spec
- Every REQ must appear in exactly one capsule
- No REQ should be duplicated across capsules
