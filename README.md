# Cavalry Bridge

Move work between **After Effects** and **[Cavalry](https://cavalry.studio)** without the
render/export/import round-trip - as *editable layers* in both directions, keyframes and
easing included.

It has two parts, and both run on the same machine:

- `extension/` - a CEP panel for After Effects (**Window > Extensions > Cavalry Bridge**).
- `cavalry/bridge-importer.js` - a script for Cavalry that runs a small local server (port 8090) the panel talks to.

## What it does

**Cavalry -> After Effects**
- **Bake -> AE layer** - the panel embeds Cavalry's Web Player (WebAssembly), renders your `.cv` to a PNG sequence and imports it. Pixel-accurate. With *Auto-bake on change*, every save in Cavalry refreshes the AE comp.
- **Import Cavalry layers** - rebuilds the active Cavalry comp as editable AE layers: shapes, text, footage, groups (as nulls, parenting kept), transforms, keyframes and easing, including custom curves. Procedural layers (duplicators, staggers, deformers...) have no AE equivalent and are skipped - use Bake for those.

**After Effects -> Cavalry** (needs the Cavalry script running)
- **Send AE comp -> Cavalry (img seq)** - flat render, loaded as footage.
- **Send comp layers -> Cavalry** - editable footage, text, solids, ellipses/rectangles with transforms and keyframe easing. Effects, expressions, masks, mattes, blend modes and layer styles are dropped (listed in the panel).
- **Send image/video -> Cavalry** - selected footage.

> Bake is a *bake bridge*, not a real-time link: Cavalry exposes no per-frame render API to AE. Only **saved** Cavalry changes are picked up.

## Setup

Requires After Effects 2024-2026 and Cavalry 2.5+ on Windows or macOS.

1. **Get Cavalry's Web Player files.** They are not redistributed in this repo - follow [extension/lib/README.md](extension/lib/README.md).
2. **Allow unsigned CEP extensions (one time).**
   - Windows: add a String value `PlayerDebugMode` = `1` under `HKCU\Software\Adobe\CSXS.12` (and `CSXS.11` for older AE).
   - macOS: `defaults write com.adobe.CSXS.12 PlayerDebugMode 1` (and `.11`).
3. **Install the panel.** Copy `extension/` to
   - Windows: `%APPDATA%\Adobe\CEP\extensions\studio.bridge.cavalry` (or run `tools/redeploy.ps1`)
   - macOS: `~/Library/Application Support/Adobe/CEP/extensions/studio.bridge.cavalry`

   Restart After Effects, then open **Window > Extensions > Cavalry Bridge**.
4. **Install the Cavalry script** (only for AE -> Cavalry and *Import Cavalry layers*). In Cavalry: **Help > Show Scripts Folder**, copy a `cavalry-bridge` folder containing `bridge-importer.js` there, then run it from **Window > Scripts**. Keep its panel open, and run it again each time Cavalry starts.

## Building a signed ZXP

`packaging/build-zxp.sh` stages `extension/` and signs it with Adobe's free
[ZXPSignCmd](https://github.com/Adobe-CEP/CEP-Resources/tree/master/ZXPSignCMD). A self-signed
certificate is generated on first run and is git-ignored - never commit certificates.

## Limits

One Cavalry scene <-> one AE comp at a time; both apps on one machine; H.264 for video footage.

## License

[MIT](LICENSE) (c) Kyle Sullivan. Cavalry's Web Player runtime and Adobe's `CSInterface.js` are
third-party and keep their own terms.
