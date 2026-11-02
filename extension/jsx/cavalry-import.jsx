// ============================================================================
// Cavalry -> After Effects : rebuild a Cavalry comp as EDITABLE AE layers.
//
// Reads the JSON written by the Cavalry importer's `exportScene` command and builds
// shapes / text / footage / groups with transforms, keyframes and easing.
//
// ExtendScript is ES3-ish: no let/const/arrow/forEach. JSON.parse DOES exist (verified).
//
// CONVENTIONS (mirror of the AE->Cavalry direction):
//   position : Cavalry is CENTER-origin and Y-UP; AE is TOP-LEFT and Y-DOWN.
//              aeX = cavX + W/2      aeY = H/2 - cavY
//   scale    : Cavalry 0..1  -> AE 0..100          (x100)
//   color    : Cavalry {r,g,b} 0..255 -> AE [r,g,b] 0..1   (/255)
//   opacity  : 0..100 both
//   time     : Cavalry frames -> AE seconds (frame / fps)
//
// Position uses AE's SEPARATE DIMENSIONS, because Cavalry keyframes X and Y as
// independent channels with independent easing — combined position can't express that.
// ============================================================================

function cavalryBridge_importFromCavalry(scenePath) {
    try {
        var f = new File(scenePath);
        if (!f.exists) return "ERR: scene file not found: " + scenePath;
        f.open("r");
        var raw = f.read();
        f.close();
        var S = JSON.parse(raw);

        app.beginUndoGroup("Import Cavalry layers");

        var fps = S.fps || 25;
        var W = S.width, H = S.height;
        var durFrames = (S.endFrame - S.startFrame) || 250;
        var comp = app.project.items.addComp(
            S.name || "Cavalry Import", W, H, 1, durFrames / fps, fps
        );
        comp.openInViewer();

        // Build in reverse so AE's stacking matches Cavalry's list order.
        var made = {};   // cavalry layer id -> AE layer
        var report = [];

        for (var i = S.layers.length - 1; i >= 0; i--) {
            var L = S.layers[i];
            try {
                var ly = makeLayer(comp, L, W, H, fps);
                if (!ly) { report.push(L.name + " (unhandled " + L.kind + ")"); continue; }
                made[L.id] = ly;
            } catch (e) { report.push(L.name + ": " + e.toString()); }
        }

        // parenting (after all layers exist)
        for (var p = 0; p < S.layers.length; p++) {
            var LP = S.layers[p];
            if (LP.parent && made[LP.id] && made[LP.parent]) {
                try { made[LP.id].parent = made[LP.parent]; } catch (e) {}
            }
        }

        // transforms + keyframes (after parenting so values are interpreted correctly)
        for (var t = 0; t < S.layers.length; t++) {
            var LT = S.layers[t];
            if (!made[LT.id]) continue;
            var parentLayer = (LT.parent && made[LT.parent]) ? made[LT.parent] : null;
            try { applyCavTransform(made[LT.id], LT, S, W, H, fps, parentLayer); }
            catch (e) { report.push(LT.name + " transform: " + e.toString()); }
        }

        app.endUndoGroup();

        var msg = "OK: built " + countKeys(made) + "/" + S.layers.length + " layers";
        if (S.dropped && S.dropped.length) {
            var d = [];
            for (var k = 0; k < S.dropped.length; k++) d.push(S.dropped[k].name + " (" + S.dropped[k].reason + ")");
            msg += " | dropped in Cavalry: " + d.join(", ");
        }
        if (report.length) msg += " | failed: " + report.join("; ");
        return msg;
    } catch (e) {
        try { app.endUndoGroup(); } catch (e2) {}
        return "ERR: " + e.toString();
    }
}

function countKeys(o) { var n = 0; for (var k in o) n++; return n; }

// --- layer creation ---------------------------------------------------------

function makeLayer(comp, L, W, H, fps) {
    var ly = null;

    if (L.kind === "group") {
        ly = comp.layers.addNull();
        ly.name = L.name;
        ly.enabled = false;               // nulls shouldn't render
    } else if (L.kind === "rect" || L.kind === "ellipse") {
        ly = comp.layers.addShape();
        ly.name = L.name;
        addShapeGeo(ly, L);
    } else if (L.kind === "text") {
        ly = comp.layers.addText(L.text || "");
        ly.name = L.name;
        styleText(ly, L);
    } else if (L.kind === "footage") {
        var io = importFootage(L.file);
        if (!io) return null;
        ly = comp.layers.add(io);
        ly.name = L.name;
    } else {
        return null;
    }

    // timeline in/out (Cavalry frames -> AE seconds)
    try {
        if (L.inFrame != null) ly.inPoint = L.inFrame / fps;
        if (L.outFrame != null) ly.outPoint = L.outFrame / fps;
    } catch (e) {}
    return ly;
}

