// Cavalry Bridge — Importer (run in Cavalry's Script Editor: Window > Script Editor)
//
// Starts a local HTTP server that the After Effects panel posts to. Each POST
// carries JSON {path, name} — the path to an image/sequence/video on disk and a
// logical layer name. First time for a name: import it as a Footage Shape. Re-sends
// with the same name: replace the asset in place (no layer pile-up).
//
// Keep this panel OPEN while you want the bridge live (closing it stops the server).
// The api.* methods only work from the Script Editor, so this must run here.

// Cavalry scripts have console.log, not a global log(). Alias it.
function log(s) { console.log(s) }

var PORT = 8090
// Re-running this script in the same Cavalry session reuses the existing server: the
// server, its callback, and the UI window are created ONCE (guarded below) so we never
// spawn a second listener.
if (typeof __bridgeBooted === "undefined") { __bridgeBooted = false }
if (typeof __bridgeServer === "undefined" || !__bridgeServer) { __bridgeServer = new api.WebServer() }
var server = __bridgeServer
if (typeof __bridgeAssets === "undefined") { __bridgeAssets = {} }
var nameToAsset = __bridgeAssets // logical name -> assetId (so re-sends replace in place)

function handlePost(obj) {
    var msg
    try { msg = JSON.parse(obj.result) } catch (e) { log("bad POST (not JSON): " + obj.result); return }

    // Commands: render (full renderer), buildComp (rebuild AE structure),
    // exportScene (Cavalry -> AE editable layers); else import.
    if (msg.cmd === "render") { handleRender(msg); return }
    if (msg.cmd === "buildComp") { handleBuildComp(msg); return }
    if (msg.cmd === "exportScene") { handleExportScene(msg); return }

    if (!msg.path) { log("POST missing 'path'"); return }
    var name = msg.name || "AE Import"
    var isSeq = !!msg.sequence
    try {
        if (nameToAsset[name]) {
            api.replaceAsset(nameToAsset[name], msg.path)
            api.reloadAsset(nameToAsset[name])
            log("replaced '" + name + "' <- " + msg.path)
        } else {
            var assetId = api.loadAsset(msg.path, isSeq)
            api.addAssetToComp(assetId)
            nameToAsset[name] = assetId
            log("imported '" + name + "' <- " + msg.path)
        }
    } catch (e) {
        log("import error for '" + name + "': " + e)
    }
}

// Render a composition to a PNG sequence using Cavalry's FULL renderer, then
// write a "done" marker so the AE panel knows to import. msg = {cmd:"render",
// comp:"<id>"|"active", outDir:"<folder>", done:"<markerPath>"}.
function handleRender(msg) {
    // checkpoint into a debug file so we can see exactly how far it gets
    var dbg = msg.done ? msg.done.replace(/_done\.txt$/, "_render.log") : null;
    function ck(s) { log(s); if (dbg) { try { api.writeToFile(dbg, s + "\n", false); } catch (e) {} } }
    try {
        ck("handleRender start; comp=" + msg.comp + " outDir=" + msg.outDir);
        var compId = (!msg.comp || msg.comp === "active") ? api.getActiveComp() : msg.comp;
        ck("resolved compId=" + compId);
        if (!compId) { writeDone(msg.done, "ERR: no active comp"); return; }

        var item = api.addRenderQueueItem(compId);
        ck("added render queue item=" + item);

        api.setGenerator(item, "generator", "renderPNG");
        ck("setGenerator renderPNG; current=" + api.getCurrentGeneratorType(item, "generator"));

        // set output config one key at a time so a bad key doesn't kill all of them
        function trySet(k, v) { try { var o = {}; o[k] = v; api.set(item, o); ck("set " + k + "=" + v); } catch (e) { ck("set " + k + " FAILED: " + e); } }
        trySet("filePath", msg.outDir);
        trySet("fileName", "frame");
        trySet("padding", 5);
        trySet("resolutionScale", 100);
        ck("filePath now = " + api.get(item, "filePath"));

        ck("calling api.render…");
        api.render(item);
        ck("api.render returned");

        try { api.deleteLayer(item); } catch (eDel) {}
        writeDone(msg.done, "OK");
        ck("render complete -> " + msg.outDir);
    } catch (e) {
        ck("RENDER ERROR: " + e);
        writeDone(msg.done, "ERR: " + e);
    }
}

