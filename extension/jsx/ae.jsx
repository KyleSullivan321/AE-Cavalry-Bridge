// ExtendScript: import a PNG sequence as footage and place/update it in the
// active comp. Called from the panel via CSInterface.evalScript.
// Returns a string starting with "OK" on success, "ERR" otherwise.

function cavalryBridge_import(argJson) {
    try {
        var arg = JSON.parse(argJson);
        var firstFile = new File(arg.first);
        if (!firstFile.exists) return "ERR: first frame not found: " + arg.first;

        app.beginUndoGroup("Cavalry Bridge import");

        // Find an existing bridge footage item for this scene (so re-bakes replace,
        // not pile up). We tag it via a comment marker on the footage item.
        var marker = "cavalry-bridge:" + arg.base;
        var existing = null;
        for (var i = 1; i <= app.project.numItems; i++) {
            var it = app.project.item(i);
            if (it instanceof FootageItem && it.comment === marker) { existing = it; break; }
        }

        var io = new ImportOptions(firstFile);
        if (io.canImportAs(ImportAsType.FOOTAGE)) io.importAs = ImportAsType.FOOTAGE;
        io.sequence = true; // treat as image sequence

        // ALWAYS import a fresh footage item (new internal id) so AE cannot serve
        // frames cached against the old item. replaceWithSequence preserved the id
        // and AE kept showing stale cached frames. We then re-point any layers that
        // used the old item to the new one (preserving their transform/position),
        // and delete the old item.
        var footage = app.project.importFile(io);
        footage.comment = marker;

        // Re-point existing layers from the old footage to the new, across all comps.
        // This keeps any user-placed instances (and our dedicated comp's layer) updated.
        var repointed = 0;
        if (existing) {
            for (var ci = 1; ci <= app.project.numItems; ci++) {
                var cc = app.project.item(ci);
                if (!(cc instanceof CompItem)) continue;
                for (var L = 1; L <= cc.numLayers; L++) {
                    var ly = cc.layer(L);
                    if (ly.source && ly.source === existing) {
                        ly.replaceSource(footage, false); // keeps transform/keys
                        repointed++;
                    }
                }
            }
            try { existing.remove(); } catch (eRem) {}
        }

        // Ensure a DEDICATED comp for this Cavalry composition, sized to it. Find
        // our tagged comp if it exists; otherwise create one matching the footage
        // (= Cavalry comp) dimensions, fps and duration, and add the footage to it.
        var compMarker = "cavalry-bridge-comp:" + arg.base;
        var bridgeComp = null;
        for (var pi = 1; pi <= app.project.numItems; pi++) {
            var pit = app.project.item(pi);
            if (pit instanceof CompItem && pit.comment === compMarker) { bridgeComp = pit; break; }
        }
        var fr = footage.frameRate > 0 ? footage.frameRate : 30;
        var dur = footage.duration > 0 ? footage.duration : (arg.count / fr);
        if (!bridgeComp) {
            var compName = (arg.name || arg.base);
            bridgeComp = app.project.items.addComp(compName, footage.width, footage.height, footage.pixelAspect || 1, dur, fr);
            bridgeComp.comment = compMarker;
            bridgeComp.layers.add(footage);
        } else {
            // keep the comp in sync with the (possibly changed) Cavalry comp size
            if (bridgeComp.width !== footage.width || bridgeComp.height !== footage.height) {
                try { bridgeComp.width = footage.width; bridgeComp.height = footage.height; } catch (eSz) {}
            }
            try { bridgeComp.duration = dur; bridgeComp.frameRate = fr; } catch (eDr) {}
            // This comp is dedicated to exactly one bridge footage. Re-point above may
            // or may not have landed cleanly, so consolidate: remove every layer that
            // is NOT the current footage, then ensure exactly one that IS.
            var present = 0;
            for (var bl = bridgeComp.numLayers; bl >= 1; bl--) {
                var bly = bridgeComp.layer(bl);
                if (bly.source === footage) { present++; if (present > 1) bly.remove(); }
                else { bly.remove(); } // stale layer (old/deleted source)
            }
            if (present === 0) bridgeComp.layers.add(footage);
        }
        bridgeComp.openInViewer();
        var comp = bridgeComp;
        var addedTo = bridgeComp.name;

        // Force the viewport to redraw the NEW pixels. Order matters:
        // 1) purge AE's RAM frame cache FIRST (so the stale frame is gone),
        // 2) THEN move the playhead to a different time and back, so AE has to
        //    re-render the current frame from the (new) footage instead of a
        //    cached one. Purging after the nudge just re-caches the stale frame.
        try { app.purge(PurgeTarget.ALL_CACHES); } catch (ePurge) {}
        if (comp && comp instanceof CompItem) {
            var t = comp.time;
            var other = (t === 0) ? comp.frameDuration : 0;
            comp.time = other;
            comp.time = t;
        }

        app.endUndoGroup();
        var srcPath = footage.mainSource && footage.mainSource.file ? footage.mainSource.file.fsName : "?";
        return "OK: " + footage.name + " (" + arg.count + " frames) → " + addedTo + " src=" + srcPath;
    } catch (e) {
        return "ERR: " + e.toString() + (e.line ? " @line " + e.line : "");
    }
}