// A single rect/ellipse with a fill, inside the shape layer's Contents.
function addShapeGeo(ly, L) {
    var contents = ly.property("ADBE Root Vectors Group");
    var grp = contents.addProperty("ADBE Vector Group");
    grp.name = L.name;
    var items = grp.property("ADBE Vectors Group");

    var geo;
    if (L.kind === "ellipse") {
        geo = items.addProperty("ADBE Vector Shape - Ellipse");
        geo.property("ADBE Vector Ellipse Size").setValue([L.size[0], L.size[1]]);
    } else {
        geo = items.addProperty("ADBE Vector Shape - Rect");
        geo.property("ADBE Vector Rect Size").setValue([L.size[0], L.size[1]]);
    }
    var fill = items.addProperty("ADBE Vector Graphic - Fill");
    if (L.fill) fill.property("ADBE Vector Fill Color").setValue(colorCavToAE(L.fill));
}

function styleText(ly, L) {
    var srcProp = ly.property("ADBE Text Properties").property("ADBE Text Document");
    var td = srcProp.value;
    if (L.fontSize) td.fontSize = L.fontSize;
    if (L.fill) td.fillColor = colorCavToAE(L.fill);
    if (L.fontFamily) {
        // AE wants a PostScript-ish name; family+style is usually resolvable.
        try { td.font = L.fontFamily + "-" + (L.fontStyle || "Regular"); } catch (e) {}
    }
    td.justification = ParagraphJustification.CENTER_JUSTIFY;
    srcProp.setValue(td);
}

function importFootage(file) {
    if (!file) return null;
    var f = new File(file);
    if (!f.exists) return null;
    // reuse if already in the project
    for (var i = 1; i <= app.project.numItems; i++) {
        var it = app.project.item(i);
        if (it instanceof FootageItem && it.mainSource && it.mainSource.file &&
            it.mainSource.file.fsName === f.fsName) return it;
    }
    var io = new ImportOptions(f);
    return app.project.importFile(io);
}

// --- transforms + keyframes -------------------------------------------------

function applyCavTransform(ly, L, S, W, H, fps, parentLayer) {
    var tr = ly.property("ADBE Transform Group");
    var anim = L.animated || {};
    var samp = L.samples || {};

    // Cavalry stores a child's position LOCAL to its parent (verified: moving a group
    // leaves the child's value unchanged). AE expresses a child's position in the
    // PARENT'S layer space, whose origin is the parent's ANCHOR POINT. So:
    //   top-level : aeX = cavX + W/2        aeY = H/2 - cavY
    //   parented  : aeX = pAnchorX + cavX   aeY = pAnchorY - cavY
    var ox, oy, sy;
    if (parentLayer) {
        var pa = parentLayer.property("ADBE Transform Group").property("ADBE Anchor Point").value;
        ox = pa[0]; oy = pa[1];
    } else {
        ox = W / 2; oy = H / 2;
    }
    var convX = function (v) { return ox + v; };
    var convY = function (v) { return oy - v; };

    // Position: use SEPARATE DIMENSIONS so X and Y keep their own keys + easing.
    var pos = tr.property("ADBE Position");
    var animX = anim["position.x"], animY = anim["position.y"];
    if (animX || animY) {
        try { pos.dimensionsSeparated = true; } catch (e) {}
        var px = tr.property("ADBE Position_0");
        var py = tr.property("ADBE Position_1");
        if (animX) setChannel(px, animX, samp["position.x"], fps, convX);
        else px.setValue(convX(L.stat["position.x"]));
        if (animY) setChannel(py, animY, samp["position.y"], fps, convY);
        else py.setValue(convY(L.stat["position.y"]));
    } else {
        pos.setValue([convX(L.stat["position.x"]), convY(L.stat["position.y"])]);
    }

    // Rotation (degrees; same sense in both apps)
    var rot = tr.property("ADBE Rotate Z");
    if (anim["rotation.z"]) setChannel(rot, anim["rotation.z"], samp["rotation.z"], fps, function (v) { return v; });
    else rot.setValue(L.stat["rotation.z"] || 0);

    // Scale: Cavalry 0..1 -> AE 0..100. AE scale is 2D; animate via a combined channel
    // only if a single axis is keyed we still need both, so handle the common cases.
    var sc = tr.property("ADBE Scale");
    var sx = L.stat["scale.x"], sy = L.stat["scale.y"];
    if (anim["scale.x"] || anim["scale.y"]) {
        var times = anim["scale.x"] || anim["scale.y"];
        for (var i = 0; i < times.length; i++) {
            var fr = times[i];
            var vx = (samp["scale.x"] && samp["scale.x"][fr] != null) ? samp["scale.x"][fr] : sx;
            var vy = (samp["scale.y"] && samp["scale.y"][fr] != null) ? samp["scale.y"][fr] : sy;
            sc.setValueAtTime(fr / fps, [vx * 100, vy * 100]);
        }
    } else {
        sc.setValue([(sx == null ? 1 : sx) * 100, (sy == null ? 1 : sy) * 100]);
    }

    // Opacity (0..100 both)
    var op = tr.property("ADBE Opacity");
    if (anim["opacity"]) setChannel(op, anim["opacity"], samp["opacity"], fps, function (v) { return v; });
    else op.setValue(L.stat["opacity"] == null ? 100 : L.stat["opacity"]);

    // Text sits on its rendered CENTRE in Cavalry — move AE's anchor to the text's
    // own centre so the same point lands on the same spot.
    if (L.kind === "text") centerTextAnchor(ly);
}

