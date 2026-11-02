// Cavalry Bridge panel. Loads a .cv in the Web Player, bakes frames to a PNG
// sequence via Node fs, and imports them into the active AE comp via ExtendScript.
// Pixel-readback path proven by the Phase 0 spike (see memory).

const cs = new CSInterface()
const fs = cep_node.require('fs')
const path = cep_node.require('path')
const os = cep_node.require('os')
const Buffer = cep_node.Buffer

const $ = (id) => document.getElementById(id)
const logEl = $('log')
const log = (m, cls) => {
  const line = document.createElement('div')
  if (cls) line.className = cls
  line.textContent = m
  logEl.appendChild(line)
  logEl.scrollTop = logEl.scrollHeight
}
const status = (m) => { $('status').textContent = m }

// --- state ---
let Module = null          // WASM module
let player = null          // Cavalry player instance
let surface = null         // preview WebGL surface
let scenePath = null       // path to the .cv on disk
let bakeDir = null         // where the PNG sequence is written
let bakeSlot = 'b'         // ping-pong slot ('a'/'b') so paths change each bake
let selectedComp = null    // chosen composition id (multi-comp scenes)
let baking = false

const extRoot = cs.getSystemPath(SystemPath.EXTENSION)

// Re-eval our ExtendScript on boot so updates take effect (CEP's manifest
// ScriptPath auto-load doesn't reliably pick up changes).
cs.evalScript('$.evalFile(new File("' + extRoot.replace(/\\/g, '/') + '/jsx/ae.jsx"))')
cs.evalScript('$.evalFile(new File("' + extRoot.replace(/\\/g, '/') + '/jsx/comp-export.jsx"))')
cs.evalScript('$.evalFile(new File("' + extRoot.replace(/\\/g, '/') + '/jsx/cavalry-import.jsx"))')

// webcodec helper (video). Loaded lazily; null until first needed.
let webcodec = null
let webcodecHooked = false
// Build a file:// URL from an absolute path, cross-platform. Windows paths start
// with a drive letter (file:///C:/...); macOS/Linux start with / (file:///Users/...).
function fileUrl(absPath) {
  let p = absPath.replace(/\\/g, '/')
  if (p[0] !== '/') p = '/' + p // Windows "C:/..." needs a leading slash; *nix already has one
  return 'file://' + encodeURI(p)
}

async function getWebcodec() {
  if (!webcodec) {
    // absolute file:// URL from the extension root — relative specifiers resolve
    // against the wrong base in CEP's hybrid context (drops the extension folder).
    const url = fileUrl(path.join(extRoot, 'lib', 'webcodec-helper.js'))
    try { webcodec = await import(url) }
    catch (e) { log('video helper unavailable: ' + e, 'err'); webcodec = false }
  }
  return webcodec
}

// --- WASM init ---
async function initModule() {
  if (Module) return Module
  log('loading Web Player runtime…')
  // locateFile must be an absolute path: CEP's hybrid context resolves data
  // files via the wrong base (cwd) otherwise. extRoot is the extension folder.
  const libDir = path.join(extRoot, 'lib', 'wasm-lib')
  const wasm = await import('../lib/wasm-lib/CavalryWasm.js')
  Module = await wasm.default({
    locateFile: (p) => path.join(libDir, p),
    print: (t) => log(t),
    printErr: (t) => log(t, 'err'),
  })
  log('runtime ready')
  return Module
}

async function loadScene(p) {
  await loadSceneInner(p)
  // re-arm the watcher onto the newly loaded file if auto is on (it was
  // previously stuck watching the prior scene, or nothing).
  if ($('auto').checked) setWatch(true)
}

