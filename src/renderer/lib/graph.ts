import type { GraphEdge, GraphNode } from '@shared/types'

/**
 * A tiny deterministic PRNG.
 *
 * The graph is laid out from scratch every time the data changes, so the
 * starting positions have to be stable — otherwise the panel would jump
 * around on every re-render.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface GraphPoint {
  id: string
  x: number
  y: number
  /** How strongly the node is pinned — a dragged node never moves again. */
  pinned: boolean
}

export interface GraphLayout {
  points: GraphPoint[]
  width: number
  height: number
  /** Node radius for every node, keyed by id. */
  radii: Record<string, number>
  /** The nodes that were left out because the graph was too large. */
  hidden: number
}

/** Above this many nodes the layout gets expensive and unreadable anyway. */
export const MAX_GRAPH_NODES = 400

/**
 * Radius of a node, scaled by how many links touch it.
 *
 * Well-connected notes read as bigger dots, the way Obsidian draws them.
 */
export function nodeRadius(node: GraphNode, maxDegree: number): number {
  const degree = node.links + node.backlinks
  if (maxDegree <= 0) return 3
  const ratio = Math.sqrt(degree / maxDegree)
  return 2.6 + ratio * 5.4
}

/** The ids of every node directly connected to `id`. */
export function graphNeighbors(edges: GraphEdge[], id: string): Set<string> {
  const out = new Set<string>()
  for (const edge of edges) {
    if (edge.source === id) out.add(edge.target)
    else if (edge.target === id) out.add(edge.source)
  }
  return out
}

/** The degree of every node: links out plus links in. */
export function graphDegrees(nodes: GraphNode[]): Record<string, number> {
  const degrees: Record<string, number> = {}
  for (const node of nodes) degrees[node.id] = node.links + node.backlinks
  return degrees
}

/**
 * Arrange the nodes with a force-directed layout.
 *
 * This is the Fruchterman-Reingold model: every node pushes every other node
 * away, every link pulls its two ends together, and the whole thing is
 * gently pulled towards the middle of the panel. The result is computed once
 * per change rather than animated, so an idle app costs nothing.
 */
