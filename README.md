# CHAR-02 — Rigged Character Viewer

A zero-build Three.js (r186) viewer for a QA-verified, rigged + animated game character,
produced by a headless-Blender asset pipeline. Loads a `.glb`, plays its animation clips
with `AnimationMixer`, and offers play/pause, speed, wireframe, skeleton overlay, and stats.

**Live:** open the GitHub Pages URL (defaults to CHAR-02).
Override the model with `?model=./models/<file>.glb`.

## Contents
- `index.html` / `viewer.js` — the viewer (Three.js loaded from the jsDelivr CDN, no build step)
- `models/CHAR-02.glb` — the character (idle + run are Mixamo mocap, retargeted in Blender)

## Asset license
The character mesh/rig derives from a **CC0** base (KayKit, Kay Lousberg). The idle/run motion
is **Adobe Mixamo** mocap (royalty-free), retargeted and baked into the GLB. Use is within those terms.

*Published from the private `ai-game-studio-research` pipeline — this repo contains only the viewer + one asset.*
