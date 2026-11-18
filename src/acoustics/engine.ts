import { BASE_MATERIALS, TARGET_GOALS, TREATMENT_CATALOG, WALL_FACE_LABELS } from './materials';
import {
  BandArray,
  FreqResponseSample,
  OCTAVE_BANDS,
  PlacedPanel,
  RecommendedHint,
  ReflectionRay,
  ReflectionStatus,
  RoomConfig,
  RoomModePoint,
  SimulationResult,
  TargetGoalId,
  Vec3,
  WallFace,
} from './types';

const SPEED_OF_SOUND = 343.0;
const AIR_ABSORPTION_M: BandArray = [0.0001, 0.0003, 0.0006, 0.001, 0.0024, 0.006];

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function dist3(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * 计算低频陷阱在任意坐标 p 处的驻波声压加权效率（与 cpp_core/acoustic_engine.cpp 对齐）
 * 墙角三面交汇处 > 两墙交界棱角 > 单面墙中心 > 房间中央
 */
export function computeCornerPressureWeight(p: Vec3, room: RoomConfig): number {
  const prox = (coord: number, span: number) => {
    const d = Math.min(coord, span - coord);
    return Math.exp(-d / 0.55);
  };
  const score = prox(p.x, room.width) + prox(p.y, room.height) + prox(p.z, room.length);
  return clamp(0.38 + 0.36 * score, 0.4, 1.35);
}

/**
 * 确保当房间尺寸缩放或用户拖拽时，声学板始终贴合在对应墙面合法范围内
 */
export function clampPanelToRoom(panel: PlacedPanel, room: RoomConfig): PlacedPanel {
  const spec = TREATMENT_CATALOG[panel.productId];
  const halfW = panel.width * 0.5;
  const halfH = panel.height * 0.5;

  if (spec.cornerSnap && panel.cornerIndex !== undefined) {
    const offset = panel.width * 0.42;
    const y = clamp(panel.center.y, halfH, Math.max(halfH, room.height - halfH));
    const corners: [Vec3, Vec3, Vec3, Vec3] = [
      { x: offset, y, z: offset },
      { x: room.width - offset, y, z: offset },
      { x: offset, y, z: room.length - offset },
      { x: room.width - offset, y, z: room.length - offset },
    ];
    return {
      ...panel,
      center: corners[panel.cornerIndex],
    };
  }

  const c = { ...panel.center };
  switch (panel.face) {
    case 'left':
      c.x = 0;
      c.z = clamp(c.z, halfW, Math.max(halfW, room.length - halfW));
      c.y = clamp(c.y, halfH, Math.max(halfH, room.height - halfH));
      break;
    case 'right':
      c.x = room.width;
      c.z = clamp(c.z, halfW, Math.max(halfW, room.length - halfW));
      c.y = clamp(c.y, halfH, Math.max(halfH, room.height - halfH));
      break;
    case 'front':
      c.z = 0;
      c.x = clamp(c.x, halfW, Math.max(halfW, room.width - halfW));
      c.y = clamp(c.y, halfH, Math.max(halfH, room.height - halfH));
      break;
    case 'rear':
      c.z = room.length;
      c.x = clamp(c.x, halfW, Math.max(halfW, room.width - halfW));
      c.y = clamp(c.y, halfH, Math.max(halfH, room.height - halfH));
      break;
    case 'ceiling':
      c.y = room.height;
      c.x = clamp(c.x, halfW, Math.max(halfW, room.width - halfW));
      c.z = clamp(c.z, halfH, Math.max(halfH, room.length - halfH));
      break;
    case 'floor':
      c.y = 0;
      c.x = clamp(c.x, halfW, Math.max(halfW, room.width - halfW));
      c.z = clamp(c.z, halfH, Math.max(halfH, room.length - halfH));
      break;
  }

  return { ...panel, center: c };
}

function isHitOnPanel(face: WallFace, hit: Vec3, panel: PlacedPanel): boolean {
  const spec = TREATMENT_CATALOG[panel.productId];
  // 角落三棱柱低频陷阱同时覆盖相邻两面墙的边角区域
  if (spec.cornerSnap) {
    const horizDist = Math.hypot(hit.x - panel.center.x, hit.z - panel.center.z);
    const vertDist = Math.abs(hit.y - panel.center.y);
    return horizDist <= panel.width * 0.85 && vertDist <= panel.height * 0.52;
  }

  if (panel.face !== face) return false;
  const halfW = panel.width * 0.5 + 0.03; // 考虑声波菲涅尔边缘衍射微区
  const halfH = panel.height * 0.5 + 0.03;

  switch (face) {
    case 'left':
    case 'right':
      return Math.abs(hit.z - panel.center.z) <= halfW && Math.abs(hit.y - panel.center.y) <= halfH;
    case 'front':
    case 'rear':
      return Math.abs(hit.x - panel.center.x) <= halfW && Math.abs(hit.y - panel.center.y) <= halfH;
    case 'ceiling':
    case 'floor':
      return Math.abs(hit.x - panel.center.x) <= halfW && Math.abs(hit.z - panel.center.z) <= halfH;
  }
}

export function getSpeakerPositions(room: RoomConfig): { label: string; pos: Vec3 }[] {
  const base: Vec3 = {
    x: clamp(room.speakerPos.x, 0.25, room.width - 0.25),
    y: clamp(room.speakerPos.y, 0.3, room.height - 0.25),
    z: clamp(room.speakerPos.z, 0.2, room.length - 0.3),
  };

  if (room.speakerMode === 'mono') {
    return [{ label: '主发声源', pos: base }];
  }

  const halfSpan = Math.min(room.stereoSpan * 0.5, room.width * 0.42);
  return [
    {
      label: '左音箱 L',
      pos: { x: clamp(base.x - halfSpan, 0.25, room.width - 0.25), y: base.y, z: base.z },
    },
    {
      label: '右音箱 R',
      pos: { x: clamp(base.x + halfSpan, 0.25, room.width - 0.25), y: base.y, z: base.z },
    },
  ];
}

function computeEyringRT60(room: RoomConfig, panels: PlacedPanel[]): BandArray {
  const volume = room.width * room.height * room.length;
  const areaLR = 2 * (room.length * room.height);
  const areaFR = 2 * (room.width * room.height);
  const areaFloor = room.width * room.length;
  const areaCeil = room.width * room.length;
  const totalSurface = areaLR + areaFR + areaFloor + areaCeil;

  const wallMat = BASE_MATERIALS[room.wallMaterial];
  const floorMat = BASE_MATERIALS[room.floorMaterial];
  const ceilMat = BASE_MATERIALS[room.ceilingMaterial];

  const out: number[] = [];

  for (let b = 0; b < 6; b++) {
    let eqArea =
      (areaLR + areaFR) * wallMat.alpha[b] +
      areaFloor * floorMat.alpha[b] +
      areaCeil * ceilMat.alpha[b];

    for (const panel of panels) {
      const spec = TREATMENT_CATALOG[panel.productId];
      const panelArea = panel.width * panel.height;
      let posWeight = 1.0;

      if (spec.category === 'bass_trap' && b <= 1) {
        posWeight = computeCornerPressureWeight(panel.center, room);
      }

      let baseAlpha = wallMat.alpha[b];
      if (panel.face === 'floor') baseAlpha = floorMat.alpha[b];
      if (panel.face === 'ceiling') baseAlpha = ceilMat.alpha[b];

      const exposedFactor = spec.category === 'bass_trap' ? 1.45 : 1.0;
      const netDelta = panelArea * exposedFactor * spec.alpha[b] * posWeight - panelArea * baseAlpha;
      eqArea += netDelta;
    }

    const avgAlpha = clamp(eqArea / totalSurface, 0.015, 0.92);
    const denom = -totalSurface * Math.log(1 - avgAlpha) + 4 * AIR_ABSORPTION_M[b] * volume;
    out.push((0.161 * volume) / Math.max(denom, 0.05));
  }

  return out as BandArray;
}

function computeMirrorHit(face: WallFace, src: Vec3, dst: Vec3, room: RoomConfig): { imgSrc: Vec3; hit: Vec3 } {
  let imgSrc: Vec3;
  switch (face) {
    case 'left':
      imgSrc = { x: -src.x, y: src.y, z: src.z };
      break;
    case 'right':
      imgSrc = { x: 2 * room.width - src.x, y: src.y, z: src.z };
      break;
    case 'floor':
      imgSrc = { x: src.x, y: -src.y, z: src.z };
      break;
    case 'ceiling':
      imgSrc = { x: src.x, y: 2 * room.height - src.y, z: src.z };
      break;
    case 'front':
      imgSrc = { x: src.x, y: src.y, z: -src.z };
      break;
    case 'rear':
      imgSrc = { x: src.x, y: src.y, z: 2 * room.length - src.z };
      break;
  }

  const dx = dst.x - imgSrc.x;
  const dy = dst.y - imgSrc.y;
  const dz = dst.z - imgSrc.z;
  let t = 0.5;

  switch (face) {
    case 'left':
      t = Math.abs(dx) > 1e-6 ? (0 - imgSrc.x) / dx : 0.5;
      break;
    case 'right':
      t = Math.abs(dx) > 1e-6 ? (room.width - imgSrc.x) / dx : 0.5;
      break;
    case 'floor':
      t = Math.abs(dy) > 1e-6 ? (0 - imgSrc.y) / dy : 0.5;
      break;
    case 'ceiling':
      t = Math.abs(dy) > 1e-6 ? (room.height - imgSrc.y) / dy : 0.5;
      break;
    case 'front':
      t = Math.abs(dz) > 1e-6 ? (0 - imgSrc.z) / dz : 0.5;
      break;
    case 'rear':
      t = Math.abs(dz) > 1e-6 ? (room.length - imgSrc.z) / dz : 0.5;
      break;
  }

  return {
    imgSrc,
    hit: {
      x: clamp(imgSrc.x + dx * t, 0, room.width),
      y: clamp(imgSrc.y + dy * t, 0, room.height),
      z: clamp(imgSrc.z + dz * t, 0, room.length),
    },
  };
}

function traceReflections(room: RoomConfig, panels: PlacedPanel[]): ReflectionRay[] {
  const speakers = getSpeakerPositions(room);
  const listener: Vec3 = {
    x: clamp(room.listenerPos.x, 0.2, room.width - 0.2),
    y: clamp(room.listenerPos.y, 0.3, room.height - 0.2),
    z: clamp(room.listenerPos.z, 0.2, room.length - 0.2),
  };

  const faces: WallFace[] = ['left', 'right', 'ceiling', 'floor', 'front', 'rear'];
  const wallMat = BASE_MATERIALS[room.wallMaterial];
  const floorMat = BASE_MATERIALS[room.floorMaterial];
  const ceilMat = BASE_MATERIALS[room.ceilingMaterial];

  const rays: ReflectionRay[] = [];

  for (const spk of speakers) {
    const directDist = Math.max(dist3(spk.pos, listener), 0.15);

    for (const face of faces) {
      const { imgSrc, hit } = computeMirrorHit(face, spk.pos, listener, room);
      const reflDist = Math.max(dist3(imgSrc, listener), directDist + 0.01);
      const delayMs = ((reflDist - directDist) / SPEED_OF_SOUND) * 1000;

      let baseMat = wallMat;
      if (face === 'floor') baseMat = floorMat;
      if (face === 'ceiling') baseMat = ceilMat;

      const baseAlphaMid = (baseMat.alpha[2] + baseMat.alpha[3] + baseMat.alpha[4]) / 3;
      const distGainDb = 20 * Math.log10(directDist / reflDist);
      const rawSpecEnergy = Math.max(1 - baseAlphaMid, 0.04);
      const rawGainDb = distGainDb + 10 * Math.log10(rawSpecEnergy);

      let activeAlphaMid = baseAlphaMid;
      let activeScatterMid = 0.04;
      let status: ReflectionStatus = baseAlphaMid > 0.45 ? 'soft_surface' : 'raw';
      let hitPanelId: string | undefined;
      let hitProductName: string | undefined;

      for (const panel of panels) {
        if (isHitOnPanel(face, hit, panel)) {
          const spec = TREATMENT_CATALOG[panel.productId];
          activeAlphaMid = (spec.alpha[2] + spec.alpha[3] + spec.alpha[4]) / 3;
          activeScatterMid = (spec.scatter[2] + spec.scatter[3] + spec.scatter[4]) / 3;
          hitPanelId = panel.id;
          hitProductName = spec.shortName;

          if (spec.category === 'absorber' || spec.category === 'bass_trap') {
            status = 'absorbed';
          } else if (spec.category === 'diffuser') {
            status = 'diffused';
          } else {
            // 隔音板表面坚硬，镜面反射依旧很强！
            status = 'raw';
          }
        }
      }

      const treatedSpecEnergy = Math.max((1 - activeAlphaMid) * (1 - activeScatterMid * 0.78), 0.015);
      const gainDb = distGainDb + 10 * Math.log10(treatedSpecEnergy);

      rays.push({
        id: `${spk.label}-${face}`,
        speakerLabel: spk.label,
        face,
        faceLabel: WALL_FACE_LABELS[face],
        sourcePos: spk.pos,
        hitPoint: hit,
        listenerPos: listener,
        distanceMeters: reflDist,
        delayMs,
        gainDb,
        rawGainDb,
        status,
        hitPanelId,
        hitProductName,
      });
    }
  }

  return rays;
}

function solveModesAndResponse(
  room: RoomConfig,
  rt60Untreated: BandArray,
  rt60Treated: BandArray,
  reflections: ReflectionRay[]
): { modes: RoomModePoint[]; freqResponse: FreqResponseSample[] } {
  const speakers = getSpeakerPositions(room);
  const listener = room.listenerPos;

  interface InternalMode {
    nx: number;
    ny: number;
    nz: number;
    type: 'axial' | 'tangential' | 'oblique';
    axisLabel: string;
    freqHz: number;
    coupling: number; // 带正负相位的模态空间耦合因子
  }

  const rawModes: InternalMode[] = [];

  for (let nx = 0; nx <= 5; nx++) {
    for (let ny = 0; ny <= 4; ny++) {
      for (let nz = 0; nz <= 5; nz++) {
        if (nx === 0 && ny === 0 && nz === 0) continue;
        const fx = nx / room.width;
        const fy = ny / room.height;
        const fz = nz / room.length;
        const freqHz = 0.5 * SPEED_OF_SOUND * Math.sqrt(fx * fx + fy * fy + fz * fz);
        if (freqHz > 260) continue;

        const nonZero = (nx > 0 ? 1 : 0) + (ny > 0 ? 1 : 0) + (nz > 0 ? 1 : 0);
        const type = nonZero === 1 ? 'axial' : nonZero === 2 ? 'tangential' : 'oblique';
        // 轴向驻波能量比切向高约 3dB，比斜向高约 6dB
        const modeWeight = nonZero === 1 ? 1.0 : nonZero === 2 ? 0.65 : 0.42;

        const phiMic =
          Math.cos((nx * Math.PI * listener.x) / room.width) *
          Math.cos((ny * Math.PI * listener.y) / room.height) *
          Math.cos((nz * Math.PI * listener.z) / room.length);

        let phiSpkAvg = 0;
        for (const spk of speakers) {
          phiSpkAvg +=
            Math.cos((nx * Math.PI * spk.pos.x) / room.width) *
            Math.cos((ny * Math.PI * spk.pos.y) / room.height) *
            Math.cos((nz * Math.PI * spk.pos.z) / room.length);
        }
        phiSpkAvg /= speakers.length;

        const axisParts: string[] = [];
        if (nx > 0) axisParts.push(`宽X${nx}`);
        if (ny > 0) axisParts.push(`高Y${ny}`);
        if (nz > 0) axisParts.push(`长Z${nz}`);

        rawModes.push({
          nx,
          ny,
          nz,
          type,
          axisLabel: `${nx}-${ny}-${nz} (${axisParts.join('·')})`,
          freqHz,
          coupling: phiSpkAvg * phiMic * modeWeight,
        });
      }
    }
  }

  rawModes.sort((a, b) => a.freqHz - b.freqHz);

  const interpLowRT60 = (f: number, rt: BandArray) => {
    if (f <= 125) return rt[0];
    if (f <= 250) {
      const t = (f - 125) / 125;
      return rt[0] * (1 - t) + rt[1] * t;
    }
    const t = clamp((f - 250) / 250, 0, 1);
    return rt[1] * (1 - t) + rt[2] * t;
  };

  // 输出最具代表性的前 18 个低频简正驻波（供驻波列表和3D可视化展示）
  const modes: RoomModePoint[] = rawModes
    .filter((m) => m.type === 'axial' || Math.abs(m.coupling) > 0.25)
    .slice(0, 18)
    .map((m) => {
      const rtRaw = interpLowRT60(m.freqHz, rt60Untreated);
      const rtTr = interpLowRT60(m.freqHz, rt60Treated);
      const qRaw = clamp(rtRaw * 1.4, 0.5, 2.2);
      const qTr = clamp(rtTr * 1.4, 0.35, 2.2);
      return {
        nx: m.nx,
        ny: m.ny,
        nz: m.nz,
        type: m.type,
        axisLabel: m.axisLabel,
        freqHz: m.freqHz,
        untreatedDb: Math.abs(m.coupling) * 10.5 * qRaw,
        treatedDb: Math.abs(m.coupling) * 10.5 * qTr,
      };
    });

  // 计算 30Hz ~ 500Hz 听音位频响曲线（格林函数模态叠加 + 一阶边界反射梳状干涉 SBIR）
  const numSamples = 96;
  const fMin = 30;
  const fMax = 500;
  const freqResponse: FreqResponseSample[] = [];

  const evalModalAndSbir = (f: number, rtArr: BandArray, useTreatedRays: boolean): number => {
    const omega = 2 * Math.PI * f;
    let reModal = 0;
    let imModal = 0;

    for (const m of rawModes) {
      const wm = 2 * Math.PI * m.freqHz;
      const rt = Math.max(interpLowRT60(m.freqHz, rtArr), 0.12);
      // 阻尼比 zeta = 2.2 / (f * RT60) 的物理缩放
      const zeta = clamp(1.35 / (m.freqHz * rt), 0.018, 0.28);
      const a = wm * wm - omega * omega;
      const b = 2 * zeta * wm * omega;
      const denom = a * a + b * b + 1e-6;
      const scale = m.coupling * wm * wm;
      reModal += (scale * a) / denom;
      imModal -= (scale * b) / denom;
    }

    // 边界干涉 SBIR + 早期梳状滤波分量
    let reRay = 1.0; // 归一化直达声 1∠0
    let imRay = 0.0;
    for (const r of reflections) {
      const db = useTreatedRays ? r.gainDb : r.rawGainDb;
      const amp = Math.pow(10, db / 20) * (1 / Math.sqrt(speakers.length));
      const phase = -2 * Math.PI * f * (r.delayMs / 1000);
      reRay += amp * Math.cos(phase);
      imRay += amp * Math.sin(phase);
    }

    const magModalDb = 10 * Math.log10(Math.max(reModal * reModal + imModal * imModal, 0.03)) - 11.0;
    const magRayDb = 10 * Math.log10(Math.max(reRay * reRay + imRay * imRay, 0.06));

    // 在 140Hz ~ 240Hz（施罗德过渡带）将低频驻波区平滑交叉过渡到几何干涉区
    const blend = clamp((f - 135) / 105, 0, 1);
    const combined = magModalDb * (1 - blend) + magRayDb * blend;
    return clamp(combined, -16, 16);
  };

  for (let i = 0; i < numSamples; i++) {
    const t = i / (numSamples - 1);
    const freqHz = fMin * Math.pow(fMax / fMin, t);
    freqResponse.push({
      freqHz,
      untreatedSplDb: evalModalAndSbir(freqHz, rt60Untreated, false),
      treatedSplDb: evalModalAndSbir(freqHz, rt60Treated, true),
    });
  }

  return { modes, freqResponse };
}

function calcClarityC50(rt60Mid: number, reflections: ReflectionRay[], treated: boolean): number {
  let early = 1.0;
  for (const r of reflections) {
    const db = treated ? r.gainDb : r.rawGainDb;
    // 被吸音板吸收的早期强反射减少了梳状滤波染色，同时如果混响尾音短则清晰度大幅提升
    if (r.delayMs <= 50) {
      early += Math.pow(10, db / 10) * 0.45;
    }
  }
  const late = Math.max(2.4 * Math.exp(-0.69 / Math.max(rt60Mid, 0.08)), 0.05);
  return 10 * Math.log10(early / late);
}

/**
 * 智能生成声学布置推荐列表（精确第一反射点靶心 + 全高角落低频陷阱 + 基于目标 RT60 动态定量补齐）
 */
export function buildSmartRecommendations(
  room: RoomConfig,
  goalId: TargetGoalId
): RecommendedHint[] {
  const hints: RecommendedHint[] = [];
  const goal = TARGET_GOALS[goalId];
  const speakers = getSpeakerPositions(room);
  const listener = room.listenerPos;

  // 1. 四角通顶立柱低频陷阱（压制三面与两面墙角驻波高压区）
  const trapH = Number(Math.min(2.2, Math.max(1.0, room.height - 0.24)).toFixed(2));
  const trapY = Number((room.height * 0.5).toFixed(2));
  const trapOffset = 0.45 * 0.42;

  hints.push(
    {
      id: 'rec-trap-fl',
      productId: 'bass_trap_corner',
      title: '左前墙角 · 通顶低频陷阱',
      reason: '音箱后方墙角声压极大区，强力吸收 60~250Hz 驻波轰鸣',
      face: 'front',
      center: { x: trapOffset, y: trapY, z: trapOffset },
      width: 0.45,
      height: trapH,
      cornerIndex: 0,
    },
    {
      id: 'rec-trap-fr',
      productId: 'bass_trap_corner',
      title: '右前墙角 · 通顶低频陷阱',
      reason: '与左前角对称消除前墙低频驻波堆积，收紧低频瞬态',
      face: 'front',
      center: { x: room.width - trapOffset, y: trapY, z: trapOffset },
      width: 0.45,
      height: trapH,
      cornerIndex: 1,
    },
    {
      id: 'rec-trap-rl',
      productId: 'bass_trap_corner',
      title: '左后墙角 · 通顶低频陷阱',
      reason: '吸收纵向一阶/二阶低频驻波尾音，压低低频比 (BR)',
      face: 'rear',
      center: { x: trapOffset, y: trapY, z: room.length - trapOffset },
      width: 0.45,
      height: trapH,
      cornerIndex: 2,
    },
    {
      id: 'rec-trap-rr',
      productId: 'bass_trap_corner',
      title: '右后墙角 · 通顶低频陷阱',
      reason: '四角均衡阻尼，使全频段 RT60 曲线平直不翘尾',
      face: 'rear',
      center: { x: room.width - trapOffset, y: trapY, z: room.length - trapOffset },
      width: 0.45,
      height: trapH,
      cornerIndex: 3,
    }
  );

  // 2. 精确计算左右侧墙、天花板、前墙的「第一反射点」靶心！
  const leftSpk = speakers[0].pos;
  const rightSpk = speakers[speakers.length - 1].pos;

  const leftHit1 = computeMirrorHit('left', leftSpk, listener, room).hit;
  const leftHit2 = computeMirrorHit('left', rightSpk, listener, room).hit;
  const leftSpanZ = Math.abs(leftHit2.z - leftHit1.z);
  const leftPanelW = Number(clamp(leftSpanZ + 0.65, 0.8, Math.min(1.6, room.length * 0.45)).toFixed(2));
  const leftCenterZ = 0.5 * (leftHit1.z + leftHit2.z);

  const rightHit1 = computeMirrorHit('right', rightSpk, listener, room).hit;
  const rightHit2 = computeMirrorHit('right', leftSpk, listener, room).hit;
  const rightSpanZ = Math.abs(rightHit2.z - rightHit1.z);
  const rightPanelW = Number(clamp(rightSpanZ + 0.65, 0.8, Math.min(1.6, room.length * 0.45)).toFixed(2));
  const rightCenterZ = 0.5 * (rightHit1.z + rightHit2.z);

  const ceilHitL = computeMirrorHit('ceiling', leftSpk, listener, room).hit;
  const ceilHitR = computeMirrorHit('ceiling', rightSpk, listener, room).hit;
  const ceilSpanX = Math.abs(ceilHitR.x - ceilHitL.x);
  const ceilW = Number(clamp(ceilSpanX + 0.7, 0.9, Math.min(1.8, room.width * 0.65)).toFixed(2));
  const ceilCenterX = 0.5 * (ceilHitL.x + ceilHitR.x);
  const ceilCenterZ = 0.5 * (ceilHitL.z + ceilHitR.z);

  const bareRt60 = computeEyringRT60(room, []);
  const bareMidRt = 0.5 * (bareRt60[2] + bareRt60[3]);
  // 若房间因地毯+矿棉顶导致空房中频混响本身已很短，侧墙反射点改推 QRD 扩散板防止过度吸干！
  const useDiffuserOnSides = bareMidRt <= goal.rt60Max && goalId !== 'vocal';
  const sideProd = useDiffuserOnSides ? 'diffuser_qrd' : 'absorber_thick';
  const sideLabel = useDiffuserOnSides ? 'QRD 实木扩散板' : '10cm 宽频吸音板';
  const panelMaxH = Math.max(0.6, Math.min(1.3, room.height - 0.3));

  hints.push(
    {
      id: 'rec-abs-left',
      productId: sideProd,
      title: `左侧墙第一反射区 · ${sideLabel}`,
      reason: useDiffuserOnSides
        ? `基底吸音已较足，用扩散板打散侧墙镜面反射 (Z≈${leftCenterZ.toFixed(2)}m) 而不吸死高频`
        : `覆盖双箱左侧第一反射交点 (Z≈${leftCenterZ.toFixed(2)}m)，消除侧向梳状滤波与声像偏移`,
      face: 'left',
      center: {
        x: 0,
        y: clamp(leftHit1.y, panelMaxH * 0.5 + 0.1, room.height - panelMaxH * 0.5 - 0.1),
        z: clamp(leftCenterZ, leftPanelW * 0.5 + 0.1, room.length - leftPanelW * 0.5 - 0.1),
      },
      width: leftPanelW,
      height: panelMaxH,
    },
    {
      id: 'rec-abs-right',
      productId: sideProd,
      title: `右侧墙第一反射区 · ${sideLabel}`,
      reason: useDiffuserOnSides
        ? `对称打散右侧玻璃/硬墙反射 (Z≈${rightCenterZ.toFixed(2)}m)，兼顾结像与空间活度`
        : `覆盖双箱右侧第一反射交点 (Z≈${rightCenterZ.toFixed(2)}m)，令中心人声结像扎实凝聚`,
      face: 'right',
      center: {
        x: room.width,
        y: clamp(rightHit1.y, panelMaxH * 0.5 + 0.1, room.height - panelMaxH * 0.5 - 0.1),
        z: clamp(rightCenterZ, rightPanelW * 0.5 + 0.1, room.length - rightPanelW * 0.5 - 0.1),
      },
      width: rightPanelW,
      height: panelMaxH,
    }
  );

  if (room.ceilingMaterial !== 'acoustic_ceiling') {
    hints.push({
      id: 'rec-abs-ceil',
      productId: 'absorber_thick',
      title: '天花板声学云吊顶 · 10cm 宽频吸音板',
      reason: `精确拦截头顶镜面反射 (Z≈${ceilCenterZ.toFixed(2)}m)，显著拉升 C50 清晰度`,
      face: 'ceiling',
      center: {
        x: clamp(ceilCenterX, ceilW * 0.5 + 0.15, room.width - ceilW * 0.5 - 0.15),
        y: room.height,
        z: clamp(ceilCenterZ, 0.7, room.length - 0.7),
      },
      width: ceilW,
      height: 1.2,
    });
  }

  // 前墙音箱后方 SBIR 边界干涉吸收板
  const frontHitL = computeMirrorHit('front', leftSpk, listener, room).hit;
  const frontHitR = computeMirrorHit('front', rightSpk, listener, room).hit;
  const frontSpanX = Math.abs(frontHitR.x - frontHitL.x);
  const frontW = Number(clamp(frontSpanX + 0.7, 0.9, Math.min(1.9, room.width - 0.9)).toFixed(2));
  hints.push({
    id: 'rec-abs-front',
    productId: 'absorber_thick',
    title: '前墙音箱背区 · 10cm SBIR 吸音阵列',
    reason: '拦截音箱向后辐射经前墙反弹的早期干涉波 (SBIR)，抚平 100~300Hz 频响凹谷',
    face: 'front',
    center: {
      x: clamp(0.5 * (frontHitL.x + frontHitR.x), frontW * 0.5 + 0.4, room.width - frontW * 0.5 - 0.4),
      y: clamp(frontHitL.y, 0.7, room.height - 0.7),
      z: 0,
    },
    width: frontW,
    height: Math.min(1.3, room.height - 0.3),
  });

  // 3. 后墙第一反射区处理（Hi-Fi / 混音采用宽幅 QRD 扩散阵列；人声录音间采用宽频吸音）
  const rearHitL = computeMirrorHit('rear', leftSpk, listener, room).hit;
  const rearHitR = computeMirrorHit('rear', rightSpk, listener, room).hit;
  const rearY = clamp(listener.y, 0.65, room.height - 0.65);

  if (goalId === 'vocal') {
    const rearW = Number(clamp(Math.abs(rearHitR.x - rearHitL.x) + 0.8, 1.0, room.width - 0.9).toFixed(2));
    hints.push({
      id: 'rec-rear-vocal',
      productId: 'absorber_thick',
      title: '后墙中轴 · 10cm 宽频吸音板',
      reason: '消除背墙回声对录音麦克风的二次染色',
      face: 'rear',
      center: { x: room.width * 0.5, y: rearY, z: room.length },
      width: rearW,
      height: Math.min(1.4, room.height - 0.3),
    });
  } else {
    const leftDiffX = clamp(Math.min(rearHitL.x, room.width * 0.5 - 0.42), 0.55, room.width * 0.5);
    const rightDiffX = clamp(Math.max(rearHitR.x, room.width * 0.5 + 0.42), room.width * 0.5, room.width - 0.55);
    hints.push(
      {
        id: 'rec-rear-diff-1',
        productId: 'diffuser_qrd',
        title: '后墙左反射区 · QRD 实木扩散板',
        reason: '打散背墙镜面强反射为均匀漫反射，保留空间自然空气感',
        face: 'rear',
        center: { x: leftDiffX, y: rearY, z: room.length },
        width: 0.75,
        height: 1.0,
      },
      {
        id: 'rec-rear-diff-2',
        productId: 'diffuser_qrd',
        title: '后墙右反射区 · QRD 实木扩散板',
        reason: '对称覆盖右声道后墙反射点，消除前后墙颤动回声',
        face: 'rear',
        center: { x: rightDiffX, y: rearY, z: room.length },
        width: 0.75,
        height: 1.0,
      }
    );
  }

  // 4. 定量补齐计算（回答“到底要多少块才能把当前房间混响降到目标区间？”）
  // 根据房间体积与墙体材质（如毛坯水泥 vs 木墙）动态补充后半区辅助吸音模块，直到中频 RT60 达标！
  const candidateSlots: Omit<RecommendedHint, 'id'>[] = [
    {
      productId: 'absorber_thick',
      title: '左侧墙后段 · 混响均衡吸音板',
      reason: '补充房间总吸音量 (Sabins)，消除侧后墙平行颤动回声',
      face: 'left',
      center: { x: 0, y: rearY, z: clamp(room.length * 0.72, 0.8, room.length - 0.8) },
      width: 1.0,
      height: Math.min(1.4, room.height - 0.3),
    },
    {
      productId: 'absorber_thick',
      title: '右侧墙后段 · 混响均衡吸音板',
      reason: '与左侧墙对称控制中高频混响尾音，确保左右声场平衡',
      face: 'right',
      center: { x: room.width, y: rearY, z: clamp(room.length * 0.72, 0.8, room.length - 0.8) },
      width: 1.0,
      height: Math.min(1.4, room.height - 0.3),
    },
    {
      productId: 'absorber_thick',
      title: '天花板后区 · 辅助吸音云吊顶',
      reason: '大空间/硬质墙面房间需额外顶面吸音面积以将 RT60 压入目标带',
      face: 'ceiling',
      center: { x: room.width * 0.5, y: room.height, z: clamp(room.length * 0.68, 0.9, room.length - 0.9) },
      width: Math.min(1.6, room.width * 0.6),
      height: 1.2,
    },
    {
      productId: 'absorber_thick',
      title: '前墙上部 · 辅助宽频吸音板',
      reason: '高反射基底墙面定量补齐，压制上部空间混响积累',
      face: 'front',
      center: { x: room.width * 0.5, y: clamp(room.height * 0.74, 1.1, room.height - 0.45), z: 0 },
      width: Math.min(1.6, room.width * 0.55),
      height: 0.8,
    },
  ];

  const toTempPanels = (list: RecommendedHint[]): PlacedPanel[] =>
    list.map((h) => ({
      id: h.id,
      productId: h.productId,
      face: h.face,
      center: h.center,
      width: h.width,
      height: h.height,
      thickness: TREATMENT_CATALOG[h.productId].thickness,
      cornerIndex: h.cornerIndex,
    }));

  let slotIdx = 0;
  while (slotIdx < candidateSlots.length) {
    const rtCheck = computeEyringRT60(room, toTempPanels(hints));
    const midRt = 0.5 * (rtCheck[2] + rtCheck[3]);
    if (midRt <= goal.rt60Max + 0.02) break;
    const slot = candidateSlots[slotIdx];
    hints.push({ ...slot, id: `rec-extra-${slotIdx}` });
    slotIdx++;
  }

  return hints;
}

export function runRoomSimulation(
  room: RoomConfig,
  panels: PlacedPanel[],
  goalId: TargetGoalId
): SimulationResult {
  const volumeM3 = room.width * room.height * room.length;
  const surfaceAreaM2 =
    2 * (room.width * room.height + room.length * room.height + room.width * room.length);

  const rt60Untreated = computeEyringRT60(room, []);
  const rt60Treated = computeEyringRT60(room, panels);

  const rt60MidUntreated = 0.5 * (rt60Untreated[2] + rt60Untreated[3]);
  const rt60MidTreated = 0.5 * (rt60Treated[2] + rt60Treated[3]);

  // 施罗德频率 f_s = 2000 * sqrt(RT60 / V)：小房间声学与车载声学最关键的分界频率！
  const schroederFreqHz = 2000 * Math.sqrt(rt60MidTreated / Math.max(volumeM3, 1));

  const bassRatio = (rt60Treated[0] + rt60Treated[1]) / Math.max(rt60Treated[2] + rt60Treated[3], 0.08);
  const trebleRatio = (rt60Treated[4] + rt60Treated[5]) / Math.max(rt60Treated[2] + rt60Treated[3], 0.08);

  const reflections = traceReflections(room, panels);
  const clarityC50Untreated = calcClarityC50(rt60MidUntreated, reflections, false);
  const clarityC50Treated = calcClarityC50(rt60MidTreated, reflections, true);

  // 隔音估算：声学“短板效应”——隔音板只有大面积覆盖墙面才显著提升整体隔声量
  const baseWallStc = BASE_MATERIALS[room.wallMaterial].baseStc;
  const wallSurface = 2 * (room.width * room.height + room.length * room.height);
  let soundproofArea = 0;
  for (const p of panels) {
    if (p.productId === 'soundproof_board') {
      soundproofArea += p.width * p.height;
    }
  }
  const coverFrac = clamp(soundproofArea / Math.max(wallSurface, 1), 0, 1);
  // 复合墙体隔声对数透射定律近似：局部贴隔音板漏音严重，覆盖率接近100%才发挥全部增益
  const transmittedEnergy = (1 - coverFrac) * 1.0 + coverFrac * Math.pow(10, -12 / 10);
  const stcGainDb = -10 * Math.log10(Math.max(transmittedEnergy, 0.06));
  const estimatedStcDb = baseWallStc + stcGainDb;

  const { modes, freqResponse } = solveModesAndResponse(
    room,
    rt60Untreated,
    rt60Treated,
    reflections
  );

  // 智能声学诊断与打分
  const goal = TARGET_GOALS[goalId];
  const diagnostics: SimulationResult['diagnostics'] = [];
  let score = 92;

  // 1. 混响时间评估
  if (rt60MidTreated > goal.rt60Max + 0.15) {
    score -= 26;
    diagnostics.push({
      level: 'bad',
      title: `中频混响过长 (${rt60MidTreated.toFixed(2)}s，目标 ${goal.rt60Min}~${goal.rt60Max}s)`,
      detail: '房间内反射声衰减太慢，人声和乐器糊成一团。建议增加 10cm 宽频吸音板与角落低频陷阱。',
    });
  } else if (rt60MidTreated > goal.rt60Max) {
    score -= 12;
    diagnostics.push({
      level: 'warn',
      title: `混响略偏长 (${rt60MidTreated.toFixed(2)}s)`,
      detail: `距离【${goal.name}】理想区间 (${goal.rt60Min}~${goal.rt60Max}s) 还差少量吸音面积。`,
    });
  } else if (rt60MidTreated < goal.rt60Min - 0.05) {
    const absorberCount = panels.filter(
      (p) => TREATMENT_CATALOG[p.productId].category === 'absorber'
    ).length;
    score -= absorberCount > 0 ? 14 : 8;
    diagnostics.push({
      level: 'warn',
      title:
        absorberCount > 0
          ? `吸音板过多导致房间过干 (${rt60MidTreated.toFixed(2)}s < ${goal.rt60Min}s)`
          : `顶/地基底材质中高频吸音已偏强 (${rt60MidTreated.toFixed(2)}s < ${goal.rt60Min}s)`,
      detail:
        absorberCount > 0
          ? '空间过于干瘪压抑（俗称“消音室耳压感”），建议删减吸音板或替换为 QRD 扩散板保留自然活度。'
          : '地毯/吸音吊顶已大幅压低中高频混响，切勿再贴薄吸音棉！墙面反射点建议改用 QRD 扩散板，并重点在墙角放低频陷阱治理低频。',
    });
  } else {
    diagnostics.push({
      level: 'good',
      title: `中频混响时间理想 (${rt60MidTreated.toFixed(2)}s)`,
      detail: `完美落在【${goal.name}】黄金混响窗口 (${goal.rt60Min}~${goal.rt60Max}s) 内！`,
    });
  }

  // 2. 低频与薄海绵失衡诊断
  const foamCount = panels.filter((p) => p.productId === 'absorber_foam').length;
  if (bassRatio > 1.38 || (foamCount >= 3 && trebleRatio < 0.72)) {
    score -= 18;
    diagnostics.push({
      level: 'bad',
      title: `三频混响严重失衡 (低频比 BR=${bassRatio.toFixed(2)})`,
      detail:
        foamCount >= 2
          ? '检测到较多 3cm 薄海绵：它们只吸掉了高频泛音，低频驻波完全没吸动，导致声音“又闷又轰头”！请换用墙角低频陷阱+10cm厚板。'
          : '低频混响远长于中高频，鼓点和贝斯尾音拖泥带水。强烈建议在四角放置三棱柱低频陷阱！',
    });
  } else if (bassRatio <= 1.28 && bassRatio >= 0.9) {
    diagnostics.push({
      level: 'good',
      title: `低频混响平衡优秀 (BR=${bassRatio.toFixed(2)})`,
      detail: '低频收放干净紧致，没有明显嗡鸣拖尾。',
    });
  }

  // 3. 第一反射点拦截检查
  const sideCeilRaw = reflections.filter(
    (r) => (r.face === 'left' || r.face === 'right' || r.face === 'ceiling') && r.status === 'raw'
  );
  if (sideCeilRaw.length >= 3) {
    score -= 18;
    diagnostics.push({
      level: 'warn',
      title: `${sideCeilRaw.length} 条关键早期强反射未拦截（红线直刺人耳）`,
      detail: '侧墙/天花板的第一反射声滞后直达声仅几毫秒，会产生强烈梳状滤波并拉偏声像。请将吸音板移到墙面红点位置！',
    });
  } else if (sideCeilRaw.length === 0) {
    score += 4;
    diagnostics.push({
      level: 'good',
      title: '左右侧墙与顶面第一反射点已全部受控',
      detail: '早期镜面强反射已被有效吸收或打散，声场结像清晰凝聚！',
    });
  }

  // 4. 听音位节点检查（50% 房间驻波死点警告 —— 车载与房间声学经典铁律）
  const zRatio = room.listenerPos.z / room.length;
  if (Math.abs(zRatio - 0.5) < 0.05) {
    score -= 10;
    diagnostics.push({
      level: 'warn',
      title: '听音位正处于房间长度 50% 驻波波节区！',
      detail: '房间正中心是一阶纵向驻波的声压零点（深谷区，拉 EQ 也救不回来）！建议将听音位前移至 38% 黄金位置附近。',
    });
  }

  // 5. 隔音板科普提示
  const spCount = panels.filter((p) => p.productId === 'soundproof_board').length;
  if (spCount > 0) {
    diagnostics.push({
      level: 'info',
      title: `隔音板覆盖率 ${(coverFrac * 100).toFixed(0)}%，对外隔声提升 +${stcGainDb.toFixed(1)} dB`,
      detail:
        coverFrac < 0.5
          ? '注意声学“漏桶效应”：隔音板只贴局部时声音仍会从裸露墙面透出；且隔音板表面坚硬不降混响，房内仍需搭配吸音板。'
          : '大面积隔音阻尼层显著降低了向隔壁的传声，记得在其内表面搭配吸音软包控制室内反射。',
    });
  }

  const recommendations = buildSmartRecommendations(room, goalId);

  return {
    volumeM3,
    surfaceAreaM2,
    schroederFreqHz,
    rt60Untreated,
    rt60Treated,
    rt60MidUntreated,
    rt60MidTreated,
    bassRatio,
    trebleRatio,
    clarityC50Untreated,
    clarityC50Treated,
    estimatedStcDb,
    stcGainDb,
    score: clamp(Math.round(score), 12, 99),
    reflections,
    modes,
    freqResponse,
    diagnostics,
    recommendations,
  };
}