export function layoutGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  width: number,
  height: number,
  iterations = 260,
): GraphLayout {
  const radii: Record<string, number> = {}
  if (nodes.length === 0 || width <= 0 || height <= 0) {
    return { points: [], width, height, radii, hidden: 0 }
  }

  // Keep the busiest notes when the vault is huge — the rest would be a smear.
  let working = nodes
  let hidden = 0
  if (nodes.length > MAX_GRAPH_NODES) {
    const sorted = [...nodes].sort(
      (a, b) => b.links + b.backlinks - (a.links + a.backlinks),
    )
    working = sorted.slice(0, MAX_GRAPH_NODES)
    hidden = nodes.length - working.length
  }

  const degrees = graphDegrees(working)
  let maxDegree = 0
  for (const degree of Object.values(degrees)) {
    if (degree > maxDegree) maxDegree = degree
  }
  for (const node of working) radii[node.id] = nodeRadius(node, maxDegree)

  const ids = working.map((node) => node.id)
  const index = new Map(ids.map((id, i) => [id, i]))
  const count = ids.length

  // Start on a ring so the first iterations have something to work with.
  const random = mulberry32(0x5eed)
  const cx = width / 2
  const cy = height / 2
  const ring = Math.min(cx, cy) * 0.72
  const px = new Float64Array(count)
  const py = new Float64Array(count)
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2
    const jitter = 0.75 + random() * 0.5
    px[i] = cx + Math.cos(angle) * ring * jitter
    py[i] = cy + Math.sin(angle) * ring * jitter
  }

  // Only edges between nodes that survived the cap matter.
  const links: Array<[number, number]> = []
  for (const edge of edges) {
    const from = index.get(edge.source)
    const to = index.get(edge.target)
    if (from === undefined || to === undefined) continue
    if (from === to) continue
    links.push([from, to])
  }

  const area = width * height
  // The classic formula assumes a square, which pushes the nodes too far
  // apart in a wide, short panel.
  const k = Math.sqrt(area / Math.max(count, 1)) * 0.55
  let temperature = Math.min(width, height) / 5
  const cooling = temperature / (iterations + 1)

  const fx = new Float64Array(count)
  const fy = new Float64Array(count)

  for (let step = 0; step < iterations; step++) {
    fx.fill(0)
    fy.fill(0)

    // Repulsion between every pair of nodes.
    for (let i = 0; i < count; i++) {
      for (let j = i + 1; j < count; j++) {
        let dx = px[i] - px[j]
        let dy = py[i] - py[j]
        let dist = Math.hypot(dx, dy)
        if (dist < 0.01) {
          // Perfectly overlapping nodes would divide by zero; nudge them apart.
          dx = (random() - 0.5) * 0.1
          dy = (random() - 0.5) * 0.1
          dist = 0.01
        }
        const force = (k * k) / dist
        const ux = dx / dist
        const uy = dy / dist
        fx[i] += ux * force
        fy[i] += uy * force
        fx[j] -= ux * force
        fy[j] -= uy * force
      }
    }

    // Attraction along the links.
    for (const [from, to] of links) {
      const dx = px[from] - px[to]
      const dy = py[from] - py[to]
      const dist = Math.max(Math.hypot(dx, dy), 0.01)
      const force = (dist * dist) / k
      const ux = dx / dist
      const uy = dy / dist
      fx[from] -= ux * force
      fy[from] -= uy * force
      fx[to] += ux * force
      fy[to] += uy * force
    }

    // A gentle pull towards the centre keeps loose notes from drifting off.
    for (let i = 0; i < count; i++) {
      fx[i] += (cx - px[i]) * 0.022
      fy[i] += (cy - py[i]) * 0.022

      const dist = Math.max(Math.hypot(fx[i], fy[i]), 0.01)
      const limit = Math.min(temperature, dist)
      px[i] += (fx[i] / dist) * limit
      py[i] += (fy[i] / dist) * limit

      // Keep every node inside the panel.
      const margin = radii[ids[i]] + 2
      px[i] = Math.min(width - margin, Math.max(margin, px[i]))
      py[i] = Math.min(height - margin, Math.max(margin, py[i]))
    }

    temperature = Math.max(temperature - cooling, 0.4)
  }

  const points: GraphPoint[] = ids.map((id, i) => ({
    id,
    x: px[i],
    y: py[i],
    pinned: false,
  }))

  // Scale and move the finished layout so it fills the panel evenly. Without
  // this the graph tends to sit in one corner.
  if (points.length > 1) {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const point of points) {
      const radius = radii[point.id] ?? 3
      minX = Math.min(minX, point.x - radius)
      minY = Math.min(minY, point.y - radius)
      maxX = Math.max(maxX, point.x + radius)
      maxY = Math.max(maxY, point.y + radius)
    }
    const spanX = Math.max(maxX - minX, 1)
    const spanY = Math.max(maxY - minY, 1)
    const margin = 8
    const scale = Math.min(
      (width - margin * 2) / spanX,
      (height - margin * 2) / spanY,
      1.8,
    )
    const offsetX = (width - spanX * scale) / 2 - minX * scale
    const offsetY = (height - spanY * scale) / 2 - minY * scale
    for (const point of points) {
      point.x = point.x * scale + offsetX
      point.y = point.y * scale + offsetY
      const radius = radii[point.id] ?? 3
      point.x = Math.min(width - radius, Math.max(radius, point.x))
      point.y = Math.min(height - radius, Math.max(radius, point.y))
    }
  }

  return { points, width, height, radii, hidden }
}

/** Find the node under a point, if any. The last match wins so small nodes
 *  sitting on top of big ones stay clickable. */
export function pickNode(points: GraphPoint[], radii: Record<string, number>, x: number, y: number): string | null {
  for (let i = points.length - 1; i >= 0; i--) {
    const point = points[i]
    const radius = radii[point.id] ?? 3
    if (Math.hypot(point.x - x, point.y - y) <= radius + 4) return point.id
  }
  return null
}
