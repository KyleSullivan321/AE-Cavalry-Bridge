# Third-party files NOT included in this repo

The panel renders Cavalry scenes with **Cavalry's own Web Player runtime**. Those files
belong to Cavalry (Scene Group Ltd), are not covered by this repo's MIT license, and are
not redistributed here. Get them from the official Web Player package
(<https://docs.cavalry.scenegroup.co/web-player/>) and place them in this folder:

| File | Where it comes from |
|------|---------------------|
| `wasm-lib/CavalryWasm.js`, `CavalryWasm.wasm`, `CavalryWasm.data`, `version.json` | Cavalry Web Player package, `wasm-lib/` (built with `Cavalry 2.6.0` for this project) |
| `webcodec-helper.js` | Cavalry Web Player package, `video-asset/` (only needed for video footage) |
| `mp4box.all.js` | Bundled with the Web Player package; imported by `webcodec-helper.js` |

Included here: `CSInterface.js` is Adobe's CEP helper (from
[Adobe-CEP/CEP-Resources](https://github.com/Adobe-CEP/CEP-Resources)) and remains under Adobe's terms.
