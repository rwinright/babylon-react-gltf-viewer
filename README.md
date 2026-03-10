# glTF Viewer

A web-based 3D model viewer built with React and Babylon.js, supporting glTF and GLB files.

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18 or later recommended)

### Installation

```bash
npm install
```

### Running the app

```bash
npm run dev
```

Then open [http://localhost:5173](http://localhost:5173) in your browser.

### Building for production

```bash
npm run build
```

To preview the production build locally:

```bash
npm run preview
```

## Features

- Load glTF/GLB models by URL
- Click to select meshes with highlight glow and transform gizmos
- Scene hierarchy panel with expand/collapse and click-to-select
- Frustum and occlusion culling controls
- Performance metrics overlay (FPS, mesh counts, draw calls, memory usage)

## Model Optimization

Install the [gltf-transform](https://gltf-transform.dev/) CLI to compress models before loading:

```bash
npm install -g @gltf-transform/cli
```

Optimize a model (mesh compression + WebP textures):

For IFC sources, convert to GLB/glTF first (for example with `convert3d.org`), then run optimization.
Long-term, this workflow could be replaced by an internal conversion + optimization service.

```bash
gltf-transform optimize input.glb output.glb --compress meshopt --texture-compress webp --weld --prune
```

## This project uses

- **convert3d.org** - to convert IFC models to GLB format
- **gltf-transform** - to compress GLB files to a considerably smaller size
- **React** - for the front-end
- **Babylon.js** - for 3D model viewing
- **Vite** - for fast local development, hot module replacement (HMR), and optimized production builds


## Performance Benchmarks

### Optimized and Compressed Model 1 — Occlusion Culling (120 Hz monitor)

| Occlusion Culling | FPS      | Memory Usage   |
|-------------------|----------|----------------|
| On                | 120 FPS  | ~240 MB        |
| Off               | 73–79 FPS| 165–180 MB     |

### Optimized and Compressed Model 1 — Frustum Culling

| Frustum Culling | FPS     | Memory Usage |
|-----------------|---------|--------------|
| Off             | 120 FPS | ~260 MB      |
| On              | 120 FPS | ~180 MB      |

Unoptimized models currently perform very poorly in this viewer (around 1 FPS and 1970+ MB memory usage).

## Test Model URL

Use this model to test scene hierarchy behavior and gizmos. It contains multiple meshes and a great scene graph:
[ABeautifulGame.gltf](https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/ABeautifulGame/glTF/ABeautifulGame.gltf)

## Planned Improvements

- Build an internal model pipeline that automates IFC conversion plus glTF optimization (equivalent to the current `convert3d.org` + `gltf-transform` steps).
- Keep meshopt compression with WebP texture conversion as the default optimization path, since it has produced the largest gains in load time, performance, file size, and memory usage.
- Add KTX2 texture support for non-WebP assets so textures remain compressed in VRAM.