// Parse the .cv (JSON) for its compositions. The Web Player API has setActiveComp
// but NO listComps, so we read the comp nodes directly from the file.
// Returns [{id, name}], active comp first if known.
function parseComps(buf) {
  try {
    const j = JSON.parse(Buffer.from(buf).toString('utf8'))
    const comps = (j.nodes || [])
      .filter((n) => n.nodeType === 'compNode')
      .map((n) => ({
        id: n.nodeId,
        name: (n.attributes && n.attributes.niceName && n.attributes.niceName.value) || n.nodeId,
      }))
    const active = j.activeComp
    comps.sort((a, b) => (a.id === active ? -1 : b.id === active ? 1 : 0))
    return comps
  } catch (e) { return [] }
}

function populateCompPicker(comps) {
  const sel = $('comp')
  sel.innerHTML = ''
  for (const c of comps) {
    const o = document.createElement('option')
    o.value = c.id; o.textContent = c.name
    sel.appendChild(o)
  }
  // show the picker only when there's a real choice
  $('compRow').style.display = comps.length > 1 ? '' : 'none'
}

// Resolve a Cavalry asset filePath to an absolute disk path. The stored form is
// like "@project/..\\..\\foo.png" where @project is the Cavalry project root —
// which we don't reliably know — so we try several bases and the tail-after-..,
// returning the first that exists on disk. Returns null if none found.
function resolveAssetPath(filePath, sceneDir) {
  if (!filePath) return null
  let fp = filePath.replace(/\\/g, '/')
  // @assets/ = the scene's own assets folder; @project/ = Cavalry project root.
  if (fp.indexOf('@assets/') === 0) {
    const cand = path.resolve(sceneDir, 'assets', fp.slice('@assets/'.length))
    if (fs.existsSync(cand)) return cand
    // some scenes store @assets relative to scene dir directly
    const cand2 = path.resolve(sceneDir, fp.slice('@assets/'.length))
    if (fs.existsSync(cand2)) return cand2
  }
  fp = fp.replace(/^@project\//, '').replace(/^@assets\//, '')
  if (path.isAbsolute(fp) && fs.existsSync(fp)) return fp

  // the "real" relative part is whatever follows the leading ../ sequence
  const tail = fp.replace(/^(\.\.\/)+/, '')
  const homed = process.env.USERPROFILE || process.env.HOME || ''
  const candidates = [
    path.resolve(sceneDir, fp),       // straight relative to the .cv
    path.resolve(sceneDir, 'assets', path.basename(fp)), // in an assets subfolder
    homed && path.join(homed, tail),  // tail relative to home (@project case)
    path.resolve(sceneDir, tail),     // tail relative to the .cv
  ].filter(Boolean)
  for (const c of candidates) { if (fs.existsSync(c)) return c }
  return null
}

// videoAssetIds present in the currently loaded scene (so the bake loop knows to
// wait for decoded video frames).
let videoAssets = []

// Load the scene's external assets into the WASM filesystem so footage renders
// (otherwise images/video bake out blank). Driven by Module.pendingAssets — the
// player's authoritative list of {type, assetId, filename} — cross-referenced
// with the .cv `assets` array (assetId -> filePath) to locate files on disk.
// Video assets go through the WebCodecs helper (decode + feed frames).
async function loadSceneAssets(sceneBuf, scenePathAbs) {
  const result = { loaded: 0, missing: 0, video: 0 }
  videoAssets = []
  let j
  try { j = JSON.parse(Buffer.from(sceneBuf).toString('utf8')) } catch (e) { return result }
  const sceneDir = path.dirname(scenePathAbs)

  // assetId -> stored filePath
  const pathById = {}
  for (const a of (j.assets || [])) {
    if (a && a.nodeId && a.data && a.data.filePath) pathById[a.nodeId] = a.data.filePath
  }

  // Images come through pendingAssets (gives filename + assetId the player wants);
  // video does NOT appear in pendingAssets, so we detect it from the .cv assets
  // array by file extension and load it via the WebCodecs helper.
  const VIDEO_RE = /\.(mp4|mov|m4v|webm)$/i

  // pass 1: images / svg / csv via pendingAssets
  const pa = Module.pendingAssets
  if (pa) {
    const n = (typeof pa.size === 'function') ? pa.size() : pa.length
    for (let i = 0; i < n; i++) {
      const asset = (typeof pa.get === 'function') ? pa.get(i) : pa[i]
      if (!asset) continue
      const type = asset.type, assetId = asset.assetId, filename = asset.filename
      const abs = resolveAssetPath(pathById[assetId] || filename, sceneDir)
      if (!abs) { result.missing++; continue }
      try {
        const bytes = new Uint8Array(fs.readFileSync(abs))
        Module.FS.writeFile(filename, bytes)
        if (type === 'image' && player.replaceImageAsset) player.replaceImageAsset(filename, assetId)
        else if (type === 'svg' && player.replaceSVGAsset) player.replaceSVGAsset(filename, assetId)
        else if (type === 'csv' && player.replaceCSVAsset) player.replaceCSVAsset(filename, assetId)
        result.loaded++
      } catch (e) { result.missing++; log('asset err (' + filename + '): ' + e, 'err') }
    }
  }

  // pass 2: video assets from the .cv assets array (dedup by file path)
  const seenVid = {}
  for (const a of (j.assets || [])) {
    if (!a || !a.data || !a.data.filePath || !VIDEO_RE.test(a.data.filePath)) continue
    const abs = resolveAssetPath(a.data.filePath, sceneDir)
    if (!abs) { result.missing++; continue }
    if (seenVid[a.nodeId]) continue
    seenVid[a.nodeId] = true
    try {
      const wc = await getWebcodec()
      if (!wc) { result.missing++; continue }
      if (!webcodecHooked) { wc.setupWebCodecHooks(videoShim()); webcodecHooked = true }
      const bytes = new Uint8Array(fs.readFileSync(abs))
      const url = URL.createObjectURL(new Blob([bytes.buffer]))
      await wc.loadWebCodecVideoAsset(videoShim(), a.nodeId, url)
      URL.revokeObjectURL(url)
      videoAssets.push(a.nodeId)
      result.video++
    } catch (e) { result.missing++; log('video load err (' + a.nodeId + '): ' + e, 'err') }
  }
  return result
}

// Shim matching what webcodec-helper needs from a CavalryPlayer instance.
function videoShim() {
  return { module: Module, player, render: () => { try { player.render(surface) } catch (e) {} } }
}

// Wait until the video decoder has frame N ready (or timeout). Returns true if ready.
async function waitForVideoFrame(frame, timeoutMs) {
  const va = window._videoAssets
  if (!va || videoAssets.length === 0) return true
  const deadline = Date.now() + (timeoutMs || 3000)
  while (Date.now() < deadline) {
    let allReady = true
    for (const id of videoAssets) {
      const a = va[id]
      if (!a || !Array.isArray(a.frameToDecode) || a.frameToDecode[frame] == null) { allReady = false; break }
    }
    if (allReady) return true
    await new Promise((r) => setTimeout(r, 8))
  }
  return false
}

async function loadSceneInner(p) {
  await initModule()
  scenePath = p
  const data = new Uint8Array(fs.readFileSync(p))
  Module.FS.writeFile('scene.cv', data)
  if (player) { try { player.delete && player.delete() } catch (e) {} }
  player = Module.Cavalry.MakeWithPath('scene.cv')
  window.__cavModule = Module; window.__cavPlayer = player // debug handles

  // load external assets (images into FS, video via WebCodecs) so footage renders
  const ar = await loadSceneAssets(data, p)
  if (ar.loaded || ar.missing || ar.video) {
    log(`assets: ${ar.loaded} loaded, ${ar.missing} missing, ${ar.video} video(skipped)`)
  }

  // discover comps and apply the chosen one (keep selection across re-bakes)
  const comps = parseComps(data)
  populateCompPicker(comps)
  if (comps.length) {
    // keep prior selection if still present, else default to active/first
    const want = (selectedComp && comps.some((c) => c.id === selectedComp)) ? selectedComp : comps[0].id
    selectedComp = want
    $('comp').value = want
    try { player.setActiveComp(want) } catch (e) {}
  }

  const res = player.getSceneResolution()
  const canvas = $('preview')
  canvas.width = res.width
  canvas.height = res.height
  // free the previous preview surface before making a new one — auto-bake reloads
  // the scene every cycle, and leaked surfaces exhaust the GL context mid-bake
  // (frames go blank ~30 in). Same .delete() requirement as the bake surface.
  try { if (surface && surface.delete) surface.delete() } catch (e) {}
  surface = Module.makeWebGLSurfaceFromElement(canvas, res.width, res.height)
  player.setFrame(player.getStartFrame())
  player.render(surface)

  $('scenePath').textContent = p
  $('scenePath').title = p
  $('bake').disabled = false
  $('auto').disabled = false
  status(`Loaded ${res.width}×${res.height}, frames ${player.getStartFrame()}–${player.getEndFrame()}`)
  log('scene loaded: ' + path.basename(p))
}

// --- bake: render every frame to PNG sequence ---
const blobToBuffer = (blob) => new Promise((resolve) => {
  const r = new FileReader()
  r.onload = () => resolve(Buffer.from(r.result))
  r.readAsArrayBuffer(blob)
})
const toBlob = (cv) => new Promise((r) => cv.toBlob(r, 'image/png', 1.0))

// Bake = render the comp with CAVALRY'S FULL RENDERER (not the Web Player, which
// can't render image sequences / PSD / some video). We ask the Cavalry bridge
// script to render the active comp to a PNG sequence, wait for its done-marker,
// then import the sequence into AE. The Web Player is used only for live preview.
// REQUIRES: Cavalry open with this scene + the bridge importer script running.
async function bake() {
  if (!player || baking) return
  baking = true
  $('bake').disabled = true

  const sceneName = path.basename(scenePath).replace(/\.cv$/i, '')
  const compSuffix = selectedComp ? '_' + selectedComp.replace(/[^a-z0-9]+/gi, '') : ''
  const base = sceneName + compSuffix
  // ping-pong dirs so AE never serves stale cached frames from a reused path
  bakeSlot = bakeSlot === 'a' ? 'b' : 'a'
  bakeDir = path.join(await storageRoot(), 'baked', base, bakeSlot)
  fs.mkdirSync(bakeDir, { recursive: true })
  // clear any old frames in this slot so the done-check counts only this render
  try { for (const f of fs.readdirSync(bakeDir)) fs.unlinkSync(path.join(bakeDir, f)) } catch (e) {}

  const doneMarker = path.join(bakeDir, '_done.txt')
  const start = player.getStartFrame(), end = player.getEndFrame()

  try {
    status('Rendering in Cavalry…')
    const t0 = Date.now()
    // ask Cavalry to render its ACTIVE comp (the bridged scene) to this folder.
    // comp:"active" — Cavalry renders whatever comp is active in the app.
    const ok = await requestCavalryRender({ outDir: bakeDir.replace(/\\/g, '/'), done: doneMarker.replace(/\\/g, '/') })
    if (!ok) {
      status('Render failed — is Cavalry open with this scene and the bridge script running?')
      return
    }
    const result = await waitForDoneMarker(doneMarker, 5 * 60 * 1000) // up to 5 min
    if (result == null) { status('Cavalry render timed out'); return }
    if (result.indexOf('OK') !== 0) { status('Cavalry render: ' + result); log('render: ' + result, 'err'); return }

    const pngs = fs.readdirSync(bakeDir).filter((f) => /\.png$/i.test(f)).sort()
    if (pngs.length === 0) { status('Render produced no frames'); return }
    const secs = ((Date.now() - t0) / 1000).toFixed(1)
    log(`Cavalry rendered ${pngs.length} frames in ${secs}s → ${bakeDir}`)

    // import the first frame as a sequence
    const first = path.join(bakeDir, pngs[0])
    await importSequenceToAE(base, first, pngs.length)
  } catch (e) {
    status('Bake failed — see log')
    log('bake failed: ' + e, 'err')
  } finally {
    baking = false
    $('bake').disabled = false
  }
}

// POST a render command to the Cavalry bridge importer. Returns true if accepted.
async function requestCavalryRender(opts) {
  try {
    const body = JSON.stringify({ cmd: 'render', comp: 'active', outDir: opts.outDir, done: opts.done })
    const r = await fetch(CAVALRY_URL + '/post', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body })
    return r.ok
  } catch (e) { log('Cavalry not reachable: ' + e, 'err'); return false }
}