// Set keyframes on a 1-D property, then recover the easing by fitting AE's ease model
// to the curve Cavalry actually evaluated (samples). Cavalry exposes no tangent data,
// so sampling is the only faithful way to carry the ease across.
function setChannel(prop, times, sampleMap, fps, conv) {
    if (!times || !times.length) return;
    var i;
    for (i = 0; i < times.length; i++) {
        var fr = times[i];
        var v = sampleMap ? sampleMap[fr] : null;
        if (v == null) continue;
        prop.setValueAtTime(fr / fps, conv(v));
    }
    // make every key bezier so temporal ease applies
    for (i = 1; i <= prop.numKeys; i++) {
        try {
            prop.setInterpolationTypeAtKey(i, KeyframeInterpolationType.BEZIER, KeyframeInterpolationType.BEZIER);
        } catch (e) {}
    }
    if (!sampleMap) return;

    // per segment: fit a cubic bezier to the sampled curve, convert to AE speed/influence
    for (i = 0; i < times.length - 1; i++) {
        var fA = times[i], fB = times[i + 1];
        var vA = conv(sampleMap[fA]), vB = conv(sampleMap[fB]);
        var dv = vB - vA;
        var dt = (fB - fA) / fps;
        if (dt <= 0) continue;
        if (Math.abs(dv) < 1e-6) continue; // no value change -> nothing to ease

        var ts = [], ys = [];
        for (var fr2 in sampleMap) {
            var fn = parseFloat(fr2);
            if (fn < fA || fn > fB) continue;
            ts.push((fn - fA) / (fB - fA));
            ys.push((conv(sampleMap[fr2]) - vA) / dv);
        }
        if (ts.length < 4) continue;

        var b = fitBezier(ts, ys);
        // AE ease: influence = handle length %, speed = value velocity (units/sec)
        var infOut = clamp(b.x1 * 100, 0.1, 100);
        var infIn = clamp((1 - b.x2) * 100, 0.1, 100);
        var spdOut = (b.x1 > 1e-6) ? (b.y1 / b.x1) * (dv / dt) : 0;
        var spdIn = (b.x2 < 1 - 1e-6) ? ((1 - b.y2) / (1 - b.x2)) * (dv / dt) : 0;

        try {
            var kA = i + 1, kB = i + 2;
            var easeInA = prop.keyInTemporalEase(kA);
            prop.setTemporalEaseAtKey(kA, easeInA, [new KeyframeEase(spdOut, infOut)]);
            var easeOutB = prop.keyOutTemporalEase(kB);
            prop.setTemporalEaseAtKey(kB, [new KeyframeEase(spdIn, infIn)], easeOutB);
        } catch (e) {}
    }
}

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

