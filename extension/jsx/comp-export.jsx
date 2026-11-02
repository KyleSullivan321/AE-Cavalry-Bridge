// AE → Cavalry STRUCTURAL export. Walks the active comp and extracts the
// "transferable bones": footage / text / solid / basic-shape layers with their
// transforms and keyframes. Returns a JSON string the Cavalry importer rebuilds.
// Effects, expressions, masks, custom shape paths, etc. are NOT exported (reported
// as 'dropped'). Called via cavalryBridge_exportComp().

function cavalryBridge_exportComp() {
    try {
        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) return "ERR: no active comp";

        var out = {
            name: comp.name,
            width: comp.width,
            height: comp.height,
            fps: comp.frameRate,
            duration: comp.duration,
            layers: [],
            dropped: []   // {name, reason}
        };

        // AE layers are top(1)..bottom(N); we keep that order.
        for (var i = 1; i <= comp.numLayers; i++) {
            var ly = comp.layer(i);
            var rec = exportLayer(ly, comp);
            if (rec.kind === "unsupported") {
                out.dropped.push({ name: ly.name, reason: rec.reason });
            } else {
                out.layers.push(rec);
            }
        }
        return "OK:" + encodeURIComponent(JSON.stringify(out));
    } catch (e) {
        return "ERR: " + e.toString() + (e.line ? " @" + e.line : "");
    }
}