// ---- AE → Cavalry STRUCTURAL rebuild ----
// msg = {cmd:"buildComp", comp:<AE comp JSON>, done:<markerPath>}
// Recreates the transferable layers (footage/text/solid/shape) with transforms
// and keyframes. Coordinate/scale/color conversions per probe findings.
function handleBuildComp(msg) {
    try {
        var comp = msg.comp;
        if (!comp || !comp.layers) { writeDone(msg.done, "ERR: no comp data"); return; }
        var W = comp.width, H = comp.height, fps = comp.fps || 30;
        log("buildComp: " + comp.name + " (" + comp.layers.length + " layers)");

        var built = 0, failed = [];
        BUILD_KF = 0; BUILD_EASE = 0; EASE_ERRS = [];
        // AE layers are top..bottom; create in reverse so stacking matches.
        for (var i = comp.layers.length - 1; i >= 0; i--) {
            var L = comp.layers[i];
            try {
                var id = createLayer(L, W, H);
                if (!id) { failed.push(L.name + " (unhandled " + L.kind + ")"); continue; }
                applyTransform(id, L.transform, W, H, fps, L);
                applyTiming(id, L, fps);
                built++;
            } catch (e) { failed.push(L.name + ": " + e); }
        }

        var summary = "OK: built " + built + "/" + comp.layers.length + ", " + BUILD_KF + " keyframes, " + BUILD_EASE + " eased";
        if (EASE_ERRS.length) summary += " | easeErr: " + EASE_ERRS.join(" ;; ");
        if (failed.length) summary += " | failed: " + failed.join("; ");
        if (comp.dropped && comp.dropped.length) {
            var d = [];
            for (var k = 0; k < comp.dropped.length; k++) d.push(comp.dropped[k].name + "(" + comp.dropped[k].reason + ")");
            summary += " | dropped in AE: " + d.join(", ");
        }
        log(summary);
        writeDone(msg.done, summary);
    } catch (e) {
        log("buildComp error: " + e);
        writeDone(msg.done, "ERR: " + e);
    }
}

function createLayer(L, W, H) {
    if (L.kind === "text") {
        var t = api.create("textShape", L.name || "Text");
        var set = { fontSize: L.fontSize || 72 };
        if (L.text != null) set.text = L.text;
        var fam = L.fontFamily || psNameToFamily(L.font);
        var sty = L.fontStyle || "Regular";
        if (fam) set.font = { font: fam, style: sty };
        // set font (may be invalid) separately from color so a bad font can't void
        // the color set — same lesson as the ellipse. text/fontSize/font first:
        api.set(t, set);
        if (L.fillColor) api.set(t, { "material.materialColor": colorAE(L.fillColor) });
        // applyTransform positions it so the text's rendered CENTER (Cavalry bbox)
        // lands where AE renders it.
        return t;
    }
    if (L.kind === "solid") {
        var r = api.primitive("rectangle", L.name || "Solid");
        api.set(r, {
            "generator.dimensions": { x: L.size ? L.size[0] : 100, y: L.size ? L.size[1] : 100 },
            "material.materialColor": colorAE(L.color)
        });
        return r;
    }
    if (L.kind === "shape") {
        var isEll = L.shapeType === "ellipse";
        var prim = api.primitive(isEll ? "ellipse" : "rectangle", L.name || "Shape");
        var w = L.size ? L.size[0] : 100, h = L.size ? L.size[1] : 100;
        // Ellipse sizes by RADIUS (generator.radius = half the AE size); rectangle by
        // full dimensions (generator.dimensions). Set size + color SEPARATELY: an
        // invalid attr in a combined api.set() silently voids the whole call.
        if (isEll) api.set(prim, { "generator.radius": { x: w / 2, y: h / 2 } });
        else api.set(prim, { "generator.dimensions": { x: w, y: h } });
        if (L.fillColor) api.set(prim, { "material.materialColor": colorAE(L.fillColor) });
        return prim;
    }
    if (L.kind === "footage") {
        var assetId = api.loadAsset(L.file, !L.isStill);
        var ids = api.addAssetToComp(assetId);
        // addAssetToComp returns a STRING layer id (e.g. "footageShape#2"), not an array.
        // The old `ids[0]` indexed into the string and returned the letter "f", so the
        // footage layer's transform was silently applied to nothing.
        if (ids instanceof Array) return ids.length ? ids[0] : null;
        return ids;
    }
    return null;
}

