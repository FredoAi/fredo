/**
 * SpatiotemporalManifold
 *
 * 3D Three.js visualization mounted above the Dev Mode event list.
 * Three switchable modes surface different signals useful for training a
 * tool-selection model:
 *
 *  CO-OCC   — Tool co-occurrence: which tools fire together per session?
 *  FLOW     — Temporal flow: events ordered by time / session / tool band.
 *  PRINTS   — Session fingerprints: each session as a vertical tower of tool calls.
 *
 * A download button exports all accumulated events as JSONL training data.
 */

import React, { useRef, useEffect, useState, useCallback } from 'react';
import * as THREE from 'three';
import { Box, HStack, Text } from '@chakra-ui/react';
import { LuMinimize2, LuMaximize2, LuDownload } from 'react-icons/lu';
import type { StreamEvent } from '../../../shared/contexts/StreamContext';
import {
  TOOL_CATEGORY,
  CATEGORY_RGB,
  STATE_RGB,
  MODES,
  toolPosition,
  hash32,
  getCategory,
  type ManifoldMode,
  type ToolCategory,
} from '../config/manifoldConfig';

// ── Sprite factory ────────────────────────────────────────────────────────────

function makeSquareSprite(): THREE.Texture {
  const s = 64;
  const canvas = document.createElement('canvas');
  canvas.width = s;
  canvas.height = s;
  const ctx = canvas.getContext('2d')!;
  // Soft radial halo
  const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
  g.addColorStop(0,    'rgba(255,255,255,0.95)');
  g.addColorStop(0.42, 'rgba(255,255,255,0.28)');
  g.addColorStop(1,    'rgba(255,255,255,0.0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  // Crisp inner square (the "node body")
  ctx.fillStyle = 'rgba(255,255,255,1)';
  ctx.fillRect(22, 22, 20, 20);
  return new THREE.CanvasTexture(canvas);
}

// ── Shared geometry helpers ───────────────────────────────────────────────────

function clearGroup(group: THREE.Group): void {
  while (group.children.length > 0) {
    const child = group.children[0] as THREE.Points | THREE.LineSegments | THREE.Mesh;
    group.remove(child);
    child.geometry?.dispose();
    if (Array.isArray(child.material)) {
      child.material.forEach((m: THREE.Material) => m.dispose());
    } else {
      (child.material as THREE.Material)?.dispose();
    }
  }
}

function makeNodesMaterial(sprite: THREE.Texture): THREE.PointsMaterial {
  return new THREE.PointsMaterial({
    size: 0.42,
    vertexColors: true,
    map: sprite,
    transparent: true,
    alphaTest: 0.05,
    depthWrite: false,
    sizeAttenuation: true,
  });
}

function makeLinesMaterial(opacity = 0.55): THREE.LineBasicMaterial {
  return new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity,
    depthWrite: false,
  });
}

// ── Three.js context type ─────────────────────────────────────────────────────

interface ThreeCtx {
  renderer: THREE.WebGLRenderer;
  scene:    THREE.Scene;
  camera:   THREE.PerspectiveCamera;
  group:    THREE.Group;
  sprite:   THREE.Texture;
  rot:      { x: number; y: number };
  raf:      number;
}

// ── Hook-aware event helpers ──────────────────────────────────────────────────

/** Returns the logical event label: hook event_type when available, else toolName. */
function evLabel(ev: StreamEvent): string {
  if (ev.source === 'OtlpGrpc' || ev.source === 'OtlpHttp') return ev.toolName;
  const meta = ev.input ?? ev.response;
  return (meta as any)?.event_type ?? ev.toolName;
}

/** Returns a stable session identifier — prefers payload.session_id for hook events. */
function evSession(ev: StreamEvent): string {
  const meta = ev.input ?? ev.response;
  return (meta as any)?.payload?.session_id ?? ev.sessionId ?? 'default';
}

// ── Mode A: Tool co-occurrence ────────────────────────────────────────────────

