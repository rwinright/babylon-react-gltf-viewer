import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AbstractMesh,
  ArcRotateCamera,
  Color4,
  Engine,
  GizmoManager,
  HemisphericLight,
  HighlightLayer,
  PointerEventTypes,
  Scene,
  SceneLoader,
  Vector3,
} from '@babylonjs/core'
import '@babylonjs/loaders/glTF'
import './App.scss'

const DEFAULT_MODEL_URL = 'https://assets.babylonjs.com/meshes/BoomBox.glb'
const projectModelFiles = import.meta.glob('../models/*.{glb,gltf}', {
  eager: true,
  query: '?url',
  import: 'default',
})

const projectModels = Object.entries(projectModelFiles)
  .map(([path, url]) => {
    const parts = path.split('/')
    const fileName = parts[parts.length - 1]
    return { fileName, url }
  })
  .sort((a, b) => a.fileName.localeCompare(b.fileName))

const optimizedModel = projectModels.find((item) => item.fileName === 'optimized-model.glb')
const INITIAL_MODEL = optimizedModel?.url || DEFAULT_MODEL_URL

function applyCullingSettings(meshes, frustumEnabled, occlusionEnabled) {
  meshes.forEach((mesh) => {
    // Skip transform-only nodes that carry no geometry
    if (mesh.getTotalVertices() === 0) {
      return
    }

    // When enabled, Babylon performs a per-frame frustum check and skips meshes outside the view
    mesh.alwaysSelectAsActiveMesh = !frustumEnabled

    // STRICT: if the previous GPU query reported this mesh as occluded, skip its draw call.
    // One bounding-sphere draw per mesh is still issued as the query itself, so net savings
    // only appear when geometry is actually hidden behind other geometry in the scene.
    mesh.occlusionType = occlusionEnabled
      ? AbstractMesh.OCCLUSION_TYPE_STRICT
      : AbstractMesh.OCCLUSION_TYPE_NONE
  })
}

function getModelBounds(meshes) {
  const min = new Vector3(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY)
  const max = new Vector3(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY)
  let hasBounds = false

  meshes.forEach((mesh) => {
    if (mesh.getTotalVertices() <= 0) {
      return
    }

    const boundingBox = mesh.getBoundingInfo().boundingBox
    min.x = Math.min(min.x, boundingBox.minimumWorld.x)
    min.y = Math.min(min.y, boundingBox.minimumWorld.y)
    min.z = Math.min(min.z, boundingBox.minimumWorld.z)
    max.x = Math.max(max.x, boundingBox.maximumWorld.x)
    max.y = Math.max(max.y, boundingBox.maximumWorld.y)
    max.z = Math.max(max.z, boundingBox.maximumWorld.z)
    hasBounds = true
  })

  if (!hasBounds) {
    return { center: Vector3.Zero(), radius: 1 }
  }

  const center = min.add(max).scale(0.5)
  const radius = Math.max(Vector3.Distance(min, max) * 0.5, 1)
  return { center, radius }
}

function recenterModelRoots(meshes, worldCenter) {
  const rootMeshes = meshes.filter((mesh) => !mesh.parent || mesh.parent.name.startsWith('__root__'))

  rootMeshes.forEach((mesh) => {
    mesh.position.subtractInPlace(worldCenter)
    mesh.computeWorldMatrix(true)
  })
}

function buildHierarchyTree(meshes) {
  const meshById = new Map(meshes.map((mesh) => [mesh.uniqueId, mesh]))
  const nodeById = new Map()

  meshes.forEach((mesh) => {
    nodeById.set(mesh.uniqueId, { mesh, children: [] })
  })

  const roots = []

  meshes.forEach((mesh) => {
    const node = nodeById.get(mesh.uniqueId)
    const parentMesh = mesh.parent

    if (parentMesh && meshById.has(parentMesh.uniqueId)) {
      nodeById.get(parentMesh.uniqueId).children.push(node)
    } else {
      roots.push(node)
    }
  })

  return roots
}

function makeInitialExpandedState(nodes, state = {}) {
  nodes.forEach((node) => {
    state[node.mesh.uniqueId] = true
  })
  return state
}

