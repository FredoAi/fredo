# ST-1 provenance — sources consulted

- **Issue:** #2968 · **Retrieval date:** 2026-10-03 (all URLs fetched this date)
- All content is treated as **untrusted data**; only the facts cited in the captures are used.

| URL | What it is | Used for |
|-----|------------|----------|
| `https://github.com/mkschreder/restful-doom/releases` | The cited fork's release index | Engine finding: **0 releases** |
| `https://github.com/mkschreder/restful-doom` | The cited fork's repo page | Repo is source-only; README + file list |
| `https://raw.githubusercontent.com/mkschreder/restful-doom/master/README.md` | The fork's README | Launch argv, agent API surface, build steps, GPL/source-only posture |
| `https://raw.githubusercontent.com/mkschreder/restful-doom/master/RAML/doom.raml` | The fork's RAML 1.0 API spec | Exact `GET /api/state`, `POST /api/step`, `GET /api/frame`, `POST /api/episode` shapes; base URI |
| `https://raw.githubusercontent.com/mkschreder/restful-doom/master/configure.ac` | Autotools configure | Engine deps (SDL2 ≥ 2.0.2, SDL2_mixer, SDL2_net, libsamplerate/libpng optional); GPL-2.0 license line |
| `https://raw.githubusercontent.com/mkschreder/restful-doom/master/configure-and-build.sh` | Dependency/bootstrap script | Build path (`chocpkg`), `make` |
| `https://github.com/jeff-1amstudios/restful-doom/releases` | Upstream fork's release index | Engine finding: **0 releases** (confirms no upstream prebuilt) |
| `https://github.com/chocolate-doom/chocolate-doom/releases` | Upstream engine's release index | Confirms Chocolate Doom ships Windows binaries but has **no HTTP API** — not a substitute |
| `https://raw.githubusercontent.com/chocolate-doom/chocolate-doom/master/README.md` | Upstream engine README | GPL distribution note |
| `https://github.com/chocolate-doom/chocpkg` | The dependency-builder project | Build-recipe context (shell scripts; Linux/macOS-oriented) |
| `https://freedoom.github.io/download.html` | Freedoom download page | IWAD zip URL; checksum pointer |
| `https://github.com/freedoom/freedoom/releases` | Freedoom release index | Release 0.13.0 is latest; tag |
| `https://api.github.com/repos/freedoom/freedoom/releases/tags/v0.13.0` | Freedoom release API | Asset list + sizes (zip 24,143,781 B; CHECKSUM asset) |
| `https://github.com/freedoom/freedoom/releases/download/v0.13.0/freedoom-0.13.0-CHECKSUM` | PGP-signed checksum | **SHA-256 of `freedoom-0.13.0.zip`** |

## Notes

- The planning sandbox's "no arbitrary network" assessment did **not** apply to the implementation
  sandbox: `webfetch` reached all of the above. The **binary-download / C-toolchain** limitation did
  apply and is recorded in the decision doc.
- The fork's README points its RAML link at `jeff-1amstudios/restful-doom`; the fetched spec is the
  same `RAML/doom.raml` present in `mkschreder/restful-doom` (the cited fork).