// Poll for the done-marker file Cavalry writes when the render completes.
// Returns its contents ("OK" / "ERR: ...") or null on timeout.
async function waitForDoneMarker(markerPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { if (fs.existsSync(markerPath)) return fs.readFileSync(markerPath, 'utf8').trim() } catch (e) {}
    await new Promise((r) => setTimeout(r, 500))
  }
  return null
}

// --- AE side via ExtendScript ---
function evalScript(fnCall) {
  return new Promise((resolve) => cs.evalScript(fnCall, resolve))
}

// Where the bridge stores baked frames and sent files. Prefers a "CavalryBridge"
// folder next to the saved .aep (persistent, travels with the project); falls back
// to <home>/CavalryBridge if the project is unsaved. NOT system temp (gets cleaned).
let _storageRoot = null
async function storageRoot() {
  if (_storageRoot) return _storageRoot
  let projDir = ''
  try { projDir = (await evalScript('cavalryBridge_projectDir()')) || '' } catch (e) {}
  const home = process.env.USERPROFILE || process.env.HOME || os.tmpdir()
  const root = (projDir && projDir.trim()) ? projDir.trim() : home
  _storageRoot = path.join(root, 'CavalryBridge')
  fs.mkdirSync(_storageRoot, { recursive: true })
  return _storageRoot
}
// Import a baked PNG sequence (by its actual first-frame path) into AE.
async function importSequenceToAE(base, firstFramePath, count) {
  const first = firstFramePath.replace(/\\/g, '/')
  // friendly comp name: scene file, plus comp display name when multi-comp
  const sceneName = path.basename(scenePath).replace(/\.cv$/i, '')
  const compSel = $('comp')
  const compName = (compSel && compSel.selectedOptions[0] && $('compRow').style.display !== 'none')
    ? `${sceneName} – ${compSel.selectedOptions[0].textContent}`
    : sceneName
  const argObj = { first, base, count, name: compName }
  const arg = encodeURIComponent(JSON.stringify(argObj))
  status('Importing into After Effects…')
  const r = await evalScript(`cavalryBridge_import(decodeURIComponent("${arg}"))`)
  log('AE: ' + r)
  status(r && r.indexOf('OK') === 0 ? 'Layer updated in AE' : 'AE import: ' + r)
}