// Fit a cubic bezier P0=(0,0) P1=(x1,y1) P2=(x2,y2) P3=(1,1) to sampled (t,y) points.
// Coarse grid + local refine — ExtendScript is slow, so keep it small but adequate.
function fitBezier(ts, ys) {
    function bezX(s, x1, x2) { var m = 1 - s; return 3 * m * m * s * x1 + 3 * m * s * s * x2 + s * s * s; }
    function bezY(s, y1, y2) { var m = 1 - s; return 3 * m * m * s * y1 + 3 * m * s * s * y2 + s * s * s; }
    function solveS(t, x1, x2) {
        var s = t;
        for (var i = 0; i < 6; i++) {
            var m = 1 - s;
            var x = bezX(s, x1, x2) - t;
            var d = 3 * m * m * x1 + 6 * m * s * (x2 - x1) + 3 * s * s * (1 - x2);
            if (Math.abs(d) < 1e-9) break;
            var ns = s - x / d;
            if (ns < 0) ns = 0; if (ns > 1) ns = 1;
            if (Math.abs(ns - s) < 1e-6) { s = ns; break; }
            s = ns;
        }
        return s;
    }
    function err(x1, y1, x2, y2) {
        var e = 0;
        for (var i = 0; i < ts.length; i++) {
            var s = solveS(ts[i], x1, x2);
            var d = bezY(s, y1, y2) - ys[i];
            e += d * d;
        }
        return e;
    }
    var best = { x1: 0.33, y1: 0.33, x2: 0.67, y2: 0.67, e: 1e9 };
    // coarse pass
    var xs = [0.05, 0.2, 0.35, 0.5, 0.7, 0.9];
    var yv = [-0.3, 0, 0.2, 0.4, 0.6, 0.8, 1, 1.3];
    for (var a = 0; a < xs.length; a++) for (var b = 0; b < yv.length; b++)
        for (var c = 0; c < xs.length; c++) for (var d2 = 0; d2 < yv.length; d2++) {
            var x1 = xs[a], y1 = yv[b], x2 = 1 - xs[c], y2 = yv[d2];
            var e = err(x1, y1, x2, y2);
            if (e < best.e) { best = { x1: x1, y1: y1, x2: x2, y2: y2, e: e }; }
        }
    // local refine
    var step = 0.12;
    for (var pass = 0; pass < 3; pass++) {
        var improved = true;
        while (improved) {
            improved = false;
            var cand = [
                { x1: best.x1 + step, y1: best.y1, x2: best.x2, y2: best.y2 },
                { x1: best.x1 - step, y1: best.y1, x2: best.x2, y2: best.y2 },
                { x1: best.x1, y1: best.y1 + step, x2: best.x2, y2: best.y2 },
                { x1: best.x1, y1: best.y1 - step, x2: best.x2, y2: best.y2 },
                { x1: best.x1, y1: best.y1, x2: best.x2 + step, y2: best.y2 },
                { x1: best.x1, y1: best.y1, x2: best.x2 - step, y2: best.y2 },
                { x1: best.x1, y1: best.y1, x2: best.x2, y2: best.y2 + step },
                { x1: best.x1, y1: best.y1, x2: best.x2, y2: best.y2 - step }
            ];
            for (var k = 0; k < cand.length; k++) {
                var cx1 = clamp(cand[k].x1, 0.01, 0.99), cx2 = clamp(cand[k].x2, 0.01, 0.99);
                var e2 = err(cx1, cand[k].y1, cx2, cand[k].y2);
                if (e2 < best.e - 1e-9) {
                    best = { x1: cx1, y1: cand[k].y1, x2: cx2, y2: cand[k].y2, e: e2 };
                    improved = true;
                }
            }
        }
        step /= 3;
    }
    return best;
}

// Move a text layer's anchor to its own rendered centre (AE anchors text at the
// baseline/justification origin, Cavalry positions by the glyph centre).
function centerTextAnchor(ly) {
    try {
        var r = ly.sourceRectAtTime(ly.inPoint + 0.001, false);
        var cx = r.left + r.width / 2;
        var cy = r.top + r.height / 2;
        var tr = ly.property("ADBE Transform Group");
        var anchor = tr.property("ADBE Anchor Point");
        anchor.setValue([cx, cy, 0]);
    } catch (e) {}
}

function colorCavToAE(c) {
    return [(c.r || 0) / 255, (c.g || 0) / 255, (c.b || 0) / 255];
}