// AE top-left, Y-DOWN coords -> Cavalry CENTER origin. Cavalry's Y axis points
// UP, so we negate Y (H/2 - aeY). Applied to BOTH static + keyframe paths so they
// stay consistent. AE 0-100 scale -> 0-1.
function aePosToCav(v, W, H) {
    var x = (v[0] != null ? v[0] : 0) - W / 2;
    var y = H / 2 - (v[1] != null ? v[1] : 0);
    return [x, y];
}
function aeScaleToCav(v) { return [(v[0] || 100) / 100, (v[1] || 100) / 100]; }
function colorAE(c) { // [r,g,b] 0-1 -> {r,g,b,a} 0-255
    return { r: Math.round((c[0] || 0) * 255), g: Math.round((c[1] || 0) * 255), b: Math.round((c[2] || 0) * 255), a: 255 };
}
function psNameToFamily(ps) { return ("" + ps).split("-")[0]; } // rough; Cavalry resolves family
// AE ParagraphJustification -> Cavalry horizontalAlignment (0=L,1=C,2=R).
// AE: 7413=LEFT, 7414=RIGHT, 7415=CENTER. Default center (matches common usage).
function aeJustifyToCav(j) {
    var s = "" + j;
    if (s.indexOf("7413") >= 0) return 0; // left
    if (s.indexOf("7414") >= 0) return 2; // right
    return 1; // center (7415 or unknown)
}

// Trim the layer's timeline in/out to match AE's in/out points (seconds -> frames).
// Only applies when the layer doesn't span the whole comp (avoids needless trims).
function applyTiming(id, L, fps) {
    try {
        if (L.inPoint != null && L.inPoint > 0) api.setInFrame(id, Math.round(L.inPoint * fps));
        if (L.outPoint != null) api.setOutFrame(id, Math.round(L.outPoint * fps));
    } catch (e) { log("timing " + L.name + ": " + e); }
}

// Apply transform: static values + keyframes. AE rotation Z, opacity 0-100.
function applyTransform(id, tr, W, H, fps, L) {
    if (!tr) return;
    // Text positioning: we want the text's visual CENTER to land where AE renders it.
    //  1) AE side: text center in comp = position + (bounds-center − anchor). The
    //     (bounds-center − anchor) part is a constant local vector → offset ox/oy
    //     (Y-flipped for Cavalry).
    //  2) Cavalry side: a text layer's rendered bbox has a local centre offset from
    //     its origin (the point 'position' places). Subtract that centre so the
    //     glyphs — not the origin — sit on the target.
    // Non-text layers need no offset (their anchor ≈ content center already maps).
    var ox = 0, oy = 0;
    if (L && L.kind === "text") {
        var a = (tr.anchor && tr.anchor.value) ? tr.anchor.value : [0, 0, 0];
        var cx = a[0] || 0, cy = a[1] || 0;
        if (L.bounds) { cx = L.bounds.left + L.bounds.width / 2; cy = L.bounds.top + L.bounds.height / 2; }
        ox = cx - (a[0] || 0);
        oy = -(cy - (a[1] || 0));
        try {
            api.set(id, { "position.x": 0, "position.y": 0 });
            var bb = api.getBoundingBox(id, false);
            if (bb && bb.centre) { ox -= bb.centre.x; oy -= bb.centre.y; }
        } catch (e) {}
    }
    // Separated dimensions: each axis carries its own real ease (combined position is
    // a linear placeholder when separated). Use per-axis when present, else combined.
    if (tr.positionX && tr.positionY && ((tr.positionX.keys && tr.positionX.keys.length) || (tr.positionY.keys && tr.positionY.keys.length))) {
        setProp(id, "position.x", tr.positionX, function (v) { return scalarOf(v) - W / 2 + ox; }, fps);
        setProp(id, "position.y", tr.positionY, function (v) { return H / 2 - scalarOf(v) + oy; }, fps);
    } else {
        setPosition(id, tr.position, W, H, fps, ox, oy);
    }
    setProp(id, "scale", tr.scale, function (v) { return aeScaleToCav(v); }, fps);
    setProp(id, "rotation", tr.rotation, function (v) { return (typeof v === "number") ? [0, 0, v] : v; }, fps);
    setProp(id, "opacity", tr.opacity, function (v) { return (typeof v === "number") ? v : v; }, fps);
}