function buildCooccurrence(
  events: StreamEvent[],
  group: THREE.Group,
  sprite: THREE.Texture,
): void {
  // Count Init calls per tool (one tally per Init — Responses are implicit)
  const callCounts = new Map<string, number>();
  events.forEach((ev) => {
    if (ev.state !== 'Init') return;
    const lbl = evLabel(ev);
    callCounts.set(lbl, (callCounts.get(lbl) ?? 0) + 1);
  });

  if (callCounts.size === 0) return;

  // Co-occurrence: per session, collect unique tools used
  const sessionTools = new Map<string, Set<string>>();
  events.forEach((ev) => {
    if (ev.state !== 'Init') return;
    const sid = evSession(ev);
    if (!sessionTools.has(sid)) sessionTools.set(sid, new Set());
    sessionTools.get(sid)!.add(evLabel(ev));
  });

  // Build edge weight map: "toolA::toolB" → session co-occurrence count
  const coocMap = new Map<string, number>();
  sessionTools.forEach((tools) => {
    const arr = [...tools];
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const key = [arr[i], arr[j]].sort().join('::');
        coocMap.set(key, (coocMap.get(key) ?? 0) + 1);
      }
    }
  });

  const toolNames = [...callCounts.keys()];
  const posMap = new Map<string, THREE.Vector3>();
  toolNames.forEach((name) => {
    posMap.set(name, new THREE.Vector3(...toolPosition(name)));
  });

  // ── Nodes ──────────────────────────────────────────────────────────────────
  const nPos: number[] = [], nCol: number[] = [];
  toolNames.forEach((name) => {
    const p = posMap.get(name)!;
    nPos.push(p.x, p.y, p.z);
    const cat = (TOOL_CATEGORY[name] ?? 'unknown') as ToolCategory;
    const [r, g, b] = CATEGORY_RGB[cat];
    nCol.push(r, g, b);
  });

  const nGeo = new THREE.BufferGeometry();
  nGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nPos), 3));
  nGeo.setAttribute('color',    new THREE.BufferAttribute(new Float32Array(nCol), 3));
  group.add(new THREE.Points(nGeo, makeNodesMaterial(sprite)));

  // ── Edges ──────────────────────────────────────────────────────────────────
  const maxCooc = Math.max(1, ...coocMap.values());
  const ePos: number[] = [], eCol: number[] = [];

  coocMap.forEach((count, key) => {
    const [nameA, nameB] = key.split('::');
    const pa = posMap.get(nameA);
    const pb = posMap.get(nameB);
    if (!pa || !pb) return;
    ePos.push(pa.x, pa.y, pa.z, pb.x, pb.y, pb.z);
    const alpha = 0.07 + (count / maxCooc) * 0.5;
    // Slight blue tint on edges to contrast node category colors
    eCol.push(alpha * 0.6, alpha * 0.7, alpha + 0.15, alpha * 0.6, alpha * 0.7, alpha + 0.15);
  });

  if (ePos.length > 0) {
    const eGeo = new THREE.BufferGeometry();
    eGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(ePos), 3));
    eGeo.setAttribute('color',    new THREE.BufferAttribute(new Float32Array(eCol), 3));
    group.add(new THREE.LineSegments(eGeo, makeLinesMaterial(0.9)));
  }
}

// ── Mode B: Temporal flow ─────────────────────────────────────────────────────

function buildFlow(
  events: StreamEvent[],
  group: THREE.Group,
  sprite: THREE.Texture,
): void {
  if (events.length === 0) return;

  const times  = events.map((e) => new Date(e.timestamp).getTime());
  const minT   = Math.min(...times);
  const tSpan  = (Math.max(...times) - minT) || 1;

  const sessions = [...new Set(events.map(evSession))];
  const sessionZ  = new Map<string, number>();
  sessions.forEach((sid, i) => {
    sessionZ.set(sid, sessions.length > 1 ? (i / (sessions.length - 1)) * 8 - 4 : 0);
  });

  const getPos = (ev: StreamEvent): [number, number, number] => {
    const et    = new Date(ev.timestamp).getTime();
    const x     = ((et - minT) / tSpan) * 12 - 6;
    const h     = hash32(evLabel(ev));
    const yBase = ((h & 0xff) / 255) * 8 - 4;
    const yJit  = ((hash32((ev.eventId ?? ev.timestamp) + 'y') & 0x1f) / 31 - 0.5) * 0.65;
    const zBase = sessionZ.get(evSession(ev)) ?? 0;
    const zJit  = ((hash32((ev.eventId ?? ev.timestamp) + 'z') & 0x1f) / 31 - 0.5) * 1.0;
    return [x, yBase + yJit, zBase + zJit];
  };

  // Nodes (state-colored)
  const nPos: number[] = [], nCol: number[] = [];
  events.forEach((ev) => {
    nPos.push(...getPos(ev));
    const [r, g, b] = STATE_RGB[ev.state] ?? [1, 1, 1];
    nCol.push(r, g, b);
  });

  const nGeo = new THREE.BufferGeometry();
  nGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nPos), 3));
  nGeo.setAttribute('color',    new THREE.BufferAttribute(new Float32Array(nCol), 3));
  group.add(new THREE.Points(nGeo, makeNodesMaterial(sprite)));

  // Session flow lines (dim tinted by state)
  const bySession = new Map<string, StreamEvent[]>();
  events.forEach((ev) => {
    const k = evSession(ev);
    if (!bySession.has(k)) bySession.set(k, []);
    bySession.get(k)!.push(ev);
  });

  const lPos: number[] = [], lCol: number[] = [];
  bySession.forEach((sevs) => {
    const sorted = [...sevs].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );
    for (let i = 0; i < sorted.length - 1; i++) {
      lPos.push(...getPos(sorted[i]), ...getPos(sorted[i + 1]));
      const [ra, ga, ba] = STATE_RGB[sorted[i].state]     ?? [1, 1, 1];
      const [rb, gb, bb] = STATE_RGB[sorted[i + 1].state] ?? [1, 1, 1];
      lCol.push(ra * 0.32, ga * 0.32, ba * 0.32, rb * 0.32, gb * 0.32, bb * 0.32);
    }
  });

  if (lPos.length > 0) {
    const lGeo = new THREE.BufferGeometry();
    lGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(lPos), 3));
    lGeo.setAttribute('color',    new THREE.BufferAttribute(new Float32Array(lCol), 3));
    group.add(new THREE.LineSegments(lGeo, makeLinesMaterial(0.55)));
  }
}