// --- auto-bake: watch the .cv for changes (debounced) ---
// Poll the file's mtime instead of fs.watch. Cavalry's atomic save (rename)
// makes fs.watch unreliable — events fire as 'rename', the file vanishes mid-
// save, and dedup races swallow the real change. A 1s mtime poll is bulletproof
// and free for one file. ponytail: poll beats fighting fs.watch's rename quirks.
let pollTimer = null
let lastMtime = 0
function setWatch(on) {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
  if (!on || !scenePath) return
  try { lastMtime = fs.statSync(scenePath).mtimeMs } catch (e) { lastMtime = 0 }
  pollTimer = setInterval(async () => {
    if (baking) return
    let m = 0
    try { m = fs.statSync(scenePath).mtimeMs } catch (e) { return } // mid-rename
    if (m === lastMtime || m === 0) return
    lastMtime = m
    log('change detected → re-baking')
    await reloadAndBake()
  }, 1000)
  log('watching ' + path.basename(scenePath) + ' (poll 1s)')
}

// reload the .cv from disk and bake, without re-arming the watcher mid-cycle.
async function reloadAndBake() {
  await loadSceneInner(scenePath)
  await bake()
}

// --- UI wiring ---
$('pick').addEventListener('click', () => {
  // CEP native file dialog
  const sel = window.cep.fs.showOpenDialog(false, false, 'Open Cavalry scene', '', ['cv'])
  if (sel && sel.data && sel.data.length) {
    loadScene(sel.data[0]).catch((e) => log('load failed: ' + e, 'err'))
  }
})
$('bake').addEventListener('click', () => bake().catch((e) => log('bake failed: ' + e, 'err')))
$('auto').addEventListener('change', (e) => setWatch(e.target.checked))
// --- AE → Cavalry sending ---
const CAVALRY_URL = 'http://localhost:8090'