// Position: AE's combined-position ease is ONE ease along the 2D motion path.
// The same time-remap governs both axes, so we compute one ease curve per segment
// (influence + speed normalized by the 2D path distance) and apply it to x AND y.
function setPosition(id, p, W, H, fps, ox, oy) {
    ox = ox || 0; oy = oy || 0;
    if (!p) return;
    if (!(p.keys && p.keys.length)) {
        if (p.value != null) { var ps = posSet(p.value, W, H); ps["position.x"] += ox; ps["position.y"] += oy; api.set(id, ps); }
        return;
    }
    var keys = p.keys;
    // 1) set x/y keyframe values
    for (var k = 0; k < keys.length; k++) {
        var cv = aePosToCav(keys[k].value, W, H);
        try { kf(id, "position.x", keys[k].frame, cv[0] + ox); kf(id, "position.y", keys[k].frame, cv[1] + oy); } catch (e) { log("pos kf fail: " + e); }
    }
    // 2) per segment, one ease curve -> both axes
    for (var s = 0; s < keys.length - 1; s++) {
        var a = keys[s], b = keys[s + 1];
        var outT = (a.outInterp != null) ? a.outInterp : 0;
        if (outT === 2) { setKfType(id, "position.x", a.frame, 2); setKfType(id, "position.y", a.frame, 2); continue; }
        // 2D path distance for normalizing AE's path-speed
        var dist = dist2(a.value, b.value);
        var dt = ((b.frame - a.frame) || 1) / fps;
        var oe = pick(a.outEase, 0), ie = pick(b.inEase, 0);
        var x1 = clampUnit(((oe && oe.influence != null) ? oe.influence : 33.33) / 100);
        var x2 = clampUnit(1 - ((ie && ie.influence != null) ? ie.influence : 33.33) / 100);
        var y1 = 0, y2 = 1;
        if (dist > 1e-6) {
            // normalized slope = (speed px/s * dt s) / dist px ; y-handle = x-handle * slope
            y1 = x1 * ((oe ? oe.speed : 0) * dt / dist);
            y2 = 1 - (1 - x2) * ((ie ? ie.speed : 0) * dt / dist);
        }
        var expr = bezierExpr(x1, y1, x2, y2);
        setKfType(id, "position.x", a.frame, 0); setKfType(id, "position.y", a.frame, 0);
        try { api.magicEasing(id, "position.x", a.frame, "Custom", expr); api.magicEasing(id, "position.y", a.frame, "Custom", expr); BUILD_EASE++; }
        catch (e) { EASE_ERR("pos magicEasing@" + a.frame + ": " + e); }
    }
}
function posSet(v, W, H) { var c = aePosToCav(v, W, H); return { "position.x": c[0], "position.y": c[1] }; }
function dist2(a, b) { var dx = (b[0] - a[0]), dy = (b[1] - a[1]); return Math.sqrt(dx * dx + dy * dy); }
function setKfType(id, path, frame, t) { try { var m = {}; m[path] = { frame: frame, type: t }; api.modifyKeyframe(id, m); } catch (e) {} }

