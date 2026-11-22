#!/usr/bin/env node
// Checks for the knowledge-graph layout.
//
// The graph panel draws its nodes from a force-directed layout that is
// computed in plain JavaScript, away from the DOM. These checks make sure
// the layout stays inside the panel, stays stable between renders, keeps
// linked notes close together and finds the node under the cursor.
//
// Run with: node scripts/graph-test.mjs

import {
  layoutGraph,
  graphNeighbors,
  graphDegrees,
  nodeRadius,
  pickNode,
  MAX_GRAPH_NODES,
} from '../src/renderer/lib/graph.ts'

let passed = 0
let failed = 0

function check(name, condition, detail) {
  if (condition) {
    passed++
    console.log(`  ok  ${name}`)
  } else {
    failed++
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function section(title) {
  console.log(`\n${title}`)
}

function node(id, links = 0, backlinks = 0, missing = false) {
  return { id, path: id, title: id, links, backlinks, missing }
}

const nodes = [
  node('alpha.md', 2, 1),
  node('beta.md', 1, 1),
  node('gamma.md', 0, 1),
  node('ghost.md', 0, 1, true),
]
const edges = [
  { source: 'alpha.md', target: 'beta.md', kind: 'wikilink' },
  { source: 'alpha.md', target: 'gamma.md', kind: 'wikilink' },
  { source: 'beta.md', target: 'ghost.md', kind: 'markdown' },
]

section('layout')
const layout = layoutGraph(nodes, edges, 260, 200)

check('every node gets a point', layout.points.length === nodes.length, `${layout.points.length}`)
check(
  'the points match the node ids',
  layout.points.every((point) => nodes.some((n) => n.id === point.id)),
)
check('every point is inside the panel', layout.points.every(
  (point) => point.x >= 0 && point.x <= 260 && point.y >= 0 && point.y <= 200,
), JSON.stringify(layout.points))
check('no two nodes sit on the same spot', new Set(layout.points.map((p) => `${p.x.toFixed(2)}:${p.y.toFixed(2)}`)).size === layout.points.length)
check('a radius is given for every node', Object.keys(layout.radii).length === nodes.length)

section('stability')
const again = layoutGraph(nodes, edges, 260, 200)
check(
  'the same input gives the same layout',
  again.points.every((point, i) => Math.abs(point.x - layout.points[i].x) < 0.001 && Math.abs(point.y - layout.points[i].y) < 0.001),
)

section('linked notes stay close')
const byId = new Map(layout.points.map((point) => [point.id, point]))
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)
const linked = distance(byId.get('alpha.md'), byId.get('beta.md'))
const unlinked = distance(byId.get('gamma.md'), byId.get('ghost.md'))
check('a linked pair is closer than an unlinked one', linked < unlinked, `${linked.toFixed(1)} vs ${unlinked.toFixed(1)}`)

section('filling the panel')
const xs = layout.points.map((point) => point.x)
const ys = layout.points.map((point) => point.y)
const spanX = Math.max(...xs) - Math.min(...xs)
const spanY = Math.max(...ys) - Math.min(...ys)
check('the graph uses most of the width', spanX > 260 * 0.6, `${spanX.toFixed(1)} of 260`)
check('the graph uses most of the height', spanY > 200 * 0.6, `${spanY.toFixed(1)} of 200`)

section('neighbours')
const neighbours = graphNeighbors(edges, 'beta.md')
check('the source is found', neighbours.has('alpha.md'))
check('the target is found', neighbours.has('ghost.md'))
check('a stranger is not', !neighbours.has('gamma.md'))

section('degrees and radii')
const degrees = graphDegrees(nodes)
check('links and backlinks are added up', degrees['alpha.md'] === 3, String(degrees['alpha.md']))
check('a busy note is drawn bigger', nodeRadius(node('a', 9, 9), 18) > nodeRadius(node('b', 1, 0), 18))
check('a lonely note still has a radius', nodeRadius(node('c', 0, 0), 0) > 0)

section('picking a node')
const picked = pickNode(layout.points, layout.radii, byId.get('alpha.md').x, byId.get('alpha.md').y)
check('the node under the cursor is found', picked === 'alpha.md', String(picked))
check('empty space picks nothing', pickNode(layout.points, layout.radii, 5, 5) === null)

section('edges')
const empty = layoutGraph([], [], 200, 200)
check('an empty graph lays out to nothing', empty.points.length === 0)
check('an empty graph has no hidden nodes', empty.hidden === 0)

section('large vaults')
const many = Array.from({ length: MAX_GRAPH_NODES + 25 }, (_, i) => node(`note-${i}.md`, 1, 1))
const capped = layoutGraph(many, [], 260, 200)
check('the node count is capped', capped.points.length === MAX_GRAPH_NODES, `${capped.points.length}`)
check('the dropped nodes are counted', capped.hidden === 25, String(capped.hidden))

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