async function postToCavalry(filePath, name, isSequence) {
  const body = JSON.stringify({ path: filePath.replace(/\\/g, '/'), name, sequence: !!isSequence })
  const r = await fetch(CAVALRY_URL + '/post', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body })
  if (!r.ok) throw new Error('Cavalry server HTTP ' + r.status)
}

// Send the active AE comp's STRUCTURE (layers/transforms/keyframes) to Cavalry.
$('sendStructure').addEventListener('click', async () => {
  try {
    status('Reading AE comp structure…')
    const res = await evalScript('cavalryBridge_exportComp()')
    if (!res || res.indexOf('OK:') !== 0) { status('Structure: ' + res); log('exportComp: ' + res, 'err'); return }
    const comp = JSON.parse(decodeURIComponent(res.slice(3)))
    log(`structure: ${comp.layers.length} layers, ${comp.dropped.length} dropped`)

    // build via Cavalry, with a UNIQUE done-marker per send so we never read a
    // stale leftover (the old fixed-name marker could fail to delete → false report).
    const marker = path.join(await storageRoot(), 'to-cavalry', '_buildcomp_' + uniqueToken() + '.txt')
    fs.mkdirSync(path.dirname(marker), { recursive: true })

    status('Building in Cavalry…')
    const body = JSON.stringify({ cmd: 'buildComp', comp, done: marker.replace(/\\/g, '/') })
    const r = await fetch(CAVALRY_URL + '/post', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body })
    if (!r.ok) throw new Error('Cavalry server HTTP ' + r.status)

    const result = await waitForDoneMarker(marker, 60 * 1000)
    if (result == null) { status('Cavalry build timed out — is the importer running?'); return }
    log('Cavalry: ' + result)
    status(result.indexOf('OK') === 0 ? `Built in Cavalry (${comp.dropped.length} layers dropped)` : 'Build: ' + result)
  } catch (e) {
    status('Send structure failed — is the Cavalry importer running?')
    log('sendStructure failed: ' + e, 'err')
  }
})