var BUILD_KF = 0; // counts keyframes set (for the build report)
// Set a property that's either {value} or {keys:[...]} with frame/value/ease.
// conv(value) returns a [x,y(,z)] array or a scalar. Done PER COMPONENT:
//  1) set all keyframe values, 2) per segment apply the AE ease as a magicEasing
//  Custom expression (exact cubic-bezier — same approach as the Easy plugin).
function setProp(id, attr, p, conv, fps) {
    if (!p) return;
    if (p.keys && p.keys.length) {
        var comps = (attr === "rotation") ? [{ path: "rotation.z", idx: 2, scalar: true }]
            : [{ path: attr + ".x", idx: 0 }, { path: attr + ".y", idx: 1 }];
        // scalar attrs (opacity) — single component
        var firstVal = conv(p.keys[0].value);
        if (!(firstVal instanceof Array)) comps = [{ path: attr, idx: 0, scalar: true }];

        for (var c = 0; c < comps.length; c++) {
            var comp = comps[c];
            // 1) set keyframe values for this component
            var compVals = [];
            for (var k = 0; k < p.keys.length; k++) {
                var v = conv(p.keys[k].value);
                var cv = (v instanceof Array) ? (comp.scalar ? scalarOf(v) : v[comp.idx]) : v;
                compVals.push(cv);
                try { kf(id, comp.path, p.keys[k].frame, cv); } catch (e) { log("kf fail " + comp.path + ": " + e); }
            }
            // 2) per segment, apply ease as a magicEasing expression on the earlier key
            for (var s = 0; s < p.keys.length - 1; s++) {
                applySegmentEase(id, comp.path, p.keys[s], p.keys[s + 1], compVals[s], compVals[s + 1], comp.idx, fps);
            }
        }
    } else if (p.value != null) {
        var sObj = {}; sObj[attr] = conv(p.value);
        api.set(id, sObj);
    }
}

// Apply the AE ease for the segment keyA->keyB onto keyA, as a magicEasing Custom
// expression. Converts AE temporal ease (influence%, speed) to a normalized cubic
// bezier, then emits the sampled expression.
function applySegmentEase(id, attrPath, keyA, keyB, valA, valB, compIdx, fps) {
    // Hold/step keyframes have no curve.
    var outT = (keyA.outInterp != null) ? keyA.outInterp : 0;
    if (outT === 2) {
        try { var md = {}; md[attrPath] = { frame: keyA.frame, type: 2 }; api.modifyKeyframe(id, md); } catch (e) {}
        return;
    }
    // For BOTH bezier AND linear-typed keyframes we compute the curve from AE's
    // temporal EASE data: AE keyframes can be "Linear" interpolation type yet carry
    // real ease velocity (influence/speed) that bends the curve. The ease data is
    // the source of truth — only a genuinely-flat ease (default influence, matching
    // speeds) yields a straight line, which the bezier math reproduces anyway.
    // Build cubic-bezier (x1,y1,x2,y2) from AE ease. We use INFLUENCE only — AE's
    // 'speed' for spatial position is path-speed (px/s along the 2D path), not per-
    // axis, so combining it with a per-axis value delta distorts the curve. Influence
    // alone gives the correct ease shape: it's the horizontal handle length, and the
    // value-graph handles sit flat (y1=0 out of A, y2=1 into B) — the standard ease
    // form that matches AE's Easy Ease. A near-zero influence on a side = ~linear there.
    var oe = pick(keyA.outEase, compIdx); // out handle of A
    var ie = pick(keyB.inEase, compIdx);  // in handle of B
    var infOut = (oe && oe.influence != null) ? oe.influence : 33.33;
    var infIn = (ie && ie.influence != null) ? ie.influence : 33.33;
    var x1 = clampUnit(infOut / 100);
    var y1 = 0;                       // flat start (ease-out of A)
    var x2 = clampUnit(1 - infIn / 100);
    var y2 = 1;                       // flat end (ease-in to B)
    try { var md2 = {}; md2[attrPath] = { frame: keyA.frame, type: 0 }; api.modifyKeyframe(id, md2); } catch (e) {}
    var expr = bezierExpr(x1, y1, x2, y2);
    try {
        api.magicEasing(id, attrPath, keyA.frame, "Custom", expr);
        BUILD_EASE++;
    } catch (e) { EASE_ERR("magicEasing " + attrPath + "@" + keyA.frame + ": " + e); }
}

function pick(easeArr, idx) {
    if (!easeArr || !easeArr.length) return null;
    return easeArr[idx] || easeArr[0];
}
function clampUnit(n) { return Math.max(0, Math.min(1, n)); }