function App() {
  const canvasRef = useRef(null)
  const engineRef = useRef(null)
  const sceneRef = useRef(null)
  const cameraRef = useRef(null)
  const gizmoManagerRef = useRef(null)
  const highlightLayerRef = useRef(null)
  const selectedMeshRef = useRef(null)
  const loadedMeshesRef = useRef([])
  const activeLoadIdRef = useRef(0)
  const selectedRowRef = useRef(null)


  const [inputUrl, setInputUrl] = useState(INITIAL_MODEL)
  const [selectedModelFile, setSelectedModelFile] = useState(optimizedModel?.fileName || '')

  const [selectedMeshName, setSelectedMeshName] = useState('None')
  const [selectedMeshId, setSelectedMeshId] = useState(null)
  const [gizmoMode, setGizmoMode] = useState('move')
  const [showGizmos, setShowGizmos] = useState(true)
  const [frustumCulling, setFrustumCulling] = useState(true)
  const [occlusionCulling, setOcclusionCulling] = useState(true)
  const [showMetrics, setShowMetrics] = useState(true)
  const [metrics, setMetrics] = useState({ fps: 0, meshes: 0, active: 0, draws: 0, memory: null })
  const [status, setStatus] = useState('Ready')
  const [hierarchyTree, setHierarchyTree] = useState([])
  const [expandedNodes, setExpandedNodes] = useState({})

  const updateGizmoMode = useCallback(() => {
    const manager = gizmoManagerRef.current

    if (!manager) {
      return
    }

    manager.positionGizmoEnabled = showGizmos && gizmoMode === 'move'
    manager.rotationGizmoEnabled = showGizmos && gizmoMode === 'rotate'
    manager.scaleGizmoEnabled = showGizmos && gizmoMode === 'scale'
  }, [gizmoMode, showGizmos])

  const clearCurrentModel = useCallback(() => {
    activeLoadIdRef.current += 1

    if (sceneRef.current) {
      sceneRef.current.unfreezeActiveMeshes()
    }

    if (highlightLayerRef.current && selectedMeshRef.current && !selectedMeshRef.current.isDisposed()) {
      highlightLayerRef.current.removeMesh(selectedMeshRef.current)
    }

    selectedMeshRef.current = null
    setSelectedMeshId(null)

    loadedMeshesRef.current.forEach((mesh) => {
      if (mesh && !mesh.isDisposed()) {
        mesh.dispose(false, true)
      }
    })

    loadedMeshesRef.current = []
    setHierarchyTree([])
    setExpandedNodes({})
    setSelectedMeshName('None')

    if (gizmoManagerRef.current) {
      gizmoManagerRef.current.attachToMesh(null)
    }
  }, [])

  const setSelectedMesh = useCallback((mesh) => {
    const highlightLayer = highlightLayerRef.current

    if (highlightLayer && selectedMeshRef.current && !selectedMeshRef.current.isDisposed()) {
      highlightLayer.removeMesh(selectedMeshRef.current)
    }

    selectedMeshRef.current = mesh

    if (mesh && highlightLayer) {
      highlightLayer.addMesh(mesh, Color4.FromHexString('#ff7f50ff'))
    }

    if (gizmoManagerRef.current) {
      gizmoManagerRef.current.attachToMesh(mesh)
    }

    setSelectedMeshId(mesh?.uniqueId ?? null)
    setSelectedMeshName(mesh?.name || 'None')
  }, [])

  const loadModel = useCallback(
    async (url) => {
      const scene = sceneRef.current

      if (!scene || !url) {
        return
      }

      setStatus('Loading model...')
      scene.unfreezeActiveMeshes()
      clearCurrentModel()

      try {
        const loadId = activeLoadIdRef.current
        const result = await SceneLoader.ImportMeshAsync('', '', url, scene)

        // If a new load started while we were loading, dispose the meshes we just loaded and ignore them
        if (loadId !== activeLoadIdRef.current) {
          result.meshes.forEach((mesh) => {
            if (mesh && !mesh.isDisposed()) {
              mesh.dispose(false, true)
            }
          })
          return
        }

        loadedMeshesRef.current = result.meshes
        const modelMeshes = result.meshes.filter((mesh) => !mesh.name.startsWith('__root__'))

        const tree = buildHierarchyTree(modelMeshes)
        setHierarchyTree(tree)
        setExpandedNodes(makeInitialExpandedState(tree))

        applyCullingSettings(modelMeshes, frustumCulling, occlusionCulling)

        if (modelMeshes.length > 0 && cameraRef.current) {
          const initialBounds = getModelBounds(modelMeshes)
          recenterModelRoots(modelMeshes, initialBounds.center)


          //Make sure the model loads centered in the view, even if the glTF doesn't have correct bounding info or is very far from the origin
          const reframedBounds = getModelBounds(modelMeshes)
          cameraRef.current.setTarget(reframedBounds.center)
          cameraRef.current.radius = Math.max(reframedBounds.radius * 5, 45)
          cameraRef.current.lowerRadiusLimit = Math.max(reframedBounds.radius * 0.2, 1)
          cameraRef.current.upperRadiusLimit = Math.max(reframedBounds.radius * 30, 1200)
        }

        scene.freezeActiveMeshes()
        setStatus(`Loaded ${modelMeshes.length} meshes`)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown loading error'
        setStatus(`Model failed to load: ${message}`)
      }
    },
    [clearCurrentModel, frustumCulling, occlusionCulling],
  )

  useEffect(() => {
    const canvas = canvasRef.current

    if (!canvas) {
      return undefined
    }

    const engine = new Engine(canvas, true)
    const scene = new Scene(engine)
    scene.clearColor = new Color4(0.94, 0.95, 0.97, 1)

    const camera = new ArcRotateCamera('camera', Math.PI / 3, Math.PI / 3, 45, Vector3.Zero(), scene)
    camera.attachControl(canvas, true)
    camera.wheelDeltaPercentage = 0.01

    new HemisphericLight('light', new Vector3(0, 1, 0), scene)

    const highlightLayer = new HighlightLayer('selection-highlight', scene)
    highlightLayer.innerGlow = true
    highlightLayer.outerGlow = true

    const gizmoManager = new GizmoManager(scene)
    gizmoManager.usePointerToAttachGizmos = false

    scene.onPointerObservable.add((eventData) => {
      if (eventData.type === PointerEventTypes.POINTERDOWN) {
        const isHoveringAnyGizmo =
          gizmoManager.gizmos.positionGizmo?.isHovered ||
          gizmoManager.gizmos.rotationGizmo?.isHovered ||
          gizmoManager.gizmos.scaleGizmo?.isHovered

        if (isHoveringAnyGizmo) {
          camera.detachControl()
        }

        return
      }

      if (eventData.type === PointerEventTypes.POINTERUP) {
        camera.attachControl(canvas, true)
        return
      }

      if (eventData.type !== PointerEventTypes.POINTERPICK) {
        return
      }

      const pick = eventData.pickInfo
      if (pick?.hit && pick.pickedMesh) {
        setSelectedMesh(pick.pickedMesh)
        return
      }

      setSelectedMesh(null)
    })

    engine.runRenderLoop(() => {
      engine._drawCalls.fetchNewFrame()
      scene.render()
    })

    const handleResize = () => {
      engine.resize()
    }

    window.addEventListener('resize', handleResize)

    engineRef.current = engine
    sceneRef.current = scene
    cameraRef.current = camera
    gizmoManagerRef.current = gizmoManager
    highlightLayerRef.current = highlightLayer

    queueMicrotask(() => {
      loadModel(INITIAL_MODEL)
    })

    return () => {
      window.removeEventListener('resize', handleResize)

      clearCurrentModel()
      highlightLayer.dispose()
      scene.dispose()
      engine.dispose()
    }
  }, [clearCurrentModel, loadModel, setSelectedMesh])

  useEffect(() => {
    const geometryMeshes = loadedMeshesRef.current.filter(
      (m) => !m.isDisposed() && !m.name.startsWith('__root__'),
    )
    applyCullingSettings(geometryMeshes, frustumCulling, occlusionCulling)
  }, [frustumCulling, occlusionCulling])

  useEffect(() => {
    updateGizmoMode()
  }, [updateGizmoMode])

  useEffect(() => {
    if (!showMetrics) {
      return undefined
    }

    const timer = window.setInterval(() => {
      const engine = engineRef.current
      const scene = sceneRef.current

      if (!engine || !scene) {
        return
      }

      const memInfo = performance.memory
        ? Math.round(performance.memory.usedJSHeapSize / 1048576)
        : null

      setMetrics({
        fps: Math.round(engine.getFps()),
        meshes: scene.meshes.length,
        active: scene.getActiveMeshes().length,
        draws: engine._drawCalls.current,
        memory: memInfo,
      })
    }, 400)

    return () => {
      window.clearInterval(timer)
    }
  }, [showMetrics])

  useEffect(() => {
    selectedRowRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [selectedMeshId])

  const handleLoadFromInputUrl = (event) => {
    event.preventDefault()
    loadModel(inputUrl.trim())
  }

  const handleLoadProjectModel = (model) => {
    setSelectedModelFile(model.fileName)
    setInputUrl(model.url)
    loadModel(model.url)
  }

  const toggleNode = (meshId) => {
    setExpandedNodes((current) => ({ ...current, [meshId]: !current[meshId] }))
  }

  const renderHierarchyNode = (node, depth = 0) => {
    const mesh = node.mesh
    const isExpanded = !!expandedNodes[mesh.uniqueId]
    const hasChildren = node.children.length > 0
    const isSelected = selectedMeshId === mesh.uniqueId

    return (
      <li key={mesh.uniqueId}>
        <div
          ref={isSelected ? selectedRowRef : null}
          className={`tree-row ${isSelected ? 'selected' : ''}`}
          style={{ paddingLeft: `${depth * 14 + 6}px` }}
        >
          <button
            type="button"
            className="tree-toggle"
            onClick={() => hasChildren && toggleNode(mesh.uniqueId)}
            aria-label={hasChildren ? (isExpanded ? 'Collapse node' : 'Expand node') : 'No children'}
          >
            {hasChildren ? (isExpanded ? '▾' : '▸') : '•'}
          </button>
          <button
            type="button"
            className="tree-label"
            onClick={() => setSelectedMesh(mesh)}
            title={mesh.name || 'Unnamed mesh'}
          >
            {mesh.name || 'Unnamed mesh'}
          </button>
        </div>

        {hasChildren && isExpanded && (
          <ul className="tree-list">{node.children.map((child) => renderHierarchyNode(child, depth + 1))}</ul>
        )}
      </li>
    )
  }

  return (
    <div className="layout">
      <aside className="panel">
        <h1>glTF Viewer</h1>
        <p className="subtitle">Babylon.js + React demo for loading and scene control.</p>

        <form onSubmit={handleLoadFromInputUrl} className="field-group">
          <label htmlFor="url">Model URL</label>
          <div className="row">
            <input
              id="url"
              type="text"
              value={inputUrl}
              onChange={(event) => setInputUrl(event.target.value)}
              placeholder="https://example.com/model.glb"
            />
            <button type="submit">Load</button>
          </div>
        </form>

        <div className="field-group">
          <label>Project Models</label>
          {projectModels.length === 0 && (
            <p className="hint-block">Add files to root /models and they will appear here after restart.</p>
          )}
          {projectModels.length > 0 && (
            <div className="project-models">
              {projectModels.map((model) => (
                <button
                  key={model.fileName}
                  type="button"
                  className={selectedModelFile === model.fileName ? 'active' : ''}
                  onClick={() => handleLoadProjectModel(model)}
                >
                  {model.fileName}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="field-group">
          <label>Viewer Controls</label>
          <div className="toggles">
            <label>
              <input
                type="checkbox"
                checked={frustumCulling}
                onChange={(event) => setFrustumCulling(event.target.checked)}
              />
              Frustum Culling
            </label>
            <label>
              <input
                type="checkbox"
                checked={occlusionCulling}
                onChange={(event) => setOcclusionCulling(event.target.checked)}
              />
              Occlusion Culling
            </label>
            <label>
              <input
                type="checkbox"
                checked={showMetrics}
                onChange={(event) => setShowMetrics(event.target.checked)}
              />
              Performance Metrics
            </label>
            <label>
              <input
                type="checkbox"
                checked={showGizmos}
                onChange={(event) => setShowGizmos(event.target.checked)}
              />
              Show Gizmos
            </label>
          </div>
        </div>

        <div className="field-group hierarchy-panel">
          <label>Hierarchy</label>
          {hierarchyTree.length === 0 ? (
            <p className="hint-block">Load a model to inspect its scene graph.</p>
          ) : (
            <ul className="tree-list">{hierarchyTree.map((node) => renderHierarchyNode(node))}</ul>
          )}
        </div>

        <div className="field-group">
          <label>Transform Mode</label>
          <div className="row mode-row">
            <button
              type="button"
              className={gizmoMode === 'move' ? 'active' : ''}
              onClick={() => setGizmoMode('move')}
            >
              Move
            </button>
            <button
              type="button"
              className={gizmoMode === 'rotate' ? 'active' : ''}
              onClick={() => setGizmoMode('rotate')}
            >
              Rotate
            </button>
            <button
              type="button"
              className={gizmoMode === 'scale' ? 'active' : ''}
              onClick={() => setGizmoMode('scale')}
            >
              Scale
            </button>
          </div>
        </div>

        <div className="status">
          <p>Status: {status}</p>
          <p>Selected: {selectedMeshName}</p>
          <p className="hint">Tip: click a mesh in the canvas to attach gizmos.</p>
        </div>
      </aside>

      <main className="viewer-wrap">
        <canvas ref={canvasRef} className="viewer-canvas" />
        {showMetrics && (
          <div className="metrics">
            <p>FPS: {metrics.fps}</p>
            <p>Meshes: {metrics.meshes}</p>
            <p>Active: {metrics.active}</p>
            <p>Draw Calls: {metrics.draws}</p>
            {metrics.memory !== null && <p>Memory: {metrics.memory} MB</p>}
          </div>
        )}
      </main>
    </div>
  )
}

export default App