// classify + export a single layer
function exportLayer(ly, comp) {
    var base = {
        name: ly.name,
        index: ly.index,
        enabled: ly.enabled,
        inPoint: ly.inPoint,
        outPoint: ly.outPoint,
        startTime: ly.startTime,
        transform: exportTransform(ly, comp)
    };

    // Footage layer (image / video / sequence / solid)
    if (ly.source && ly.source instanceof FootageItem) {
        var ms = ly.source.mainSource;
        if (ms instanceof SolidSource) {
            base.kind = "solid";
            base.color = ms.color;            // [r,g,b] 0..1
            base.size = [ly.source.width, ly.source.height];
            return base;
        }
        if (ms && ms.file) {
            base.kind = "footage";
            base.file = ms.file.fsName;
            base.isSequence = (ms.isStill === false && /(\[|\#|%0)/.test("") ) ? true : false; // refined Cavalry-side
            base.isStill = ms.isStill;
            return base;
        }
        // precomp source or fileless footage
        if (ly.source instanceof CompItem) return { kind: "unsupported", reason: "nested comp (precomp)" };
        return { kind: "unsupported", reason: "footage without file" };
    }

    // Text layer
    if (ly instanceof TextLayer) {
        base.kind = "text";
        try {
            var td = ly.property("Source Text").value; // TextDocument
            base.text = td.text;
            base.fontSize = td.fontSize;
            base.font = td.font;          // PostScript name (fallback)
            // proper family + style when available (AE 17.1+); much better for matching
            try { base.fontFamily = td.fontFamily; } catch (e) {}
            try { base.fontStyle = td.fontStyle; } catch (e) {}
            base.fillColor = td.fillColor; // [r,g,b]
            base.justification = "" + td.justification;
            // Rendered text bounds in the layer's local space — lets Cavalry center
            // the text exactly, independent of justification/anchor conventions.
            try {
                var st = comp ? comp.time : 0;
                var rect = ly.sourceRectAtTime(st, false);
                base.bounds = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
            } catch (eB) {}
        } catch (eT) { base.text = ""; }
        return base;
    }

    // Shape layer — only export if simple (single rect/ellipse). Complex paths skip.
    if (ly.matchName === "ADBE Vector Layer") {
        var shape = exportSimpleShape(ly);
        if (shape) { for (var k in shape) base[k] = shape[k]; return base; }
        return { kind: "unsupported", reason: "complex shape layer (paths/operators)" };
    }

    if (ly instanceof CameraLayer) return { kind: "unsupported", reason: "camera" };
    if (ly instanceof LightLayer) return { kind: "unsupported", reason: "light" };
    if (ly.adjustmentLayer) return { kind: "unsupported", reason: "adjustment layer" };

    return { kind: "unsupported", reason: "unhandled layer type" };
}

// Transform + keyframes. Returns {position, scale, rotation, opacity, anchor}
// where each is either {value:...} or {keys:[{frame, value, type}]}.
function exportTransform(ly, comp) {
    var t = ly.property("ADBE Transform Group");
    var out = {
        anchor:   exportProp(t.property("ADBE Anchor Point"), comp),
        position: exportProp(t.property("ADBE Position"), comp),
        scale:    exportProp(t.property("ADBE Scale"), comp),
        rotation: exportProp(t.property("ADBE Rotate Z"), comp),
        opacity:  exportProp(t.property("ADBE Opacity"), comp)
    };
    // If position has Separate Dimensions ON, the combined "ADBE Position" reports
    // placeholder (linear) ease — the real ease lives on the per-axis sub-properties.
    // Export those so Cavalry gets each axis's true ease. (When NOT separated, the
    // sub-props don't exist / dimensionsSeparated is false → skip, combined is right.)
    try {
        var pos = t.property("ADBE Position");
        if (pos && pos.dimensionsSeparated) {
            out.positionX = exportProp(t.property("ADBE Position_0"), comp); // X
            out.positionY = exportProp(t.property("ADBE Position_1"), comp); // Y
        }
    } catch (eSep) {}
    return out;
}

// A single property: static value or keyframes (frame-based).
function exportProp(prop, comp) {
    if (!prop) return null;
    if (prop.numKeys > 0) {
        var keys = [];
        for (var k = 1; k <= prop.numKeys; k++) {
            var rec = {
                frame: Math.round(prop.keyTime(k) * comp.frameRate),
                value: prop.keyValue(k),
                // AE interp enum: 6612=Linear, 6613=Bezier, 6614=Hold (KeyframeInterpolationType)
                inInterp: keyInterpNum(prop.keyInInterpolationType(k)),
                outInterp: keyInterpNum(prop.keyOutInterpolationType(k))
            };
            // temporal ease (influence 0-100, speed) — AE's actual ease curves.
            // Only meaningful for Bezier keys; arrays have per-dimension ease.
            try {
                var ie = prop.keyInTemporalEase(k);   // array of {influence, speed}
                var oe = prop.keyOutTemporalEase(k);
                if (ie && ie.length) rec.inEase = easeArr(ie);
                if (oe && oe.length) rec.outEase = easeArr(oe);
            } catch (eE) {}
            keys.push(rec);
        }
        return { keys: keys };
    }
    return { value: prop.value };
}

// AE KeyframeInterpolationType enum -> small int: 0=Bezier,1=Linear,2=Hold
function keyInterpNum(t) {
    if (t === KeyframeInterpolationType.LINEAR) return 1;
    if (t === KeyframeInterpolationType.HOLD) return 2;
    return 0; // BEZIER
}
function easeArr(arr) {
    var out = [];
    for (var i = 0; i < arr.length; i++) out.push({ influence: arr[i].influence, speed: arr[i].speed });
    return out;
}

// Only handles a shape layer that is a single rectangle or ellipse with a fill.
function exportSimpleShape(ly) {
    try {
        var contents = ly.property("ADBE Root Vectors Group");
        if (!contents || contents.numProperties !== 1) return null; // not simple
        var grp = contents.property(1).property("ADBE Vectors Group");
        if (!grp) return null;
        var geo = null, fill = null;
        for (var i = 1; i <= grp.numProperties; i++) {
            var mn = grp.property(i).matchName;
            if (mn === "ADBE Vector Shape - Rect") geo = { type: "rectangle", prop: grp.property(i) };
            else if (mn === "ADBE Vector Shape - Ellipse") geo = { type: "ellipse", prop: grp.property(i) };
            else if (mn === "ADBE Vector Graphic - Fill") fill = grp.property(i);
        }
        if (!geo) return null;
        var size = geo.prop.property("ADBE Vector Rect Size") || geo.prop.property("ADBE Vector Ellipse Size");
        var out = { kind: "shape", shapeType: geo.type };
        if (size) out.size = size.value;
        if (fill) { try { out.fillColor = fill.property("ADBE Vector Fill Color").value; } catch (e) {} }
        return out;
    } catch (e) { return null; }
}