// Cavalry -> AE : rebuild the active Cavalry comp as EDITABLE AE layers.
// Cavalry's importer walks its own scene (its script API is the only reliable way to
// read resolved values) and writes a JSON structure; ae.jsx then builds it in AE.
$('importLayers').addEventListener('click', async () => {
  try {
    status('Reading Cavalry scene…')
    const dir = path.join(await storageRoot(), 'from-cavalry')
    fs.mkdirSync(dir, { recursive: true })
    // unique filenames: a fixed name can be read back stale before Cavalry flushes it
    const token = uniqueToken()
    const scenePath = path.join(dir, 'scene_' + token + '.json').replace(/\\/g, '/')
    const marker = path.join(dir, '_scene_' + token + '.txt')

    const body = JSON.stringify({ cmd: 'exportScene', out: scenePath, done: marker.replace(/\\/g, '/') })
    const r = await fetch(CAVALRY_URL + '/post', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body })
    if (!r.ok) throw new Error('Cavalry server HTTP ' + r.status)

    const res = await waitForDoneMarker(marker, 90 * 1000)
    if (res == null) { status('Cavalry export timed out — is the importer running?'); return }
    log('Cavalry export: ' + res)
    if (res.indexOf('OK') !== 0) { status('Export: ' + res); return }

    status('Building layers in After Effects…')
    const built = await evalScript('cavalryBridge_importFromCavalry(' + JSON.stringify(scenePath) + ')')
    log('AE build: ' + built)
    status(built && built.indexOf('OK') === 0 ? built.replace(/^OK: /, 'Imported: ') : 'Import: ' + built)
  } catch (e) {
    status('Import failed — is the Cavalry importer running?')
    log('importLayers failed: ' + e, 'err')
  }
})

