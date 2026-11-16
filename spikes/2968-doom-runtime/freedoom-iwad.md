# ST-1 raw capture — Freedoom IWAD

- **Issue:** #2968 · **Date:** 2026-10-03
- **Question:** Source URL + SHA-256 for the libre IWAD used as the default game data.

## Project

**Freedoom** — "an entirely free/libre game for the *Doom* engine", providing all the content (art,
maps, sounds, music) needed to play without the proprietary retail WADs. It is the **libre IWAD
substitute** the plan selects as the default. Licensed under an open license (see the project's
`COPYING.adoc`, BSD-style); the retail `DOOM.WAD`/`DOOM2.WAD` are proprietary and are **never**
downloaded or redistributed by Fredo (user-supplied only).

## Pinned artifact

| Field | Value |
|-------|-------|
| Release | Freedoom **0.13.0** (latest; published 2024-01-29) |
| Git tag | `v0.13.0` (commit `cfb8644b1a8dc7d7d2177e6a892ccaa2922bdaae`) |
| Download URL | `https://github.com/freedoom/freedoom/releases/download/v0.13.0/freedoom-0.13.0.zip` |
| Network-transfer size | **24,143,781 bytes** (release asset metadata) |
| **SHA-256** | `3f9b264f3e3ce503b4fb7f6bdcb1f419d93c7b546f4df3e874dd878db9688f59` |
| Checksum source | `https://github.com/freedoom/freedoom/releases/download/v0.13.0/freedoom-0.13.0-CHECKSUM` (a **PGP-signed** message; digest copied verbatim from it) |
| Signature asset | `freedoom-0.13.0.zip.sig` (detached signature of the zip) |

Verification chain: the release publishes both a detached PGP signature (`freedoom-0.13.0.zip.sig`)
and a PGP-signed checksum file (`freedoom-0.13.0-CHECKSUM`) containing the SHA-256 above. An
acquisition may verify the SHA-256 directly; a stricter consumer may additionally verify the signed
checksum.

## Contents (what the acquisition must extract)

The zip contains the single-player IWADs (names per the 0.9+ rename):

- `freedoom1.wad` — **Freedoom: Phase 1**, compatible with *The Ultimate Doom* (episode/map, e.g.
  `-warp 1 1`).
- `freedoom2.wad` — **Freedoom: Phase 2**, compatible with *Doom II* (map only, e.g. `-warp 1`).

For Slice 1 the default is **`freedoom1.wad`** (Ultimate-Doom-shaped, matches the plan's `-warp 1 1`).

## Notes

- The download page also offers `freedm-0.13.0.zip` (FreeDM, deathmatch, no monsters) — **not**
  used by this slice.
- SHA-256 is the pin; the release's own checksum file is the oracle, so ST-4's manifest constant
  should carry exactly the digest above.
- Freedoom's engine recommendation page does **not** cover the RESTful-DOOM fork; the fork runs
  Chocolate Doom, which supports the Freedoom single-player IWADs (Chocolate Doom 3.1.0 release
  notes: "The Freedoom single-player IWAD files are now officially supported").