// ── Mode C: Session fingerprints ──────────────────────────────────────────────

function buildFingerprints(
  events: StreamEvent[],
  group: THREE.Group,
  sprite: THREE.Texture,
): void {
  if (events.length === 0) return;

  // Assign stable session index order (first-seen)
  const sessionOrder = new Map<string, number>();
  events.forEach((ev) => {
    const k = evSession(ev);
    if (!sessionOrder.has(k)) sessionOrder.set(k, sessionOrder.size);
  });

  const bySession = new Map<string, StreamEvent[]>();
  events.forEach((ev) => {
    const k = evSession(ev);
    if (!bySession.has(k)) bySession.set(k, []);
    bySession.get(k)!.push(ev);
  });
  bySession.forEach((sevs) => {
    sevs.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  });

  const maxSteps    = Math.max(...[...bySession.values()].map((s) => s.length));
  const sessionCount = sessionOrder.size;
  const xSpacing    = 3.2;
  const ySpacing    = 0.65;
  const xOffset     = -((sessionCount - 1) * xSpacing) / 2;
  const yOffset     = -(maxSteps * ySpacing) / 2;

  const nPos: number[] = [], nCol: number[] = [];
  const lPos: number[] = [], lCol: number[] = [];

  bySession.forEach((sevs, sid) => {
    const xi = sessionOrder.get(sid) ?? 0;
    const x  = xOffset + xi * xSpacing;
    sevs.forEach((ev, yi) => {
      const y = yOffset + yi * ySpacing;
      nPos.push(x, y, 0);
      const cat = getCategory(evLabel(ev), ev.source);
      const [r, g, b] = CATEGORY_RGB[cat];
      nCol.push(r, g, b);
      if (yi > 0) {
        const py = yOffset + (yi - 1) * ySpacing;
        lPos.push(x, py, 0, x, y, 0);
        const pcat = getCategory(evLabel(sevs[yi - 1]), sevs[yi - 1].source);
        const [pr, pg, pb] = CATEGORY_RGB[pcat];
        lCol.push(pr * 0.4, pg * 0.4, pb * 0.4, r * 0.4, g * 0.4, b * 0.4);
      }
    });
  });

  if (nPos.length > 0) {
    const nGeo = new THREE.BufferGeometry();
    nGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nPos), 3));
    nGeo.setAttribute('color',    new THREE.BufferAttribute(new Float32Array(nCol), 3));
    group.add(new THREE.Points(nGeo, makeNodesMaterial(sprite)));
  }

  if (lPos.length > 0) {
    const lGeo = new THREE.BufferGeometry();
    lGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(lPos), 3));
    lGeo.setAttribute('color',    new THREE.BufferAttribute(new Float32Array(lCol), 3));
    group.add(new THREE.LineSegments(lGeo, makeLinesMaterial(0.6)));
  }
}

// ── Download ──────────────────────────────────────────────────────────────────