$('sendAsset').addEventListener('click', async () => {
  try {
    const res = await evalScript('cavalryBridge_selectedSourcePath()')
    if (!res || res.indexOf('OK:') !== 0) { status('Send: ' + res); return }
    const paths = res.slice(3).split('\n').filter(Boolean)
    status(`Sending ${paths.length} to Cavalry…`)
    for (const p of paths) {
      // sequence flag: treat numbered files as still images here (single asset
      // send); video/image both import fine as non-sequence single files.
      await postToCavalry(p, path.basename(p), false)
      log('sent asset → Cavalry: ' + p)
    }
    status(`Sent ${paths.length} → Cavalry`)
  } catch (e) {
    status('Send failed — is the Cavalry importer running?')
    log('sendAsset failed: ' + e, 'err')
  }
})

$('sendComp').addEventListener('click', async () => {
  try {
    const outDir = path.join(await storageRoot(), 'to-cavalry')
    fs.mkdirSync(outDir, { recursive: true })
    // unique token per export so generic comp names don't overwrite old exports
    const token = uniqueToken()
    status('Rendering AE comp…')
    const arg = encodeURIComponent(JSON.stringify({ outDir, token }))
    const res = await evalScript(`cavalryBridge_renderComp(decodeURIComponent("${arg}"))`)
    if (!res || res.indexOf('OK:') !== 0) { status('Render: ' + res); log('renderComp: ' + res, 'err'); return }
    const parts = res.slice(3).split('|')
    const firstFrame = parts[0]
    const isSeq = parts.indexOf('seq=1') !== -1
    // give Cavalry a unique layer name too, so re-sends don't replace prior ones
    const compName = 'AE Comp ' + token
    status('Sending to Cavalry…')
    await postToCavalry(firstFrame, compName, isSeq)
    status('Sent comp → Cavalry')
    log('sent comp → Cavalry: ' + firstFrame)
  } catch (e) {
    status('Send failed — is the Cavalry importer running?')
    log('sendComp failed: ' + e, 'err')
  }
})

// short unique-ish token. Date.now is fine in the panel (CEP/Node context).
function uniqueToken() {
  return Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36)
}

$('comp').addEventListener('change', async (e) => {
  selectedComp = e.target.value
  try {
    player.setActiveComp(selectedComp)
    const res = player.getSceneResolution()
    const cv = $('preview'); cv.width = res.width; cv.height = res.height
    try { if (surface && surface.delete) surface.delete() } catch (err) {}
    surface = Module.makeWebGLSurfaceFromElement(cv, res.width, res.height)
    player.setFrame(player.getStartFrame()); player.render(surface)
    log('composition → ' + e.target.selectedOptions[0].textContent)
    await bake() // bake the newly chosen comp into AE
  } catch (err) { log('comp switch failed: ' + err, 'err') }
})

// expose for autonomous testing harness (headless eval via remote debug)
window.__bridge = {
  loadScene, bake,
  getState: () => ({ scenePath, bakeDir, selectedComp, frames: player ? [player.getStartFrame(), player.getEndFrame()] : null, baking }),
}
log('Cavalry Bridge ready')