// Cubic-bezier (P0=0,0 P3=1,1) -> compact piecewise-linear magicEasing expression.
// Same sampling trick as the Easy plugin (don't inline Newton — it explodes/freezes).
function bezierExpr(x1, y1, x2, y2) {
    var N = 20, xs = [], ys = [];
    for (var i = 0; i <= N; i++) {
        var t = i / N, mt = 1 - t;
        xs.push(3 * mt * mt * t * x1 + 3 * mt * t * t * x2 + t * t * t);
        ys.push(3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t * t * t);
    }
    var expr = "" + r4(ys[N]);
    for (var s = N - 1; s >= 0; s--) {
        var ax = r4(xs[s]), bx = r4(xs[s + 1]), ay = r4(ys[s]), by = r4(ys[s + 1]);
        var dx = (bx - ax) || 1e-6;
        expr = "(x<" + bx + "?(" + ay + "+(x-" + ax + ")*" + r4((by - ay) / dx) + "):" + expr + ")";
    }
    return expr;
}
function r4(n) { return Math.round(n * 10000) / 10000; }

var BUILD_EASE = 0, EASE_ERRS = [];
function EASE_ERR(s) { if (EASE_ERRS.length < 5) EASE_ERRS.push(s); }
function kf(id, attrPath, frame, value) {
    var o = {}; o[attrPath] = value;
    api.keyframe(id, frame, o);
    BUILD_KF++;
}
function scalarOf(v) { return (v instanceof Array) ? (v[2] != null ? v[2] : v[0]) : v; }

function writeDone(markerPath, status) {
    if (!markerPath) return;
    try { api.writeToFile(markerPath, status, true); } catch (e) { log("done-marker write failed: " + e); }
}


function Callbacks() {
    this.onPost = function () {
        while (server.postCount()) { handlePost(server.getNextPost()) }
    }
}

// --- One-time boot: server callback + UI window. Skipped on hot re-eval. ---
if (!__bridgeBooted) {
    __bridgeBooted = true

    server.addCallbackObject(new Callbacks())
    server.setHighFrequency() // ~1s poll

    // --- UI: start/stop + status (window must stay open to keep server alive) ---
    var statusLabel = new ui.Label("Stopped")
    var toggle = new ui.Button("Start Bridge Server")
    toggle.onClick = function () {
        if (!server.isRunning()) {
            server.listen("localhost", PORT)
            toggle.setText("Stop Bridge Server")
            statusLabel.setText("Listening on localhost:" + PORT)
            log("Cavalry Bridge importer listening on :" + PORT)
        } else {
            server.stop()
            toggle.setText("Start Bridge Server")
            statusLabel.setText("Stopped")
            log("Cavalry Bridge importer stopped")
        }
    }

    ui.add(new ui.Label("Cavalry Bridge — receives assets from After Effects"))
    ui.add(toggle)
    ui.add(statusLabel)
    ui.add(new ui.Label("Keep this window OPEN while using the bridge."))
    ui.add(new ui.Label("Run it once per Cavalry session (Window > Scripts)."))
    ui.show()

    // auto-start so the user just runs the script
    toggle.onClick()
} else {
    log("bridge importer: code reloaded (server kept alive)")
}


// ============================================================================
// Cavalry -> AE : walk the active comp and emit a JSON structure the AE panel can
// rebuild as EDITABLE layers. Anything procedural (duplicators, deformers, fields,
// shaders, ...) has no AE equivalent and is reported in `dropped` instead.
//
// This file is concatenated into bridge-importer.js at deploy time.
//
// HARD-WON FACTS (verified against the live app — do not "fix" these):
//  - api.getCompLayers(true)  -> TOP-LEVEL layer ids;  (false) -> all incl. children
//  - api.getLayerType(id)     -> "basicShape" | "textShape" | "group" | ...
//    Rect AND ellipse are BOTH "basicShape" — tell them apart with
//    api.getCurrentGeneratorType(id, "generator") -> "rectangleShape"|"ellipseShape"
//  - api.getAnimatedAttributes(id) -> ["position.x", ...] (exactly the keyframed ones)
//  - api.getKeyframeTimes(id, attr) -> [frame, ...]
//  - Keyframe NODES expose no ease/tangent data, so easing must be recovered by
//    SAMPLING the evaluated curve (setFrame + get) and fitting AE's ease model.
//  - Reading a non-existent attribute can HARD-CRASH Cavalry -> always use hasAttr().
//  - comp attrs: "resolution" {x,y}, "fps", "startFrame", "endFrame"
//  - Text bbox is ZERO on frames where the layer is trimmed out — measure inside range.
// ============================================================================