// Returns the folder of the saved AE project, or "" if unsaved.
function cavalryBridge_projectDir() {
    try {
        if (app.project && app.project.file && app.project.file.exists) {
            return app.project.file.parent.fsName;
        }
    } catch (e) {}
    return "";
}

// --- AE → Cavalry: get file path(s) of selected footage. ---
// Works with items selected in the PROJECT panel (images/video/sequences) AND
// with footage layers selected in a comp. Project selection wins. Returns
// "OK:<path>" (single) or "OK:<p1>\n<p2>..." (multiple), else "ERR:...".
function cavalryBridge_selectedSourcePath() {
    try {
        var paths = [];

        // 1) Project panel selection — FootageItems with a file source.
        var psel = app.project.selection;
        if (psel && psel.length) {
            for (var i = 0; i < psel.length; i++) {
                var it = psel[i];
                if (it instanceof FootageItem && it.mainSource && it.mainSource.file) {
                    paths.push(it.mainSource.file.fsName);
                }
            }
        }

        // 2) Fall back to footage layers selected in the active comp.
        if (paths.length === 0) {
            var comp = app.project.activeItem;
            if (comp && comp instanceof CompItem) {
                var lsel = comp.selectedLayers;
                for (var L = 0; L < lsel.length; L++) {
                    var ly = lsel[L];
                    if (ly.source && ly.source instanceof FootageItem && ly.source.mainSource && ly.source.mainSource.file) {
                        paths.push(ly.source.mainSource.file.fsName);
                    }
                }
            }
        }

        if (paths.length === 0) return "ERR: select an image/video in the Project panel or a footage layer in a comp";
        return "OK:" + paths.join("\n");
    } catch (e) { return "ERR: " + e.toString(); }
}

// --- AE → Cavalry: render the active comp to a PHOTOSHOP (PSD) SEQUENCE. ---
// argJson: {outDir, token}. Returns "OK:<firstFramePath>|frames=<n>|seq=1" or "ERR:".
// Each export goes in its OWN timestamped subfolder so generic comp names
// ("Comp 1") never overwrite previous exports. PSD = lossless + alpha, scriptable
// (the "Photoshop" OM template exists), AND confirmed to load in Cavalry — unlike
// AE's TIFF (Cavalry rejects it) and PNG (not scriptable: format is read-only and
// no PNG template exists).
function cavalryBridge_renderComp(argJson) {
    try {
        var arg = JSON.parse(argJson);
        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) return "ERR: no active comp";

        var safe = comp.name.replace(/[^A-Za-z0-9_\-]+/g, "_");
        var token = (arg.token || ("" + comp.id)).replace(/[^A-Za-z0-9_\-]+/g, "");
        var dir = new Folder(arg.outDir + "/" + safe + "_" + token);
        if (!dir.exists) dir.create();

        var rqItem = app.project.renderQueue.items.add(comp);
        var om = rqItem.outputModule(1);

        // Prefer the "Photoshop" template (PSD sequence). Fall back to TIFF/any seq.
        var tpls = om.templates, psdTpl = null, tiffTpl = null, seqTpl = null;
        for (var t = 0; t < tpls.length; t++) {
            var nm = tpls[t];
            if (/photoshop/i.test(nm)) psdTpl = nm;
            else if (/tiff/i.test(nm)) tiffTpl = nm;
            else if (/sequence/i.test(nm) && !seqTpl) seqTpl = nm;
        }
        var useTpl = psdTpl || tiffTpl || seqTpl;
        if (useTpl) { try { om.applyTemplate(useTpl); } catch (eT) {} }

        // ext follows the template's format (psd). [#####] => frame-numbered sequence.
        om.file = new File(dir.fsName + "/" + safe + "_[#####].psd");
        rqItem.render = true;
        app.project.renderQueue.render();

        var frames = Math.round(comp.duration * comp.frameRate);
        try { rqItem.remove(); } catch (eRm) {}

        var written = dir.getFiles("*.psd");
        if (!written || written.length === 0) written = dir.getFiles();
        if (!written || written.length === 0) return "ERR: no sequence written in " + dir.fsName;
        written.sort(function (a, b) { return a.name < b.name ? -1 : 1; });
        return "OK:" + written[0].fsName + "|frames=" + frames + "|seq=1";
    } catch (e) { return "ERR: " + e.toString() + (e.line ? " @line " + e.line : ""); }
}
