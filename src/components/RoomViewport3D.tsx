import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { clampPanelToRoom, getSpeakerPositions } from '../acoustics/engine';
import { BASE_MATERIALS, TREATMENT_CATALOG, WALL_FACE_LABELS } from '../acoustics/materials';
import {
  PlacedPanel,
  RecommendedHint,
  ReflectionRay,
  RoomConfig,
  Vec3,
  WallFace,
} from '../acoustics/types';

export type CadToolMode = 'smart' | 'orbit' | 'pan';
export type CadCameraMode = 'persp' | 'ortho';

interface RoomViewport3DProps {
  room: RoomConfig;
  panels: PlacedPanel[];
  selectedPanelId: string | null;
  reflections: ReflectionRay[];
  recommendations: RecommendedHint[];
  hoveredHintId: string | null;
  showRays: boolean;
  showFloorRays: boolean;
  showHints: boolean;
  showBassHeatmap: boolean;
  heatmapFreqHz: number;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onSelectPanel: (id: string | null) => void;
  onUpdatePanel: (updated: PlacedPanel) => void;
  onUpdateSpeakerPos: (pos: Vec3) => void;
  onUpdateListenerPos: (pos: Vec3) => void;
}

interface DragTarget {
  kind: 'panel' | 'speaker' | 'listener';
  panelId?: string;
  plane: THREE.Plane;
}

function makeTextSprite(text: string, color = '#94a3b8', bg = 'rgba(11,18,32,0.82)'): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.roundRect(8, 8, 240, 48, 10);
  ctx.fill();
  ctx.strokeStyle = 'rgba(148,163,184,0.35)';
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.font = 'bold 24px "Segoe UI", "Microsoft YaHei", sans-serif';
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 128, 33);

  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(0.95, 0.24, 1);
  return sprite;
}

function makeBassHeatmapTexture(room: RoomConfig, freqHz: number): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(size, size);

  const c = 343.0;
  const activeModes: { nx: number; nz: number; weight: number }[] = [];
  for (let nx = 0; nx <= 4; nx++) {
    for (let nz = 0; nz <= 4; nz++) {
      if (nx === 0 && nz === 0) continue;
      const f = 0.5 * c * Math.sqrt((nx / room.width) ** 2 + (nz / room.length) ** 2);
      const detune = Math.abs(f - freqHz);
      const w = 1 / (1 + (detune / 18) ** 2);
      if (w > 0.08) {
        activeModes.push({ nx, nz, weight: w });
      }
    }
  }
  if (activeModes.length === 0) {
    activeModes.push({ nx: 1, nz: 0, weight: 1 }, { nx: 0, nz: 1, weight: 1 });
  }

  for (let py = 0; py < size; py++) {
    const zNorm = py / (size - 1);
    for (let px = 0; px < size; px++) {
      const xNorm = px / (size - 1);
      let energy = 0;
      let wSum = 0;
      for (const m of activeModes) {
        const p = Math.cos(m.nx * Math.PI * xNorm) * Math.cos(m.nz * Math.PI * zNorm);
        energy += m.weight * (p * p);
        wSum += m.weight;
      }
      const val = Math.min(1, Math.max(0, energy / Math.max(wSum, 0.001)));

      let r = 20, g = 35, b = 80;
      if (val < 0.5) {
        const t = val / 0.5;
        r = Math.round(18 + t * 90);
        g = Math.round(45 + t * 25);
        b = Math.round(120 + t * 40);
      } else {
        const t = (val - 0.5) / 0.5;
        r = Math.round(108 + t * 147);
        g = Math.round(70 + t * 115 * (1 - 0.35 * t));
        b = Math.round(160 * (1 - t) + 25);
      }

      const idx = (py * size + px) * 4;
      img.data[idx] = r;
      img.data[idx + 1] = g;
      img.data[idx + 2] = b;
      img.data[idx + 3] = 215;
    }
  }

  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

function disposeGroup(group: THREE.Group): void {
  while (group.children.length > 0) {
    const child = group.children[0];
    group.remove(child);
    child.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const sprite = obj as THREE.Sprite;
      if (sprite.material && (sprite.material as THREE.SpriteMaterial).map) {
        (sprite.material as THREE.SpriteMaterial).map!.dispose();
      }
      if (mesh.material) {
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of mats) {
          const stdMat = m as THREE.MeshStandardMaterial;
          if (stdMat.map) stdMat.map.dispose();
          m.dispose();
        }
      }
    });
  }
}

function snapVal(val: number, snapOn: boolean, step = 0.05): number {
  return snapOn ? Math.round(val / step) * step : val;
}

/**
 * 直接在房间内部空间 [0, width] x [0, height] x [0, length] 中构建四角内贴三棱柱几何体
 * 修复 ExtrudeGeometry 旋转后 Z 坐标翻负导致低频陷阱突出到房间外墙的几何 bug
 */
function buildInteriorCornerPrismGeometry(
  cornerIndex: 0 | 1 | 2 | 3,
  legSize: number,
  height: number,
  centerY: number,
  roomW: number,
  roomH: number,
  roomL: number
): THREE.BufferGeometry {
  const eps = 0.012;
  const s = Math.min(legSize, roomW * 0.42, roomL * 0.42);
  const y0 = Math.max(0.01, centerY - height * 0.5);
  const y1 = Math.min(roomH - 0.01, centerY + height * 0.5);

  let ax = eps, az = eps;
  let bx = eps, bz = eps + s;
  let cx = eps + s, cz = eps;

  if (cornerIndex === 1) {
    // 右前内墙角 (x=W, z=0) -> 向室内 (-x, +z) 延伸
    ax = roomW - eps; az = eps;
    bx = roomW - eps - s; bz = eps;
    cx = roomW - eps; cz = eps + s;
  } else if (cornerIndex === 2) {
    // 左后内墙角 (x=0, z=L) -> 向室内 (+x, -z) 延伸
    ax = eps; az = roomL - eps;
    bx = eps + s; bz = roomL - eps;
    cx = eps; cz = roomL - eps - s;
  } else if (cornerIndex === 3) {
    // 右后内墙角 (x=W, z=L) -> 向室内 (-x, -z) 延伸
    ax = roomW - eps; az = roomL - eps;
    bx = roomW - eps; bz = roomL - eps - s;
    cx = roomW - eps - s; cz = roomL - eps;
  }

  const positions = new Float32Array([
    // Top cap (+Y)
    ax, y1, az,  bx, y1, bz,  cx, y1, cz,
    // Bottom cap (-Y)
    ax, y0, az,  cx, y0, cz,  bx, y0, bz,
    // Wall leg A-B
    ax, y0, az,  bx, y0, bz,  bx, y1, bz,
    ax, y0, az,  bx, y1, bz,  ax, y1, az,
    // Hypotenuse B-C (朝向房间中心斜面)
    bx, y0, bz,  cx, y0, cz,  cx, y1, cz,
    bx, y0, bz,  cx, y1, cz,  bx, y1, bz,
    // Wall leg C-A
    cx, y0, cz,  ax, y0, az,  ax, y1, az,
    cx, y0, cz,  ax, y1, az,  cx, y1, cz,
  ]);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  return geo;
}