function downloadEvents(events: StreamEvent[]): void {
  const lines = events.map((ev) =>
    JSON.stringify({
      toolName:      ev.toolName,
      state:         ev.state,
      input:         ev.input         ?? null,
      response:      ev.response      ?? null,
      sessionId:     ev.sessionId,
      timestamp:     ev.timestamp,
      eventId:       ev.eventId       ?? null,
      correlationId: ev.correlationId ?? null,
      error:         ev.error         ?? null,
    }),
  );
  const blob = new Blob([lines.join('\n')], { type: 'application/x-ndjson' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `Fredo-events-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Legend dot ────────────────────────────────────────────────────────────────

const LegendDot: React.FC<{ color: string }> = ({ color }) => (
  <Box
    as="span"
    display="inline-block"
    width="5px"
    height="5px"
    borderRadius="full"
    background={color}
    flexShrink={0}
  />
);

// ── Main component ────────────────────────────────────────────────────────────

interface Props {
  events: StreamEvent[];
}

export const SpatiotemporalManifold: React.FC<Props> = ({ events }) => {
  const containerRef                  = useRef<HTMLDivElement>(null);
  const threeRef                      = useRef<ThreeCtx | null>(null);
  const [collapsed, setCollapsed]     = useState(false);
  const [mode, setMode]               = useState<ManifoldMode>('cooccurrence');

  // ── Mount Three.js once ─────────────────────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const w = container.clientWidth  || 400;
    const h = container.clientHeight || 190;

    const scene    = new THREE.Scene();
    scene.fog      = new THREE.FogExp2(0x000000, 0.028);

    const camera   = new THREE.PerspectiveCamera(52, w / h, 0.1, 120);
    camera.position.set(0, 0, 16);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(w, h);
    renderer.setClearColor(0x000000, 1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(renderer.domElement);

    // Background star-field
    const bgCount = 500;
    const bgP = new Float32Array(bgCount * 3);
    for (let i = 0; i < bgCount * 3; i++) bgP[i] = (Math.random() - 0.5) * 50;
    const bgGeo = new THREE.BufferGeometry();
    bgGeo.setAttribute('position', new THREE.BufferAttribute(bgP, 3));
    scene.add(new THREE.Points(bgGeo,
      new THREE.PointsMaterial({ size: 0.04, color: 0x1a2a40, sizeAttenuation: true })));

    // Main group — all mode geometry lives here
    const group = new THREE.Group();
    scene.add(group);

    const sprite = makeSquareSprite();
    const rot    = { x: 0.12, y: 0 };

    const ctx: ThreeCtx = { renderer, scene, camera, group, sprite, rot, raf: 0 };
    threeRef.current = ctx;

    const loop = () => {
      const t = threeRef.current;
      if (!t) return;
      t.raf = requestAnimationFrame(loop);
      t.rot.y           += 0.0022;
      t.group.rotation.y = t.rot.y;
      t.group.rotation.x = t.rot.x;
      t.renderer.render(t.scene, t.camera);
    };
    loop();

    // Orbit drag
    let dragging = false, lx = 0, ly = 0;
    const onDown = (e: MouseEvent) => { dragging = true; lx = e.clientX; ly = e.clientY; };
    const onUp   = ()               => { dragging = false; };
    const onMove = (e: MouseEvent)  => {
      if (!dragging || !threeRef.current) return;
      const t = threeRef.current;
      t.rot.y += (e.clientX - lx) * 0.009;
      t.rot.x  = Math.max(-0.85, Math.min(0.85, t.rot.x + (e.clientY - ly) * 0.005));
      lx = e.clientX; ly = e.clientY;
    };
    renderer.domElement.addEventListener('mousedown', onDown);
    window.addEventListener('mouseup',   onUp);
    window.addEventListener('mousemove', onMove);

    // Scroll to zoom
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (!threeRef.current) return;
      threeRef.current.camera.position.z = Math.max(
        6, Math.min(30, threeRef.current.camera.position.z + e.deltaY * 0.02),
      );
    };
    renderer.domElement.addEventListener('wheel', onWheel, { passive: false });

    // Resize
    const onResize = () => {
      const t = threeRef.current;
      if (!t) return;
      const nw = container.clientWidth, nh = container.clientHeight || 190;
      t.camera.aspect = nw / nh;
      t.camera.updateProjectionMatrix();
      t.renderer.setSize(nw, nh);
    };
    window.addEventListener('resize', onResize);

    return () => {
      cancelAnimationFrame(threeRef.current?.raf ?? 0);
      threeRef.current = null;
      renderer.domElement.removeEventListener('mousedown', onDown);
      renderer.domElement.removeEventListener('wheel',     onWheel);
      window.removeEventListener('mouseup',   onUp);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('resize',    onResize);
      sprite.dispose();
      bgGeo.dispose();
      renderer.dispose();
      if (container.contains(renderer.domElement)) container.removeChild(renderer.domElement);
    };
  }, []);

  // ── Rebuild geometry when events or mode changes ────────────────────────────
  useEffect(() => {
    const t = threeRef.current;
    if (!t) return;

    clearGroup(t.group);

    if (events.length === 0) return;

    switch (mode) {
      case 'cooccurrence': buildCooccurrence(events, t.group, t.sprite); break;
      case 'flow':         buildFlow(events,         t.group, t.sprite); break;
      case 'fingerprints': buildFingerprints(events, t.group, t.sprite); break;
    }
  }, [events, mode]);

  const handleDownload = useCallback(() => downloadEvents(events), [events]);

  // ── Legend config per mode ──────────────────────────────────────────────────
  const legend = mode === 'flow'
    ? [
        { color: '#3b82f6', label: 'Init' },
        { color: '#f59e0b', label: 'Update' },
        { color: '#22c55e', label: 'Response' },
        { color: '#ef4444', label: 'Error' },
      ]
    : [
        { color: '#3b82f6', label: 'kubectl-read' },
        { color: '#ef4444', label: 'kubectl-write' },
        { color: '#22c55e', label: 'observability' },
        { color: '#9333f2', label: 'ui' },
        { color: '#04a5ec', label: 'azdo' },
        { color: '#f59e0b', label: 'meta' },
      ];

  return (
    <Box
      flexShrink={0}
      borderBottom="1px solid"
      borderColor="var(--border-color)"
      position="relative"
      background="#000"
    >
      {/* ── Header ── */}
      <HStack
        position="absolute"
        top="6px"
        left="8px"
        right="8px"
        zIndex={10}
        justify="space-between"
        align="center"
        pointerEvents="none"
      >
        {/* Left: title + legend dots */}
        <HStack gap="5px" pointerEvents="none">
          <Text
            fontSize="8px"
            color="rgba(255,255,255,0.25)"
            textTransform="uppercase"
            letterSpacing="0.1em"
            fontWeight="600"
            fontFamily="monospace"
          >
            manifold
          </Text>
          {legend.map(({ color }) => (
            <LegendDot key={color} color={color} />
          ))}
        </HStack>

        {/* Right: mode chips + download + collapse */}
        <HStack gap="4px" pointerEvents="all">
          {MODES.map(({ id, label, tooltip }) => {
            const active = mode === id;
            return (
              <Box
                key={id}
                as="button"
                onClick={() => setMode(id)}
                title={tooltip}
                px="6px"
                py="1px"
                borderRadius="full"
                fontSize="8px"
                fontWeight="700"
                letterSpacing="0.06em"
                textTransform="uppercase"
                cursor="pointer"
                border="1px solid"
                transition="all 0.15s"
                background={active ? 'rgba(147,51,234,0.20)' : 'transparent'}
                color={active ? '#a855f7' : 'rgba(255,255,255,0.25)'}
                borderColor={active ? 'rgba(147,51,234,0.50)' : 'rgba(255,255,255,0.10)'}
                _hover={{ color: '#c084fc', borderColor: 'rgba(147,51,234,0.4)' }}
                style={{ userSelect: 'none' }}
              >
                {label}
              </Box>
            );
          })}

          {/* Download */}
          <Box
            as="button"
            onClick={handleDownload}
            title={`Download ${events.length} events as JSONL`}
            display="flex"
            alignItems="center"
            cursor={events.length > 0 ? 'pointer' : 'not-allowed'}
            color={events.length > 0 ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.12)'}
            _hover={events.length > 0 ? { color: 'rgba(255,255,255,0.7)' } : undefined}
            style={{ background: 'none', border: 'none', padding: '2px 3px' }}
            aria-label="Download events as JSONL"
          >
            <LuDownload size={10} />
          </Box>

          {/* Collapse */}
          <Box
            as="button"
            onClick={() => setCollapsed((v) => !v)}
            display="flex"
            alignItems="center"
            color="rgba(255,255,255,0.25)"
            _hover={{ color: 'rgba(255,255,255,0.6)' }}
            style={{ background: 'none', border: 'none', padding: '2px 3px', cursor: 'pointer' }}
            aria-label={collapsed ? 'Expand manifold' : 'Collapse manifold'}
          >
            {collapsed ? <LuMaximize2 size={9} /> : <LuMinimize2 size={9} />}
          </Box>
        </HStack>
      </HStack>

      {/* ── Canvas ── */}
      <Box
        ref={containerRef as React.Ref<HTMLDivElement>}
        width="100%"
        height={collapsed ? '0px' : '200px'}
        overflow="hidden"
        style={{ transition: 'height 0.22s ease' }}
      />
    </Box>
  );
};