// Safe attribute read — a guessed/absent attr name can take the whole app down.
function hasAttr(id, attr) {
    try { return api.hasAttribute ? api.hasAttribute(id, attr) : true } catch (e) { return false }
}
function getAttr(id, attr, dflt) {
    if (!hasAttr(id, attr)) return dflt
    try { var v = api.get(id, attr); return (v === undefined) ? dflt : v } catch (e) { return dflt }
}

// Which Cavalry layer types we can rebuild in AE.
function classify(id) {
    var t = api.getLayerType(id)
    if (t === "textShape") return "text"
    if (t === "group") return "group"
    if (t === "footageShape") return "footage"
    // an imageShader is the companion node a footageShape is wired to — not a layer
    // in its own right, so skip it silently rather than reporting it as "dropped".
    if (t === "imageShader") return "ignore"
    if (t === "basicShape") {
        var g = ""
        try { g = api.getCurrentGeneratorType(id, "generator") } catch (e) {}
        if (g === "rectangleShape") return "rect"
        if (g === "ellipseShape") return "ellipse"
        // a basicShape driven by some other generator (polygon, star, custom path...)
        return "shape:" + (g || "unknown")
    }
    return "unsupported:" + t
}

// "imageShader#1.id" -> "imageShader#1"
function nodeOf(conn) {
    if (!conn) return null
    var i = conn.lastIndexOf(".")
    return (i > 0) ? conn.substring(0, i) : conn
}

// A footageShape doesn't hold the file directly: it's wired to an imageShader whose
// `image.assetId` points at the asset. Walk that chain to recover the source path.
function footageFile(fid) {
    var conn = null
    try { conn = api.getInConnection(fid, "material.colorShaders.0.shader") } catch (e) { return null }
    var shader = nodeOf(conn)
    if (!shader) return null
    var img = null
    try { if (api.hasAttribute(shader, "image")) img = api.get(shader, "image") } catch (e) {}
    if (!img || !img.assetId) return null
    try { return api.getAssetFilePath(img.assetId) } catch (e) { return null }
}

var TRANSFORM_ATTRS = ["position.x", "position.y", "rotation.z", "scale.x", "scale.y", "opacity"]

// Collect every frame we need to evaluate, so we only setFrame() once per frame.
function collectSampleFrames(layers, SAMPLES_PER_SEG) {
    var set = {}
    for (var i = 0; i < layers.length; i++) {
        var anim = layers[i].animated
        for (var a in anim) {
            var times = anim[a]
            for (var k = 0; k < times.length; k++) {
                set[times[k]] = true
                // intermediate samples for ease-fitting on each segment
                if (k < times.length - 1) {
                    var f0 = times[k], f1 = times[k + 1]
                    for (var s = 1; s < SAMPLES_PER_SEG; s++) {
                        set[Math.round(f0 + ((f1 - f0) * s) / SAMPLES_PER_SEG)] = true
                    }
                }
            }
        }
    }
    var out = []
    for (var f in set) out.push(parseInt(f, 10))
    out.sort(function (a, b) { return a - b })
    return out
}