export const RoomViewport3D: React.FC<RoomViewport3DProps> = ({
  room,
  panels,
  selectedPanelId,
  reflections,
  recommendations,
  hoveredHintId,
  showRays,
  showFloorRays,
  showHints,
  showBassHeatmap,
  heatmapFreqHz,
  isExpanded,
  onToggleExpand,
  onSelectPanel,
  onUpdatePanel,
  onUpdateSpeakerPos,
  onUpdateListenerPos,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const axisCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const [toolMode, setToolMode] = useState<CadToolMode>('smart');
  const [cameraMode, setCameraMode] = useState<CadCameraMode>('persp');
  const [gridSnap, setGridSnap] = useState<boolean>(true);
  const [statusText, setStatusText] = useState<string>(
    '左键旋转 · 右键/中键平移拖动 · 滚轮指哪缩哪 · 点选音箱/板材可直接拖移'
  );

  const sceneRefs = useRef<{
    scene: THREE.Scene;
    perspCam: THREE.PerspectiveCamera;
    orthoCam: THREE.OrthographicCamera;
    activeCam: THREE.Camera;
    renderer: THREE.WebGLRenderer;
    controls: OrbitControls;
    rootOffsetGroup: THREE.Group;
    shellGroup: THREE.Group;
    panelsGroup: THREE.Group;
    actorsGroup: THREE.Group;
    raysGroup: THREE.Group;
    hintsGroup: THREE.Group;
    wallMeshes: { face: WallFace; inwardNormal: THREE.Vector3; mesh: THREE.Mesh }[];
  } | null>(null);

  const latestRef = useRef({
    room,
    panels,
    toolMode,
    gridSnap,
    onSelectPanel,
    onUpdatePanel,
    onUpdateSpeakerPos,
    onUpdateListenerPos,
  });
  latestRef.current = {
    room,
    panels,
    toolMode,
    gridSnap,
    onSelectPanel,
    onUpdatePanel,
    onUpdateSpeakerPos,
    onUpdateListenerPos,
  };

  // 更新 OrbitControls 鼠标按键映射（像 CAD 一样支持纯平移小手模式与标准旋转+平移模式）
  useEffect(() => {
    const refs = sceneRefs.current;
    if (!refs) return;
    const { controls } = refs;
    if (toolMode === 'pan') {
      controls.mouseButtons = {
        LEFT: THREE.MOUSE.PAN,
        MIDDLE: THREE.MOUSE.DOLLY,
        RIGHT: THREE.MOUSE.ROTATE,
      };
      setStatusText('【平移模式】左键直接上下左右拖动画布 · 右键旋转 · 滚轮对准光标缩放');
    } else if (toolMode === 'orbit') {
      controls.mouseButtons = {
        LEFT: THREE.MOUSE.ROTATE,
        MIDDLE: THREE.MOUSE.PAN,
        RIGHT: THREE.MOUSE.PAN,
      };
      setStatusText('【纯浏览旋转模式】左键任意位置旋转（防误触移位） · 右键/中键平移拖动画布');
    } else {
      controls.mouseButtons = {
        LEFT: THREE.MOUSE.ROTATE,
        MIDDLE: THREE.MOUSE.PAN,
        RIGHT: THREE.MOUSE.PAN,
      };
      setStatusText('左键空白旋转 / 点物体拖动移位 · 右键或按住空格拖动画布 · 滚轮指哪缩哪');
    }
  }, [toolMode]);

  // 透视相机 <-> 正交 CAD 工程相机无缝切换
  useEffect(() => {
    const refs = sceneRefs.current;
    const container = containerRef.current;
    if (!refs || !container) return;

    const { perspCam, orthoCam, controls } = refs;
    const w = Math.max(container.clientWidth, 100);
    const h = Math.max(container.clientHeight, 100);
    const aspect = w / h;

    if (cameraMode === 'ortho') {
      const dist = perspCam.position.distanceTo(controls.target);
      const halfH = Math.max(1.2, dist * Math.tan(THREE.MathUtils.degToRad(perspCam.fov * 0.5)));
      orthoCam.left = -halfH * aspect;
      orthoCam.right = halfH * aspect;
      orthoCam.top = halfH;
      orthoCam.bottom = -halfH;
      orthoCam.zoom = 1;
      orthoCam.position.copy(perspCam.position);
      orthoCam.quaternion.copy(perspCam.quaternion);
      orthoCam.updateProjectionMatrix();
      refs.activeCam = orthoCam;
      controls.object = orthoCam;
    } else {
      perspCam.position.copy(orthoCam.position);
      perspCam.quaternion.copy(orthoCam.quaternion);
      perspCam.aspect = aspect;
      perspCam.updateProjectionMatrix();
      refs.activeCam = perspCam;
      controls.object = perspCam;
    }
    controls.update();
  }, [cameraMode]);

  // 初始化 Three.js 场景与 CAD 级交互控制
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#090e19');

    const w0 = Math.max(container.clientWidth, 100);
    const h0 = Math.max(container.clientHeight, 100);
    const aspect0 = w0 / h0;

    const perspCam = new THREE.PerspectiveCamera(44, aspect0, 0.1, 100);
    perspCam.position.set(5.2, 4.1, 5.6);

    const orthoCam = new THREE.OrthographicCamera(
      -4 * aspect0,
      4 * aspect0,
      4,
      -4,
      -30,
      100
    );
    orthoCam.position.copy(perspCam.position);

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(w0, h0);
    container.innerHTML = '';
    container.appendChild(renderer.domElement);
    // 禁用画布默认右键菜单，确保右键丝滑平移！
    renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());

    const controls = new OrbitControls(perspCam, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.screenSpacePanning = true; // 真正的 CAD 屏幕平面任意上下左右拖动！
    controls.zoomToCursor = true;       // 真正的 CAD 对准鼠标光标位置缩放！
    controls.panSpeed = 1.05;
    controls.rotateSpeed = 0.85;
    controls.zoomSpeed = 1.15;
    controls.target.set(0, 1.15, 0);
    controls.minPolarAngle = 0.02;
    controls.maxPolarAngle = Math.PI * 0.88; // 允许仰视查看天花板吊顶
    controls.minDistance = 1.2;
    controls.maxDistance = 28.0;
    controls.minZoom = 0.25;
    controls.maxZoom = 6.0;
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.PAN,
      RIGHT: THREE.MOUSE.PAN,
    };

    scene.add(new THREE.AmbientLight('#dce8ff', 0.78));
    const keyLight = new THREE.DirectionalLight('#ffffff', 0.92);
    keyLight.position.set(6, 10, 7);
    scene.add(keyLight);
    const fillLight = new THREE.DirectionalLight('#60a5fa', 0.35);
    fillLight.position.set(-6, 4, -6);
    scene.add(fillLight);

    // 外部 CAD 大地坐标参考网格
    const worldGrid = new THREE.GridHelper(24, 24, '#1e293b', '#11192b');
    worldGrid.position.y = -0.02;
    scene.add(worldGrid);

    const rootOffsetGroup = new THREE.Group();
    const shellGroup = new THREE.Group();
    const panelsGroup = new THREE.Group();
    const actorsGroup = new THREE.Group();
    const raysGroup = new THREE.Group();
    const hintsGroup = new THREE.Group();

    rootOffsetGroup.add(shellGroup, hintsGroup, panelsGroup, actorsGroup, raysGroup);
    scene.add(rootOffsetGroup);

    sceneRefs.current = {
      scene,
      perspCam,
      orthoCam,
      activeCam: perspCam,
      renderer,
      controls,
      rootOffsetGroup,
      shellGroup,
      panelsGroup,
      actorsGroup,
      raysGroup,
      hintsGroup,
      wallMeshes: [],
    };

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let activeDrag: DragTarget | null = null;
    let pointerDownPos = { x: 0, y: 0 };
    let spacePressed = false;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && document.activeElement?.tagName !== 'INPUT') {
        spacePressed = true;
        controls.mouseButtons.LEFT = THREE.MOUSE.PAN;
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        spacePressed = false;
        controls.mouseButtons.LEFT =
          latestRef.current.toolMode === 'pan' ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    const updatePointer = (ev: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    };

    const getWallDragPlane = (face: WallFace, r: RoomConfig): THREE.Plane => {
      const ox = -r.width * 0.5;
      const oz = -r.length * 0.5;
      switch (face) {
        case 'left':
          return new THREE.Plane(new THREE.Vector3(1, 0, 0), -ox);
        case 'right':
          return new THREE.Plane(new THREE.Vector3(-1, 0, 0), ox + r.width);
        case 'front':
          return new THREE.Plane(new THREE.Vector3(0, 0, 1), -oz);
        case 'rear':
          return new THREE.Plane(new THREE.Vector3(0, 0, -1), oz + r.length);
        case 'ceiling':
          return new THREE.Plane(new THREE.Vector3(0, -1, 0), r.height);
        case 'floor':
          return new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
      }
    };

    const onPointerDown = (ev: PointerEvent) => {
      if (ev.button !== 0) return;
      pointerDownPos = { x: ev.clientX, y: ev.clientY };

      const {
        room: curRoom,
        panels: curPanels,
        toolMode: curMode,
        onSelectPanel: selectCb,
      } = latestRef.current;

      // 在「纯旋转」或「平移画布」或按住空格/Shift时，完全交给 OrbitControls 漫游！
      if (curMode !== 'smart' || spacePressed || ev.shiftKey) return;

      const cam = sceneRefs.current?.activeCam ?? perspCam;
      updatePointer(ev);
      raycaster.setFromCamera(pointer, cam);

      // 1. 检测音箱 / 听音位
      const actorHits = raycaster.intersectObjects(actorsGroup.children, true);
      if (actorHits.length > 0) {
        let obj: THREE.Object3D | null = actorHits[0].object;
        while (obj && !obj.userData?.actorKind) {
          obj = obj.parent;
        }
        if (obj?.userData?.actorKind === 'speaker') {
          activeDrag = {
            kind: 'speaker',
            plane: new THREE.Plane(new THREE.Vector3(0, 1, 0), -curRoom.speakerPos.y),
          };
          controls.enabled = false;
          return;
        }
        if (obj?.userData?.actorKind === 'listener') {
          activeDrag = {
            kind: 'listener',
            plane: new THREE.Plane(new THREE.Vector3(0, 1, 0), -curRoom.listenerPos.y),
          };
          controls.enabled = false;
          return;
        }
      }

      // 2. 检测已放置的声学材料板
      const panelHits = raycaster.intersectObjects(panelsGroup.children, true);
      if (panelHits.length > 0) {
        let obj: THREE.Object3D | null = panelHits[0].object;
        while (obj && !obj.userData?.panelId) {
          obj = obj.parent;
        }
        const pid = obj?.userData?.panelId as string | undefined;
        if (pid) {
          selectCb(pid);
          const found = curPanels.find((p) => p.id === pid);
          if (found) {
            activeDrag = {
              kind: 'panel',
              panelId: pid,
              plane: getWallDragPlane(found.face, curRoom),
            };
            controls.enabled = false;
          }
        }
      }
    };

    const onPointerMove = (ev: PointerEvent) => {
      if (!activeDrag) return;
      const cam = sceneRefs.current?.activeCam ?? perspCam;
      updatePointer(ev);
      raycaster.setFromCamera(pointer, cam);

      const worldHit = new THREE.Vector3();
      if (!raycaster.ray.intersectPlane(activeDrag.plane, worldHit)) return;

      const {
        room: curRoom,
        panels: curPanels,
        gridSnap: snapOn,
        onUpdatePanel: updatePanelCb,
        onUpdateSpeakerPos: updateSpkCb,
        onUpdateListenerPos: updateMicCb,
      } = latestRef.current;

      const rx = snapVal(worldHit.x + curRoom.width * 0.5, snapOn);
      const ry = snapVal(worldHit.y, snapOn);
      const rz = snapVal(worldHit.z + curRoom.length * 0.5, snapOn);

      if (activeDrag.kind === 'speaker') {
        const nx = Math.max(0.3, Math.min(curRoom.width - 0.3, Number(rx.toFixed(2))));
        const nz = Math.max(0.25, Math.min(curRoom.length - 0.35, Number(rz.toFixed(2))));
        setStatusText(`拖动发声源坐标: X=${nx.toFixed(2)}m, Y=${curRoom.speakerPos.y.toFixed(2)}m, Z=${nz.toFixed(2)}m`);
        updateSpkCb({ x: nx, y: curRoom.speakerPos.y, z: nz });
      } else if (activeDrag.kind === 'listener') {
        const nx = Math.max(0.3, Math.min(curRoom.width - 0.3, Number(rx.toFixed(2))));
        const nz = Math.max(0.35, Math.min(curRoom.length - 0.3, Number(rz.toFixed(2))));
        setStatusText(`拖动听音位坐标: X=${nx.toFixed(2)}m, Z=${nz.toFixed(2)}m (房间深度 ${((nz / curRoom.length) * 100).toFixed(0)}%)`);
        updateMicCb({ x: nx, y: curRoom.listenerPos.y, z: nz });
      } else if (activeDrag.kind === 'panel' && activeDrag.panelId) {
        const dragPid = activeDrag.panelId;
        const targetPanel = curPanels.find((p) => p.id === dragPid);
        if (!targetPanel) return;
        const spec = TREATMENT_CATALOG[targetPanel.productId];

        if (spec.cornerSnap) {
          const corners: { idx: 0 | 1 | 2 | 3; x: number; z: number; face: WallFace }[] = [
            { idx: 0, x: 0, z: 0, face: 'front' },
            { idx: 1, x: curRoom.width, z: 0, face: 'front' },
            { idx: 2, x: 0, z: curRoom.length, face: 'rear' },
            { idx: 3, x: curRoom.width, z: curRoom.length, face: 'rear' },
          ];
          let best = corners[0];
          let minD = Infinity;
          for (const c of corners) {
            const d = Math.hypot(rx - c.x, rz - c.z);
            if (d < minD) {
              minD = d;
              best = c;
            }
          }
          const moved = clampPanelToRoom(
            {
              ...targetPanel,
              face: best.face,
              cornerIndex: best.idx,
              center: { ...targetPanel.center, y: Number(ry.toFixed(2)) },
            },
            curRoom
          );
          setStatusText(`移动【${spec.shortName}】→ 墙角 #${best.idx + 1}, 中心高度 Y=${moved.center.y.toFixed(2)}m`);
          updatePanelCb(moved);
        } else {
          const moved = clampPanelToRoom(
            {
              ...targetPanel,
              center: {
                x: Number(rx.toFixed(2)),
                y: Number(ry.toFixed(2)),
                z: Number(rz.toFixed(2)),
              },
            },
            curRoom
          );
          setStatusText(
            `移动【${spec.shortName}】(${WALL_FACE_LABELS[moved.face].split(' ')[0]}) → X=${moved.center.x.toFixed(2)}m, Y=${moved.center.y.toFixed(2)}m, Z=${moved.center.z.toFixed(2)}m`
          );
          updatePanelCb(moved);
        }
      }
    };

    const onPointerUp = (ev: PointerEvent) => {
      if (activeDrag) {
        activeDrag = null;
        controls.enabled = true;
        return;
      }
      const movedPx = Math.hypot(ev.clientX - pointerDownPos.x, ev.clientY - pointerDownPos.y);
      if (movedPx < 4 && ev.button === 0) {
        const cam = sceneRefs.current?.activeCam ?? perspCam;
        updatePointer(ev);
        raycaster.setFromCamera(pointer, cam);
        const hits = raycaster.intersectObjects(panelsGroup.children, true);
        if (hits.length === 0) {
          latestRef.current.onSelectPanel(null);
        }
      }
    };

    const dom = renderer.domElement;
    dom.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);

    const resizeObserver = new ResizeObserver(() => {
      if (!container || !sceneRefs.current) return;
      const w = Math.max(container.clientWidth, 100);
      const h = Math.max(container.clientHeight, 100);
      const asp = w / h;

      perspCam.aspect = asp;
      perspCam.updateProjectionMatrix();

      const halfH = (orthoCam.top - orthoCam.bottom) * 0.5;
      orthoCam.left = -halfH * asp;
      orthoCam.right = halfH * asp;
      orthoCam.updateProjectionMatrix();

      renderer.setSize(w, h);
    });
    resizeObserver.observe(container);

    // 绘制右上角实时同步的 CAD XYZ 三维坐标轴导航仪
    const drawAxisGizmo = (cam: THREE.Camera) => {
      const cvs = axisCanvasRef.current;
      if (!cvs) return;
      const ctx = cvs.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, cvs.width, cvs.height);

      const invQuat = cam.quaternion.clone().invert();
      const axes = [
        { label: 'X宽', vec: new THREE.Vector3(1, 0, 0), color: '#f87171' },
        { label: 'Y高', vec: new THREE.Vector3(0, 1, 0), color: '#34d399' },
        { label: 'Z长', vec: new THREE.Vector3(0, 0, 1), color: '#38bdf8' },
      ].map((a) => {
        const v = a.vec.clone().applyQuaternion(invQuat);
        return { ...a, v };
      });
      // 按深度排序绘制，保证前后遮挡正确
      axes.sort((a, b) => a.v.z - b.v.z);

      const cx = 34;
      const cy = 34;
      const len = 22;

      ctx.beginPath();
      ctx.arc(cx, cy, 30, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(15, 23, 42, 0.78)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.25)';
      ctx.lineWidth = 1;
      ctx.stroke();

      for (const axis of axes) {
        const ex = cx + axis.v.x * len;
        const ey = cy - axis.v.y * len;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(ex, ey);
        ctx.strokeStyle = axis.color;
        ctx.lineWidth = 2.2;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(ex, ey, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = axis.color;
        ctx.fill();

        ctx.font = 'bold 9px sans-serif';
        ctx.fillStyle = axis.color;
        ctx.fillText(axis.label[0], ex + (axis.v.x >= 0 ? 4 : -10), ey + 3);
      }
    };

    let animId = 0;
    const camDir = new THREE.Vector3();
    const camViewVec = new THREE.Vector3();

    const animate = () => {
      animId = requestAnimationFrame(animate);
      controls.update();

      const curRefs = sceneRefs.current;
      if (curRefs) {
        const cam = curRefs.activeCam;
        cam.getWorldDirection(camViewVec);

        for (const wm of curRefs.wallMeshes) {
          const worldPos = new THREE.Vector3();
          wm.mesh.getWorldPosition(worldPos);
          if ((cam as THREE.PerspectiveCamera).isPerspectiveCamera) {
            camDir.subVectors(cam.position, worldPos).normalize();
          } else {
            camDir.copy(camViewVec).negate();
          }
          const facingCameraFromOutside = camDir.dot(wm.inwardNormal) < -0.06;
          const mat = wm.mesh.material as THREE.MeshStandardMaterial;
          const targetOpacity = facingCameraFromOutside ? 0.04 : 0.38;
          mat.opacity += (targetOpacity - mat.opacity) * 0.2;
        }

        drawAxisGizmo(cam);
        renderer.render(scene, cam);
      }
    };
    animate();

    return () => {
      cancelAnimationFrame(animId);
      resizeObserver.disconnect();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      dom.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      controls.dispose();
      renderer.dispose();
    };
  }, []);

  // 构建房间壳体、CAD 0.5m 工程网格与长宽高尺寸标注线
  useEffect(() => {
    const refs = sceneRefs.current;
    if (!refs) return;
    const { rootOffsetGroup, shellGroup } = refs;

    rootOffsetGroup.position.set(-room.width * 0.5, 0, -room.length * 0.5);
    disposeGroup(shellGroup);
    refs.wallMeshes = [];

    const wallMatSpec = BASE_MATERIALS[room.wallMaterial];
    const floorMatSpec = BASE_MATERIALS[room.floorMaterial];
    const ceilMatSpec = BASE_MATERIALS[room.ceilingMaterial];

    // 1. 房间地面
    const floorGeo = new THREE.PlaneGeometry(room.width, room.length);
    const floorMat = new THREE.MeshStandardMaterial({
      color: showBassHeatmap ? '#ffffff' : floorMatSpec.color,
      roughness: 0.8,
      metalness: 0.06,
      map: showBassHeatmap ? makeBassHeatmapTexture(room, heatmapFreqHz) : null,
    });
    const floorMesh = new THREE.Mesh(floorGeo, floorMat);
    floorMesh.rotation.x = -Math.PI * 0.5;
    floorMesh.position.set(room.width * 0.5, 0, room.length * 0.5);
    shellGroup.add(floorMesh);

    // 2. 房间内部 CAD 0.5m 施工刻度网格（辅助精确观察定位）
    const gridPts: THREE.Vector3[] = [];
    for (let x = 0.5; x < room.width - 0.01; x += 0.5) {
      gridPts.push(new THREE.Vector3(x, 0.004, 0), new THREE.Vector3(x, 0.004, room.length));
    }
    for (let z = 0.5; z < room.length - 0.01; z += 0.5) {
      gridPts.push(new THREE.Vector3(0, 0.004, z), new THREE.Vector3(room.width, 0.004, z));
    }
    if (gridPts.length > 0) {
      const innerGrid = new THREE.LineSegments(
        new THREE.BufferGeometry().setFromPoints(gridPts),
        new THREE.LineBasicMaterial({ color: '#cbd5e1', transparent: true, opacity: 0.14 })
      );
      shellGroup.add(innerGrid);
    }

    // 38% 黄金听音位地面参考线
    const sweetZ = room.length * 0.38;
    const sweetLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0.1, 0.008, sweetZ),
        new THREE.Vector3(room.width - 0.1, 0.008, sweetZ),
      ]),
      new THREE.LineBasicMaterial({ color: '#38bdf8', transparent: true, opacity: 0.45 })
    );
    shellGroup.add(sweetLine);

    // 3. CAD 工程尺寸标注标尺 (宽 W / 长 L / 高 H)
    const dimColor = '#64748b';
    // 前沿宽度标尺线
    shellGroup.add(
      new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(0, 0.01, -0.28),
          new THREE.Vector3(room.width, 0.01, -0.28),
        ]),
        new THREE.LineBasicMaterial({ color: dimColor })
      )
    );
    const wSprite = makeTextSprite(`宽 W = ${room.width.toFixed(2)}m`, '#cbd5e1');
    wSprite.position.set(room.width * 0.5, 0.08, -0.35);
    shellGroup.add(wSprite);

    // 侧沿长度标尺线
    shellGroup.add(
      new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(-0.28, 0.01, 0),
          new THREE.Vector3(-0.28, 0.01, room.length),
        ]),
        new THREE.LineBasicMaterial({ color: dimColor })
      )
    );
    const lSprite = makeTextSprite(`长 L = ${room.length.toFixed(2)}m`, '#cbd5e1');
    lSprite.position.set(-0.42, 0.08, room.length * 0.5);
    shellGroup.add(lSprite);

    // 竖向层高标尺
    const hSprite = makeTextSprite(`高 H = ${room.height.toFixed(2)}m`, '#94a3b8');
    hSprite.position.set(-0.38, room.height * 0.5, 0);
    shellGroup.add(hSprite);

    // 4. 边界面墙壁与天花板
    const addBoundaryWall = (
      face: WallFace,
      w: number,
      h: number,
      pos: [number, number, number],
      rot: [number, number, number],
      inwardNormal: [number, number, number],
      hexColor: string
    ) => {
      const geo = new THREE.PlaneGeometry(w, h);
      const mat = new THREE.MeshStandardMaterial({
        color: hexColor,
        transparent: true,
        opacity: 0.35,
        roughness: 0.85,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(...pos);
      mesh.rotation.set(...rot);
      shellGroup.add(mesh);
      refs.wallMeshes.push({
        face,
        inwardNormal: new THREE.Vector3(...inwardNormal),
        mesh,
      });
    };

    addBoundaryWall('front', room.width, room.height, [room.width * 0.5, room.height * 0.5, 0], [0, 0, 0], [0, 0, 1], wallMatSpec.color);
    addBoundaryWall('rear', room.width, room.height, [room.width * 0.5, room.height * 0.5, room.length], [0, Math.PI, 0], [0, 0, -1], wallMatSpec.color);
    addBoundaryWall('left', room.length, room.height, [0, room.height * 0.5, room.length * 0.5], [0, Math.PI * 0.5, 0], [1, 0, 0], wallMatSpec.color);
    addBoundaryWall('right', room.length, room.height, [room.width, room.height * 0.5, room.length * 0.5], [0, -Math.PI * 0.5, 0], [-1, 0, 0], wallMatSpec.color);
    addBoundaryWall('ceiling', room.width, room.length, [room.width * 0.5, room.height, room.length * 0.5], [Math.PI * 0.5, 0, 0], [0, -1, 0], ceilMatSpec.color);

    const boxGeo = new THREE.BoxGeometry(room.width, room.height, room.length);
    const edges = new THREE.EdgesGeometry(boxGeo);
    boxGeo.dispose();
    const wireframe = new THREE.LineSegments(
      edges,
      new THREE.LineBasicMaterial({ color: '#64748b', transparent: true, opacity: 0.9 })
    );
    wireframe.position.set(room.width * 0.5, room.height * 0.5, room.length * 0.5);
    shellGroup.add(wireframe);
  }, [
    room.width,
    room.height,
    room.length,
    room.wallMaterial,
    room.floorMaterial,
    room.ceilingMaterial,
    showBassHeatmap,
    heatmapFreqHz,
  ]);

  // 同步更新音箱、麦克风、真实已放置声学板、反射射线与虚线预览靶位
  useEffect(() => {
    const refs = sceneRefs.current;
    if (!refs) return;
    const { panelsGroup, actorsGroup, raysGroup, hintsGroup } = refs;

    disposeGroup(panelsGroup);
    disposeGroup(actorsGroup);
    disposeGroup(raysGroup);
    disposeGroup(hintsGroup);

    // 1. 音箱模型
    const speakers = getSpeakerPositions(room);
    const listener = room.listenerPos;

    for (const spk of speakers) {
      const spkGroup = new THREE.Group();
      spkGroup.userData = { actorKind: 'speaker' };
      spkGroup.position.set(spk.pos.x, 0, spk.pos.z);

      const standH = Math.max(0.15, spk.pos.y - 0.18);
      const stand = new THREE.Mesh(
        new THREE.CylinderGeometry(0.025, 0.04, standH, 12),
        new THREE.MeshStandardMaterial({ color: '#334155', metalness: 0.6, roughness: 0.4 })
      );
      stand.position.y = standH * 0.5;
      spkGroup.add(stand);

      const basePlate = new THREE.Mesh(
        new THREE.CylinderGeometry(0.16, 0.18, 0.025, 18),
        new THREE.MeshStandardMaterial({ color: '#1e293b' })
      );
      basePlate.position.y = 0.012;
      spkGroup.add(basePlate);

      const cabGroup = new THREE.Group();
      cabGroup.position.y = spk.pos.y;
      cabGroup.rotation.y = Math.atan2(listener.x - spk.pos.x, listener.z - spk.pos.z);

      const cabinet = new THREE.Mesh(
        new THREE.BoxGeometry(0.24, 0.36, 0.28),
        new THREE.MeshStandardMaterial({ color: '#1e293b', roughness: 0.4, metalness: 0.25 })
      );
      cabGroup.add(cabinet);

      const woofer = new THREE.Mesh(
        new THREE.CylinderGeometry(0.075, 0.05, 0.02, 20),
        new THREE.MeshStandardMaterial({ color: '#eab308', roughness: 0.5 })
      );
      woofer.rotation.x = Math.PI * 0.5;
      woofer.position.set(0, -0.05, 0.142);
      cabGroup.add(woofer);

      const tweeter = new THREE.Mesh(
        new THREE.SphereGeometry(0.028, 14, 14),
        new THREE.MeshStandardMaterial({ color: '#94a3b8', metalness: 0.8, roughness: 0.2 })
      );
      tweeter.position.set(0, 0.09, 0.14);
      cabGroup.add(tweeter);

      spkGroup.add(cabGroup);
      actorsGroup.add(spkGroup);
    }

    // 2. 听音位麦克风
    const micGroup = new THREE.Group();
    micGroup.userData = { actorKind: 'listener' };
    micGroup.position.set(listener.x, 0, listener.z);

    const halo = new THREE.Mesh(
      new THREE.RingGeometry(0.22, 0.28, 32),
      new THREE.MeshBasicMaterial({ color: '#38bdf8', side: THREE.DoubleSide, transparent: true, opacity: 0.8 })
    );
    halo.rotation.x = -Math.PI * 0.5;
    halo.position.y = 0.008;
    micGroup.add(halo);

    const micPole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.018, 0.025, listener.y, 12),
      new THREE.MeshStandardMaterial({ color: '#64748b', metalness: 0.5 })
    );
    micPole.position.y = listener.y * 0.5;
    micGroup.add(micPole);

    const headSphere = new THREE.Mesh(
      new THREE.SphereGeometry(0.11, 22, 22),
      new THREE.MeshStandardMaterial({
        color: '#38bdf8',
        emissive: '#0284c7',
        emissiveIntensity: 0.35,
        roughness: 0.3,
      })
    );
    headSphere.position.y = listener.y;
    micGroup.add(headSphere);

    const micCapsule = new THREE.Mesh(
      new THREE.CylinderGeometry(0.012, 0.012, 0.18, 10),
      new THREE.MeshStandardMaterial({ color: '#f8fafc', metalness: 0.85, roughness: 0.2 })
    );
    micCapsule.rotation.x = Math.PI * 0.5;
    micCapsule.position.set(0, listener.y, -0.14);
    micGroup.add(micCapsule);
    actorsGroup.add(micGroup);

    // 3. 真实已放置的声学材料实体模型 (panels)
    for (const panel of panels) {
      const spec = TREATMENT_CATALOG[panel.productId];
      const isSelected = panel.id === selectedPanelId;
      const pGroup = new THREE.Group();
      pGroup.userData = { panelId: panel.id };

      if (spec.cornerSnap) {
        const trapGeo = buildInteriorCornerPrismGeometry(
          panel.cornerIndex ?? 0,
          panel.width,
          panel.height,
          panel.center.y,
          room.width,
          room.height,
          room.length
        );

        const trapMesh = new THREE.Mesh(
          trapGeo,
          new THREE.MeshStandardMaterial({
            color: spec.color,
            roughness: 0.88,
            emissive: isSelected ? '#ffffff' : '#000000',
            emissiveIntensity: isSelected ? 0.25 : 0,
          })
        );
        pGroup.add(trapMesh);

        pGroup.add(
          new THREE.LineSegments(
            new THREE.EdgesGeometry(trapGeo),
            new THREE.LineBasicMaterial({ color: isSelected ? '#ffffff' : spec.accentColor })
          )
        );
      } else {
        const depth = panel.thickness;
        const bodyGeo = new THREE.BoxGeometry(panel.width, panel.height, depth);
        const bodyMat = new THREE.MeshStandardMaterial({
          color: spec.color,
          roughness: panel.productId === 'soundproof_board' ? 0.45 : 0.85,
          metalness: panel.productId === 'soundproof_board' ? 0.25 : 0.05,
          emissive: isSelected ? '#ffffff' : '#000000',
          emissiveIntensity: isSelected ? 0.26 : 0,
        });
        pGroup.add(new THREE.Mesh(bodyGeo, bodyMat));

        if (panel.productId === 'diffuser_qrd') {
          const wellDepths = [0.3, 0.85, 0.5, 0.15, 0.9, 0.4, 0.7];
          const slatW = (panel.width * 0.88) / wellDepths.length;
          for (let i = 0; i < wellDepths.length; i++) {
            const slat = new THREE.Mesh(
              new THREE.BoxGeometry(slatW * 0.72, panel.height * 0.9, depth * wellDepths[i] * 0.6),
              new THREE.MeshStandardMaterial({ color: '#0e7490', roughness: 0.5 })
            );
            slat.position.set(-panel.width * 0.44 + (i + 0.5) * slatW, 0, depth * 0.45);
            pGroup.add(slat);
          }
        }

        pGroup.add(
          new THREE.LineSegments(
            new THREE.EdgesGeometry(bodyGeo),
            new THREE.LineBasicMaterial({ color: isSelected ? '#ffffff' : spec.accentColor })
          )
        );

        const offset = depth * 0.5 + 0.006;
        switch (panel.face) {
          case 'front':
            pGroup.position.set(panel.center.x, panel.center.y, offset);
            break;
          case 'rear':
            pGroup.position.set(panel.center.x, panel.center.y, room.length - offset);
            pGroup.rotation.set(0, Math.PI, 0);
            break;
          case 'left':
            pGroup.position.set(offset, panel.center.y, panel.center.z);
            pGroup.rotation.set(0, Math.PI * 0.5, 0);
            break;
          case 'right':
            pGroup.position.set(room.width - offset, panel.center.y, panel.center.z);
            pGroup.rotation.set(0, -Math.PI * 0.5, 0);
            break;
          case 'ceiling':
            pGroup.position.set(panel.center.x, room.height - offset, panel.center.z);
            pGroup.rotation.set(Math.PI * 0.5, 0, 0);
            break;
          case 'floor':
            pGroup.position.set(panel.center.x, offset, panel.center.z);
            pGroup.rotation.set(-Math.PI * 0.5, 0, 0);
            break;
        }
      }
      panelsGroup.add(pGroup);
    }

    // 4. 一阶镜像反射射线
    if (showRays) {
      for (const spk of speakers) {
        raysGroup.add(
          new THREE.Line(
            new THREE.BufferGeometry().setFromPoints([
              new THREE.Vector3(spk.pos.x, spk.pos.y, spk.pos.z),
              new THREE.Vector3(listener.x, listener.y, listener.z),
            ]),
            new THREE.LineBasicMaterial({ color: '#f8fafc', transparent: true, opacity: 0.7 })
          )
        );
      }

      for (const ray of reflections) {
        if (!showFloorRays && ray.face === 'floor') continue;

        let rayHex = '#ef4444';
        let rayOpacity = 0.85;
        if (ray.status === 'absorbed') {
          rayHex = '#10b981';
          rayOpacity = 0.68;
        } else if (ray.status === 'diffused') {
          rayHex = '#22d3ee';
          rayOpacity = 0.78;
        } else if (ray.status === 'soft_surface') {
          rayHex = '#94a3b8';
          rayOpacity = 0.35;
        }

        const pSrc = new THREE.Vector3(ray.sourcePos.x, ray.sourcePos.y, ray.sourcePos.z);
        const pHit = new THREE.Vector3(ray.hitPoint.x, ray.hitPoint.y, ray.hitPoint.z);
        const pMic = new THREE.Vector3(ray.listenerPos.x, ray.listenerPos.y, ray.listenerPos.z);

        raysGroup.add(
          new THREE.Line(
            new THREE.BufferGeometry().setFromPoints([pSrc, pHit]),
            new THREE.LineBasicMaterial({ color: rayHex, transparent: true, opacity: rayOpacity })
          )
        );

        if (ray.status === 'diffused') {
          raysGroup.add(
            new THREE.Line(
              new THREE.BufferGeometry().setFromPoints([pHit, pMic]),
              new THREE.LineBasicMaterial({ color: rayHex, transparent: true, opacity: 0.4 })
            )
          );
          const dir = new THREE.Vector3().subVectors(pMic, pHit).normalize();
          const offsets = [
            new THREE.Vector3(0.28, 0.18, 0.12),
            new THREE.Vector3(-0.28, 0.2, -0.1),
            new THREE.Vector3(0.15, -0.22, 0.25),
            new THREE.Vector3(-0.2, -0.18, -0.22),
          ];
          for (const off of offsets) {
            const scatterEnd = pHit.clone().add(dir.clone().add(off).normalize().multiplyScalar(0.65));
            raysGroup.add(
              new THREE.Line(
                new THREE.BufferGeometry().setFromPoints([pHit, scatterEnd]),
                new THREE.LineBasicMaterial({ color: '#22d3ee', transparent: true, opacity: 0.65 })
              )
            );
          }
        } else {
          raysGroup.add(
            new THREE.Line(
              new THREE.BufferGeometry().setFromPoints([pHit, pMic]),
              new THREE.LineBasicMaterial({ color: rayHex, transparent: true, opacity: rayOpacity })
            )
          );
        }

        const dot = new THREE.Mesh(
          new THREE.SphereGeometry(ray.status === 'raw' ? 0.052 : 0.038, 12, 12),
          new THREE.MeshBasicMaterial({ color: rayHex })
        );
        dot.position.copy(pHit);
        raysGroup.add(dot);
      }
    }

    // 5. 纯空心虚线 CAD 推荐参考框（仅在开启「显示建议虚线」或鼠标悬停某条建议时显示，绝不与真实材料混淆！）
    const visibleHints = recommendations.filter(
      (h) => showHints || h.id === hoveredHintId
    );

    for (const hint of visibleHints) {
      const spec = TREATMENT_CATALOG[hint.productId];
      const isHovered = hint.id === hoveredHintId;

      if (spec.cornerSnap && hint.cornerIndex !== undefined) {
        const geo = buildInteriorCornerPrismGeometry(
          hint.cornerIndex,
          hint.width,
          hint.height,
          hint.center.y,
          room.width,
          room.height,
          room.length
        );
        const edges = new THREE.EdgesGeometry(geo);
        geo.dispose();

        const dashed = new THREE.LineSegments(
          edges,
          new THREE.LineDashedMaterial({
            color: isHovered ? '#ffffff' : spec.accentColor,
            dashSize: 0.1,
            gapSize: 0.07,
            transparent: true,
            opacity: isHovered ? 1.0 : 0.72,
          })
        );
        dashed.computeLineDistances();
        hintsGroup.add(dashed);
      } else {
        const boxGeo = new THREE.BoxGeometry(hint.width, hint.height, 0.02);
        const edges = new THREE.EdgesGeometry(boxGeo);
        boxGeo.dispose();

        const dashed = new THREE.LineSegments(
          edges,
          new THREE.LineDashedMaterial({
            color: isHovered ? '#ffffff' : spec.accentColor,
            dashSize: 0.1,
            gapSize: 0.07,
            transparent: true,
            opacity: isHovered ? 1.0 : 0.75,
          })
        );
        dashed.computeLineDistances();

        const c = hint.center;
        switch (hint.face) {
          case 'left':
            dashed.position.set(0.015, c.y, c.z);
            dashed.rotation.set(0, Math.PI * 0.5, 0);
            break;
          case 'right':
            dashed.position.set(room.width - 0.015, c.y, c.z);
            dashed.rotation.set(0, -Math.PI * 0.5, 0);
            break;
          case 'front':
            dashed.position.set(c.x, c.y, 0.015);
            break;
          case 'rear':
            dashed.position.set(c.x, c.y, room.length - 0.015);
            dashed.rotation.set(0, Math.PI, 0);
            break;
          case 'ceiling':
            dashed.position.set(c.x, room.height - 0.015, c.z);
            dashed.rotation.set(Math.PI * 0.5, 0, 0);
            break;
          case 'floor':
            dashed.position.set(c.x, 0.015, c.z);
            dashed.rotation.set(-Math.PI * 0.5, 0, 0);
            break;
        }
        hintsGroup.add(dashed);
      }
    }
  }, [
    room,
    panels,
    selectedPanelId,
    reflections,
    recommendations,
    hoveredHintId,
    showRays,
    showFloorRays,
    showHints,
  ]);

  // CAD 标准工程视图对齐与自适应满屏居中 (Fit View)
  const applyCadView = (view: 'iso' | 'top' | 'front' | 'left' | 'fit') => {
    const refs = sceneRefs.current;
    const container = containerRef.current;
    if (!refs || !container) return;

    const { perspCam, orthoCam, controls } = refs;
    const span = Math.max(room.width, room.length, room.height * 1.4);
    const cy = room.height * 0.45;
    controls.target.set(0, view === 'top' ? 0 : cy, 0);

    let targetPos = new THREE.Vector3(span * 1.15, span * 0.88, span * 1.18);
    if (view === 'top') {
      targetPos = new THREE.Vector3(0, span * 1.65, 0.001);
    } else if (view === 'front') {
      targetPos = new THREE.Vector3(0, cy, span * 1.55);
    } else if (view === 'left') {
      targetPos = new THREE.Vector3(-span * 1.55, cy, 0);
    } else if (view === 'fit') {
      // 保持当前观察方向，仅自动缩放距离将整个房间居中框入画布！
      const dir = refs.activeCam.position.clone().sub(controls.target).normalize();
      if (dir.lengthSq() < 0.01) dir.set(1, 0.8, 1).normalize();
      targetPos = controls.target.clone().add(dir.multiplyScalar(span * 1.45));
    }

    perspCam.position.copy(targetPos);
    orthoCam.position.copy(targetPos);

    // 同步调整正交视锥大小以确保大房间及顶部标尺留白充裕不被裁切
    const aspect = Math.max(container.clientWidth, 100) / Math.max(container.clientHeight, 100);
    const halfH = span * 0.86;
    orthoCam.left = -halfH * aspect;
    orthoCam.right = halfH * aspect;
    orthoCam.top = halfH;
    orthoCam.bottom = -halfH;
    orthoCam.zoom = 1;
    orthoCam.updateProjectionMatrix();

    controls.update();
  };

  const zoomStep = (factor: number) => {
    const refs = sceneRefs.current;
    if (!refs) return;
    const { activeCam, orthoCam, controls } = refs;
    if ((activeCam as THREE.OrthographicCamera).isOrthographicCamera) {
      orthoCam.zoom = Math.max(0.3, Math.min(5.0, orthoCam.zoom * factor));
      orthoCam.updateProjectionMatrix();
    } else {
      const offset = activeCam.position.clone().sub(controls.target);
      offset.multiplyScalar(1 / factor);
      offset.clampLength(1.4, 26);
      activeCam.position.copy(controls.target).add(offset);
    }
    controls.update();
  };

  return (
    <div className="viewport-wrapper">
      <div ref={containerRef} className="viewport-canvas" />

      {/* 左上角紧凑单排 CAD 导航控制条 */}
      <div className="cad-floating-bar">
        <div className="cad-seg" title="切换鼠标左键操作模式">
          <button
            type="button"
            className={toolMode === 'smart' ? 'active' : ''}
            onClick={() => setToolMode('smart')}
          >
            ✥ 选取/移位
          </button>
          <button
            type="button"
            className={toolMode === 'orbit' ? 'active' : ''}
            onClick={() => setToolMode('orbit')}
          >
            ↻ 旋转
          </button>
          <button
            type="button"
            className={toolMode === 'pan' ? 'active' : ''}
            onClick={() => setToolMode('pan')}
          >
            ✋ 拖动画布
          </button>
        </div>

        <div className="cad-seg">
          <button
            type="button"
            className={cameraMode === 'persp' ? 'active' : ''}
            onClick={() => setCameraMode('persp')}
          >
            3D透视
          </button>
          <button
            type="button"
            className={cameraMode === 'ortho' ? 'active' : ''}
            onClick={() => setCameraMode('ortho')}
            title="无透视变形的标准工程正交投影"
          >
            正交CAD
          </button>
        </div>

        <div className="cad-seg">
          <button type="button" onClick={() => applyCadView('iso')}>轴测</button>
          <button type="button" onClick={() => applyCadView('top')}>顶视</button>
          <button type="button" onClick={() => applyCadView('front')}>前视</button>
          <button type="button" onClick={() => applyCadView('left')}>侧视</button>
          <button type="button" onClick={() => applyCadView('fit')} title="一键将房间缩放到窗口正中">
            居中适配
          </button>
        </div>

        <div className="cad-seg">
          <button type="button" onClick={() => zoomStep(1.22)} title="放大">+</button>
          <button type="button" onClick={() => zoomStep(0.82)} title="缩小">−</button>
          <button
            type="button"
            className={gridSnap ? 'active' : ''}
            onClick={() => setGridSnap((s) => !s)}
            title="5cm 工程模数吸附开关"
          >
            吸附5cm
          </button>
          <button
            type="button"
            className={isExpanded ? 'active' : ''}
            onClick={onToggleExpand}
            title="折叠两侧面板，大屏操作 CAD 视图"
          >
            {isExpanded ? '退出全宽' : '全宽大屏'}
          </button>
        </div>
      </div>

      {/* 右上角实时同步旋转的 CAD XYZ 坐标轴指示器 */}
      <canvas
        ref={axisCanvasRef}
        width={68}
        height={68}
        className="cad-axis-gizmo"
        onClick={() => applyCadView('fit')}
        title="X红(宽) · Y绿(高) · Z蓝(长) — 点击居中回正"
      />

      {/* 底部单行清爽 CAD 状态与图例栏 */}
      <div className="cad-statusbar">
        <span className="cad-status-msg">{statusText}</span>
        <div className="cad-legend-inline">
          <span><i style={{ background: '#ef4444' }} />强反射</span>
          <span><i style={{ background: '#10b981' }} />已吸音</span>
          <span><i style={{ background: '#22d3ee' }} />已扩散</span>
          {showBassHeatmap && <b className="heat-tag">热力图 {heatmapFreqHz}Hz</b>}
        </div>
      </div>
    </div>
  );
};
