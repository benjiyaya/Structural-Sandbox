# Structural Architecture Simulator (BBDP)

An educational, browser-based 2D structural stress-testing sandbox. Load a
preset structure (two bridges, a skyscraper, a school, a truck) or draw your
own, then apply point weights, wind, and rain, run a linear static frame
analysis, and inspect a color-coded stress heatmap, exaggerated deformation,
safety factors, and a progressive-collapse failure sequence.

Everything is plain HTML/CSS/JavaScript with **zero dependencies** — no npm
packages, no build step, no CDNs, no external network requests. It works
fully offline.

<img width="1582" height="936" alt="Screenshot 2026-07-31 232815" src="https://github.com/user-attachments/assets/c26d125d-7ee5-4c11-86eb-8f52ff528064" />


## Run

Requires Node.js (any recent version; developed on v25).

```
node server.js        # or: npm start
```

Then open http://localhost:8181/ in a browser.

## Test

```
node test/run-tests.js   # or: npm test
```

22 unit tests check the solver against closed-form structural-mechanics
results (axial bar, cantilever, simply supported beam), edge cases (zero
load, mechanism), progressive failure, load assembly (wind/rain/weights),
the save/load project format, and verify all 5 presets are SAFE under
self-weight.

## Desktop app (Electron)

Requires `npm install` once (dev-only: electron + electron-builder; the app
itself stays zero-dependency).

```
npm run app    # run the desktop app from source
npm run dist   # build an unpacked Windows folder: dist/win-unpacked/
```

The packaged app is fully offline and portable: unzip and run
`Structural Sandbox.exe`.

## Features

- **Physics**: 2D direct-stiffness frame analysis (Euler-Bernoulli elements,
  3 DOF per node), custom Gaussian elimination with partial pivoting,
  mechanism detection, tension-only cables that go slack, Euler buckling
  check, progressive-collapse simulation. See [PHYSICS.md](PHYSICS.md) for
  the model, assumptions, and honest limitations.
- **Presets**: Truss Bridge (30 m Warren truss), Suspension Bridge (40 m,
  towers + main cables + hangers + backstays), Skyscraper (10-story
  concrete/steel frame), School (2-story timber/steel with gable roof),
  Truck (ladder chassis, 4 wheels, payload). All SAFE under self-weight.
- **Editor**: add/move/delete nodes and members, fixed/pinned/roller
  supports, per-node point weights (10–5000 kg), member material
  (steel/concrete/wood), type (beam/column/cable), and section
  (thin/medium/thick). Node snapping (8 px), pan (middle/right drag,
  space+drag, or drag empty space in Select mode) and wheel zoom.
- **Environment**: wind 0–300 km/h (either direction) with animated streak
  particles, rain 0–100 % with animated streaks.
- **Save / load**: export the current structure to a version-stamped JSON
  project file (model + environment) and load it back later. Loading
  validates the file first — a bad file shows the specific reason and never
  touches the canvas.
- **Results**: status banner (SAFE / WARNING / CRITICAL / COLLAPSE), minimum
  safety factor, max displacement (mm), per-member stress heatmap
  (green → yellow → orange → flashing red, failed members black dashed),
  deformed-shape overlay (auto-scaled ×20–100, factor shown on screen), and
  the ordered failure sequence.

## Controls quick reference

| Mode | Action |
|---|---|
| Select / Move | Drag node to move; drag empty space to pan |
| Add Node | Click to place a node |
| Add Member | Click two endpoints (chains; Esc cancels) |
| Add Support | Click a node to apply the selected support type |
| Add Weight | Click a node to attach/update the slider mass |
| Delete | Click member to delete; click node to remove support → weight → node |

Wind/rain sliders re-run the analysis automatically on release.

## Project layout

```
server.js                 zero-dep static server (port 8181)
public/
  index.html              UI shell
  css/style.css
  js/physics/model.js     materials, sections, model helpers
  js/physics/loads.js     load assembly (gravity, weights, wind, rain)
  js/physics/solver.js    direct stiffness solver + progressive collapse
  js/presets.js           5 preset structures
  js/renderer.js          canvas rendering (heatmap, deformation, particles)
  js/editor.js            mouse editing interactions
  js/app.js               UI wiring
test/
  run-tests.js            zero-dep test runner
  solver.test.js
  loads.test.js
```

## Honest disclaimer

This is a **teaching toy, not engineering software**. It uses linear static
first-order analysis only — no P-delta/geometric stiffness, no dynamics, no
material nonlinearity, lumped (not consistent) loads, and a simplified
tension=compression strength model. Never use it to assess a real
structure. See PHYSICS.md for the full list of simplifications.