function handleExportScene(msg) {
    try {
        var SAMPLES_PER_SEG = 12
        var comp = api.getActiveComp()
        var res = getAttr(comp, "resolution", { x: 1920, y: 1080 })
        var fps = getAttr(comp, "fps", 25)
        var startFrame = getAttr(comp, "startFrame", 0)
        var endFrame = getAttr(comp, "endFrame", 250)

        var ids = api.getCompLayers(false) // all layers, incl. group children
        var layers = [], dropped = []

        // --- pass 1: identity, static values, which attrs are animated -------------
        for (var i = 0; i < ids.length; i++) {
            var id = ids[i]
            var kind = classify(id)
            var name = api.getNiceName(id)
            if (kind === "ignore") continue // internal companion node, not a real layer
            if (kind.indexOf("unsupported:") === 0 || kind.indexOf("shape:") === 0) {
                dropped.push({ name: name, reason: kind.replace(":", " ") })
                continue
            }
            var animated = {}
            var animList = []
            try { animList = api.getAnimatedAttributes(id) || [] } catch (e) {}
            for (var a = 0; a < animList.length; a++) {
                var attr = animList[a]
                try {
                    var times = api.getKeyframeTimes(id, attr)
                    if (times && times.length) animated[attr] = times
                } catch (e) {}
            }
            var parent = ""
            try { parent = api.getParent(id) || "" } catch (e) {}

            var L = {
                id: id,
                name: name,
                kind: kind,
                parent: parent,
                inFrame: getAttr(id, "__none__", 0), // replaced below
                animated: animated,
                stat: {} // static (non-animated) transform values
            }
            try { L.inFrame = api.getInFrame(id) } catch (e) { L.inFrame = startFrame }
            try { L.outFrame = api.getOutFrame(id) } catch (e) { L.outFrame = endFrame }

            for (var t = 0; t < TRANSFORM_ATTRS.length; t++) {
                var ta = TRANSFORM_ATTRS[t]
                L.stat[ta] = getAttr(id, ta, ta.indexOf("scale") === 0 ? 1 : (ta === "opacity" ? 100 : 0))
            }

            // type-specific
            if (kind === "rect") {
                var d = getAttr(id, "generator.dimensions", { x: 100, y: 100 })
                L.size = [d.x, d.y]
                L.fill = getAttr(id, "material.materialColor", null)
            } else if (kind === "ellipse") {
                var r = getAttr(id, "generator.radius", { x: 50, y: 50 })
                L.size = [r.x * 2, r.y * 2] // AE wants diameter
                L.fill = getAttr(id, "material.materialColor", null)
            } else if (kind === "text") {
                var txt = getAttr(id, "text", "")
                L.text = (txt && typeof txt === "object" && txt.text != null) ? txt.text : String(txt || "")
                L.fontSize = getAttr(id, "fontSize", 72)
                var f = getAttr(id, "font", null)
                if (f) { L.fontFamily = f.font; L.fontStyle = f.style }
                L.fill = getAttr(id, "material.materialColor", null)
            } else if (kind === "footage") {
                L.file = footageFile(id)
                if (!L.file) { dropped.push({ name: name, reason: "footage with no resolvable file" }); continue }
            }
            layers.push(L)
        }

        // --- pass 2: sample every needed frame ONCE, reading all animated attrs -----
        var frames = collectSampleFrames(layers, SAMPLES_PER_SEG)
        var samples = {} // layerId -> attr -> {frame: value}
        var savedFrame = 0
        try { savedFrame = api.getFrame() } catch (e) {}
        for (var fi = 0; fi < frames.length; fi++) {
            var fr = frames[fi]
            try { api.setFrame(fr) } catch (e) { continue }
            for (var li = 0; li < layers.length; li++) {
                var LL = layers[li]
                for (var an in LL.animated) {
                    if (!samples[LL.id]) samples[LL.id] = {}
                    if (!samples[LL.id][an]) samples[LL.id][an] = {}
                    samples[LL.id][an][fr] = getAttr(LL.id, an, 0)
                }
            }
        }

        // text bounds must be measured on a frame where the layer is actually visible
        for (var ti = 0; ti < layers.length; ti++) {
            var TL = layers[ti]
            if (TL.kind !== "text") continue
            var probeFrame = Math.max(TL.inFrame, startFrame) + 1
            try {
                api.setFrame(probeFrame)
                var bb = api.getBoundingBox(TL.id, false)
                if (bb) TL.bbox = { centre: bb.centre, width: bb.width, height: bb.height }
            } catch (e) {}
        }
        try { api.setFrame(savedFrame) } catch (e) {}

        // attach samples
        for (var si = 0; si < layers.length; si++) {
            layers[si].samples = samples[layers[si].id] || {}
        }

        var scene = {
            name: api.getNiceName(comp) || "Cavalry Comp",
            width: res.x, height: res.y,
            fps: fps,
            startFrame: startFrame, endFrame: endFrame,
            samplesPerSeg: SAMPLES_PER_SEG,
            layers: layers,
            dropped: dropped
        }

        var json = JSON.stringify(scene)
        if (msg.out) {
            api.writeToFile(msg.out, json)
            writeDone(msg.done, "OK: " + layers.length + " layers, " + dropped.length + " dropped -> " + msg.out)
        } else {
            writeDone(msg.done, json)
        }
    } catch (e) {
        writeDone(msg.done, "ERR: exportScene: " + e)
    }
}
