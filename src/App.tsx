import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AudioLines,
  CheckCircle2,
  Compass,
  Eraser,
  Flame,
  Headphones,
  Layers,
  Plus,
  Radio,
  RotateCcw,
  Sparkles,
  Trash2,
  Upload,
  Volume2,
  Wand2,
} from 'lucide-react';
import {
  clampPanelToRoom,
  computeCornerPressureWeight,
  runRoomSimulation,
} from './acoustics/engine';
import {
  BASE_MATERIALS,
  TARGET_GOALS,
  TREATMENT_CATALOG,
  WALL_FACE_LABELS,
} from './acoustics/materials';
import {
  BaseSurfaceMaterialId,
  PlacedPanel,
  RecommendedHint,
  RoomConfig,
  TargetGoalId,
  TreatmentProductId,
  WallFace,
} from './acoustics/types';
import {
  AUDIO_SOURCE_OPTIONS,
  AudioSourceKind,
  ListenMode,
  roomAuralizer,
} from './audio/auralizer';
import { AcousticCharts } from './components/AcousticCharts';
import { RoomViewport3D } from './components/RoomViewport3D';

const INITIAL_ROOM: RoomConfig = {
  width: 3.6,
  height: 2.8,
  length: 4.8,
  wallMaterial: 'drywall',
  floorMaterial: 'wood_panel',
  ceilingMaterial: 'drywall',
  speakerMode: 'stereo',
  speakerPos: { x: 1.8, y: 1.18, z: 0.85 },
  stereoSpan: 1.8,
  listenerPos: { x: 1.8, y: 1.18, z: 1.82 }, // 38% 黄金听音点
};

let uidCounter = 100;
function nextId(prefix = 'pnl'): string {
  uidCounter += 1;
  return `${prefix}-${uidCounter}`;
}

export const App: React.FC = () => {
  const [room, setRoom] = useState<RoomConfig>(INITIAL_ROOM);
  const [goalId, setGoalId] = useState<TargetGoalId>('hifi');
  const [panels, setPanels] = useState<PlacedPanel[]>([]);
  const [selectedPanelId, setSelectedPanelId] = useState<string | null>(null);
  const [activeCatalogId, setActiveCatalogId] = useState<TreatmentProductId>('absorber_thick');
  const [hoveredHintId, setHoveredHintId] = useState<string | null>(null);

  // 3D 视图辅助开关：默认关闭推荐靶位框，确保 0 件材料时房间干干净净不混淆！
  const [showRays, setShowRays] = useState(true);
  const [showFloorRays, setShowFloorRays] = useState(false);
  const [showHints, setShowHints] = useState(false);
  const [showBassHeatmap, setShowBassHeatmap] = useState(false);
  const [heatmapFreqHz, setHeatmapFreqHz] = useState(71);
  const [isViewportExpanded, setIsViewportExpanded] = useState(false);

  // 可听化收音试听状态（默认采用 PyRoomAcoustics 标准无混响原声木吉他参考干声）
  const [isPlaying, setIsPlaying] = useState(false);
  const [listenMode, setListenMode] = useState<ListenMode>('treated');
  const [sourceKind, setSourceKind] = useState<AudioSourceKind>('guitar');
  const [customFileName, setCustomFileName] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const sim = useMemo(() => runRoomSimulation(room, panels, goalId), [room, panels, goalId]);

  useEffect(() => {
    if (!isPlaying) return;
    const timer = window.setTimeout(() => {
      roomAuralizer.updateSimulation(sim);
    }, 90);
    return () => window.clearTimeout(timer);
  }, [sim, isPlaying]);

  useEffect(() => {
    return () => roomAuralizer.stop();
  }, []);

  // 房间尺寸调整时，按比例同步缩放音箱与听音位相对坐标，防止拉大房间后音箱缩在一角！
  const updateRoom = (patch: Partial<RoomConfig>) => {
    setRoom((prev) => {
      const next: RoomConfig = { ...prev, ...patch };

      if (patch.width !== undefined && prev.width > 0 && !patch.speakerPos && !patch.listenerPos) {
        const scaleX = patch.width / prev.width;
        next.speakerPos = { ...next.speakerPos, x: Number((prev.speakerPos.x * scaleX).toFixed(2)) };
        next.listenerPos = { ...next.listenerPos, x: Number((prev.listenerPos.x * scaleX).toFixed(2)) };
      }
      if (patch.length !== undefined && prev.length > 0 && !patch.speakerPos && !patch.listenerPos) {
        const scaleZ = patch.length / prev.length;
        next.speakerPos = { ...next.speakerPos, z: Number((prev.speakerPos.z * scaleZ).toFixed(2)) };
        next.listenerPos = { ...next.listenerPos, z: Number((prev.listenerPos.z * scaleZ).toFixed(2)) };
      }

      next.speakerPos = {
        x: Math.min(Math.max(0.3, next.speakerPos.x), next.width - 0.3),
        y: Math.min(Math.max(0.3, next.speakerPos.y), next.height - 0.25),
        z: Math.min(Math.max(0.25, next.speakerPos.z), next.length - 0.35),
      };
      next.listenerPos = {
        x: Math.min(Math.max(0.3, next.listenerPos.x), next.width - 0.3),
        y: Math.min(Math.max(0.3, next.listenerPos.y), next.height - 0.25),
        z: Math.min(Math.max(0.35, next.listenerPos.z), next.length - 0.3),
      };
      setPanels((oldPanels) => oldPanels.map((p) => clampPanelToRoom(p, next)));
      return next;
    });
  };

  const resetStandardRoom = () => {
    setRoom(INITIAL_ROOM);
    setPanels([]);
    setSelectedPanelId(null);
    setGoalId('hifi');
    setShowHints(false);
  };

  const addPanelOnTarget = (productId: TreatmentProductId, targetFace: WallFace, cornerIdx?: 0 | 1 | 2 | 3) => {
    const spec = TREATMENT_CATALOG[productId];
    const jitter = ((panels.length % 5) - 2) * 0.22;

    let rawCenter = { x: room.width * 0.5, y: room.height * 0.46, z: room.length * 0.5 };
    if (targetFace === 'left') {
      rawCenter = { x: 0, y: room.listenerPos.y, z: room.length * 0.35 + jitter };
    } else if (targetFace === 'right') {
      rawCenter = { x: room.width, y: room.listenerPos.y, z: room.length * 0.35 + jitter };
    } else if (targetFace === 'front') {
      rawCenter = { x: room.width * 0.5 + jitter, y: room.listenerPos.y, z: 0 };
    } else if (targetFace === 'rear') {
      rawCenter = { x: room.width * 0.5 + jitter, y: room.listenerPos.y, z: room.length };
    } else if (targetFace === 'ceiling') {
      rawCenter = { x: room.width * 0.5 + jitter, y: room.height, z: room.length * 0.36 };
    }

    const created = clampPanelToRoom(
      {
        id: nextId('pnl'),
        productId,
        face: targetFace,
        center: rawCenter,
        width: spec.defaultWidth,
        height: Math.min(spec.defaultHeight, room.height - 0.2),
        thickness: spec.thickness,
        cornerIndex: spec.cornerSnap ? (cornerIdx ?? 0) : undefined,
      },
      room
    );

    setPanels((prev) => [...prev, created]);
    setSelectedPanelId(created.id);
  };

  const applySingleRecommendation = (hint: RecommendedHint) => {
    const spec = TREATMENT_CATALOG[hint.productId];
    const created = clampPanelToRoom(
      {
        id: nextId('rec'),
        productId: hint.productId,
        face: hint.face,
        center: hint.center,
        width: hint.width,
        height: hint.height,
        thickness: spec.thickness,
        cornerIndex: hint.cornerIndex,
      },
      room
    );
    setPanels((prev) => [...prev, created]);
    setSelectedPanelId(created.id);
  };

  const applyAllRecommendations = () => {
    const built = sim.recommendations.map((hint) => {
      const spec = TREATMENT_CATALOG[hint.productId];
      return clampPanelToRoom(
        {
          id: nextId('rec'),
          productId: hint.productId,
          face: hFace(hint),
          center: hint.center,
          width: hint.width,
          height: hint.height,
          thickness: spec.thickness,
          cornerIndex: hint.cornerIndex,
        },
        room
      );
    });
    setPanels(built);
    setSelectedPanelId(null);
    setShowHints(false);
  };

  function hFace(h: RecommendedHint): WallFace {
    return h.face;
  }

  // 四大经典对比预设场景（每次切换均干净重置旧材料！）
  const loadScenarioPreset = (preset: 'bare_concrete' | 'foam_mistake' | 'pro_studio' | 'car_cabin_sim') => {
    setSelectedPanelId(null);
    setShowHints(false);
    if (preset === 'bare_concrete') {
      const r: RoomConfig = {
        ...INITIAL_ROOM,
        wallMaterial: 'concrete',
        floorMaterial: 'concrete',
        ceilingMaterial: 'concrete',
      };
      setRoom(r);
      setPanels([]);
      setGoalId('hifi');
    } else if (preset === 'foam_mistake') {
      const r: RoomConfig = { ...INITIAL_ROOM, wallMaterial: 'concrete' };
      setRoom(r);
      const mistakes: PlacedPanel[] = [];
      for (let i = 0; i < 4; i++) {
        mistakes.push(
          clampPanelToRoom(
            {
              id: nextId('foam'),
              productId: 'absorber_foam',
              face: 'left',
              center: { x: 0, y: 1.25, z: 0.9 + i * 0.78 },
              width: 0.6,
              height: 0.6,
              thickness: 0.03,
            },
            r
          ),
          clampPanelToRoom(
            {
              id: nextId('foam'),
              productId: 'absorber_foam',
              face: 'right',
              center: { x: r.width, y: 1.25, z: 0.9 + i * 0.78 },
              width: 0.6,
              height: 0.6,
              thickness: 0.03,
            },
            r
          )
        );
      }
      setPanels(mistakes);
    } else if (preset === 'pro_studio') {
      const r: RoomConfig = {
        ...INITIAL_ROOM,
        wallMaterial: 'drywall',
        floorMaterial: 'wood_panel',
        ceilingMaterial: 'drywall',
      };
      setRoom(r);
      setGoalId('mixing');
      const recs = runRoomSimulation(r, [], 'mixing').recommendations;
      setPanels(
        recs.map((h) => {
          const s = TREATMENT_CATALOG[h.productId];
          return clampPanelToRoom(
            {
              id: nextId('pro'),
              productId: h.productId,
              face: h.face,
              center: h.center,
              width: h.width,
              height: h.height,
              thickness: s.thickness,
              cornerIndex: h.cornerIndex,
            },
            r
          );
        })
      );
    } else if (preset === 'car_cabin_sim') {
      const r: RoomConfig = {
        width: 2.2,
        height: 1.6,
        length: 2.8,
        wallMaterial: 'glass_window',
        floorMaterial: 'carpet',
        ceilingMaterial: 'acoustic_ceiling',
        speakerMode: 'stereo',
        speakerPos: { x: 1.1, y: 0.75, z: 0.35 },
        stereoSpan: 1.5,
        listenerPos: { x: 0.68, y: 0.92, z: 1.25 },
      };
      setRoom(r);
      setGoalId('car_lab');
      setPanels([]);
    }
  };

  const handleTogglePlay = async () => {
    const playing = await roomAuralizer.togglePlay(sim);
    setIsPlaying(playing);
  };

  const handleChangeListenMode = (m: ListenMode) => {
    setListenMode(m);
    roomAuralizer.setListenMode(m);
  };

  const handleChangeSource = (k: AudioSourceKind) => {
    setSourceKind(k);
    roomAuralizer.setSourceKind(k);
  };

  const handleUploadAudio = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await roomAuralizer.loadCustomAudioFile(file);
    setCustomFileName(file.name);
    setSourceKind('custom');
    if (!isPlaying) {
      const playing = await roomAuralizer.togglePlay(sim);
      setIsPlaying(playing);
    }
  };

  const selectedPanel = panels.find((p) => p.id === selectedPanelId) ?? null;
  const activeSpec = TREATMENT_CATALOG[activeCatalogId];

  const materialCounts = useMemo(() => {
    const map = new Map<TreatmentProductId, { count: number; area: number }>();
    for (const p of panels) {
      const prev = map.get(p.productId) ?? { count: 0, area: 0 };
      map.set(p.productId, { count: prev.count + 1, area: prev.area + p.width * p.height });
    }
    return map;
  }, [panels]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <div className="brand-icon">
            <AudioLines size={19} />
          </div>
          <div>
            <h1>
              AcousticLab 3D <span className="cpp-badge">CAD 3D · C++17 内核对齐</span>
            </h1>
            <p>房间声学材料仿真 · 第一反射追踪 · 实时卷积收音试听</p>
          </div>
        </div>

        <div className="scenario-bar">
          <span className="bar-label">预设场景:</span>
          <button type="button" className="preset-btn" onClick={() => loadScenarioPreset('bare_concrete')}>
            毛坯水泥房
          </button>
          <button type="button" className="preset-btn warn" onClick={() => loadScenarioPreset('foam_mistake')}>
            误区:满墙薄棉
          </button>
          <button type="button" className="preset-btn good" onClick={() => loadScenarioPreset('pro_studio')}>
            标准科学方案
          </button>
          <button type="button" className="preset-btn car" onClick={() => loadScenarioPreset('car_cabin_sim')}>
            类车载偏置声场
          </button>
        </div>

        <div className="auralizer-bar">
          <button
            type="button"
            className={`play-btn ${isPlaying ? 'playing' : ''}`}
            onClick={handleTogglePlay}
          >
            {isPlaying ? <Volume2 size={15} /> : <Headphones size={15} />}
            {isPlaying ? '正在收音试听' : '开启收音试听'}
          </button>

          <div className="segmented">
            <button
              type="button"
              className={listenMode === 'dry' ? 'active' : ''}
              onClick={() => handleChangeListenMode('dry')}
            >
              干声原音
            </button>
            <button
              type="button"
              className={listenMode === 'untreated' ? 'active raw' : ''}
              onClick={() => handleChangeListenMode('untreated')}
            >
              空房混响
            </button>
            <button
              type="button"
              className={listenMode === 'treated' ? 'active treated' : ''}
              onClick={() => handleChangeListenMode('treated')}
            >
              当前方案
            </button>
          </div>

          <select
            className="source-select"
            value={sourceKind}
            onChange={(e) => handleChangeSource(e.target.value as AudioSourceKind)}
          >
            {AUDIO_SOURCE_OPTIONS.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.label}
              </option>
            ))}
            {customFileName && <option value="custom">本地: {customFileName.slice(0, 12)}</option>}
          </select>

          <button
            type="button"
            className="icon-btn"
            title="上传本地 MP3/WAV 试音曲"
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload size={14} />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="audio/*"
            style={{ display: 'none' }}
            onChange={handleUploadAudio}
          />
        </div>
      </header>

      <main className={`studio-grid ${isViewportExpanded ? 'expanded-cad' : ''}`}>
        {/* 左栏 */}
        {!isViewportExpanded && (
          <aside className="panel-col left-col">
            <section className="card-section">
              <div className="section-title-between">
                <span className="flex-title">
                  <Compass size={14} /> 1. 评价目标标准
                </span>
                {panels.length > 0 && (
                  <button
                    type="button"
                    className="clear-btn"
                    title="切换方案时如需清空已摆板材可点此一键清零"
                    onClick={() => {
                      setPanels([]);
                      setSelectedPanelId(null);
                    }}
                  >
                    <Eraser size={12} /> 清空材料({panels.length})
                  </button>
                )}
              </div>
              <div className="goal-grid">
                {(Object.keys(TARGET_GOALS) as TargetGoalId[]).map((gid) => {
                  const g = TARGET_GOALS[gid];
                  return (
                    <button
                      key={gid}
                      type="button"
                      className={`goal-card ${goalId === gid ? 'selected' : ''}`}
                      onClick={() => setGoalId(gid)}
                    >
                      <strong>{g.name}</strong>
                      <span>目标 RT60: {g.rt60Min}~{g.rt60Max}s</span>
                    </button>
                  );
                })}
              </div>
            </section>

            <section className="card-section">
              <div className="section-title-between">
                <span className="flex-title">
                  <Layers size={14} /> 2. 房间尺寸 & 材质 ({sim.volumeM3.toFixed(1)}m³)
                </span>
                <button
                  type="button"
                  className="clear-btn"
                  title="一键恢复标准听音室尺寸、材质并清空材料"
                  onClick={resetStandardRoom}
                >
                  <RotateCcw size={12} /> 重置房间
                </button>
              </div>

              <div className="slider-row">
                <label>长度 L (前后)</label>
                <input
                  type="range"
                  min={2.2}
                  max={8.5}
                  step={0.1}
                  value={room.length}
                  onChange={(e) => updateRoom({ length: Number(e.target.value) })}
                />
                <span className="val">{room.length.toFixed(1)}m</span>
              </div>

              <div className="slider-row">
                <label>宽度 W (左右)</label>
                <input
                  type="range"
                  min={2.0}
                  max={7.5}
                  step={0.1}
                  value={room.width}
                  onChange={(e) => updateRoom({ width: Number(e.target.value) })}
                />
                <span className="val">{room.width.toFixed(1)}m</span>
              </div>

              <div className="slider-row">
                <label>层高 H (顶地)</label>
                <input
                  type="range"
                  min={1.5}
                  max={4.2}
                  step={0.05}
                  value={room.height}
                  onChange={(e) => updateRoom({ height: Number(e.target.value) })}
                />
                <span className="val">{room.height.toFixed(2)}m</span>
              </div>

              <div className="mat-select-grid">
                <div>
                  <label>四面墙壁</label>
                  <select
                    value={room.wallMaterial}
                    onChange={(e) => updateRoom({ wallMaterial: e.target.value as BaseSurfaceMaterialId })}
                  >
                    {Object.values(BASE_MATERIALS).map((m) => (
                      <option key={m.id} value={m.id}>{m.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label>地面材质</label>
                  <select
                    value={room.floorMaterial}
                    onChange={(e) => updateRoom({ floorMaterial: e.target.value as BaseSurfaceMaterialId })}
                  >
                    {Object.values(BASE_MATERIALS).map((m) => (
                      <option key={m.id} value={m.id}>{m.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label>天花板</label>
                  <select
                    value={room.ceilingMaterial}
                    onChange={(e) => updateRoom({ ceilingMaterial: e.target.value as BaseSurfaceMaterialId })}
                  >
                    {Object.values(BASE_MATERIALS).map((m) => (
                      <option key={m.id} value={m.id}>{m.name}</option>
                    ))}
                  </select>
                </div>
              </div>
            </section>

            <section className="card-section">
              <div className="section-title">
                <Radio size={14} /> 3. 发声源与收音点摆位
              </div>
              <div className="inline-actions">
                <button
                  type="button"
                  className={`mini-btn ${room.speakerMode === 'mono' ? 'active' : ''}`}
                  onClick={() => updateRoom({ speakerMode: 'mono' })}
                >
                  单声源
                </button>
                <button
                  type="button"
                  className={`mini-btn ${room.speakerMode === 'stereo' ? 'active' : ''}`}
                  onClick={() => updateRoom({ speakerMode: 'stereo' })}
                >
                  双音箱
                </button>
                <button
                  type="button"
                  className="mini-btn accent"
                  onClick={() =>
                    updateRoom({
                      speakerPos: {
                        x: Number((room.width * 0.5).toFixed(2)),
                        y: Math.min(1.18, room.height * 0.65),
                        z: Number(Math.min(0.9, room.length * 0.2).toFixed(2)),
                      },
                      listenerPos: {
                        x: Number((room.width * 0.5).toFixed(2)),
                        y: Math.min(1.18, room.height * 0.65),
                        z: Number((room.length * 0.38).toFixed(2)),
                      },
                    })
                  }
                  title="将音箱与听音位沿房间中轴对称居中，并置入 38% 黄金听音位置"
                >
                  中轴38%黄金位
                </button>
                <button
                  type="button"
                  className="mini-btn danger-outline"
                  onClick={() =>
                    updateRoom({
                      listenerPos: {
                        x: Number((room.width * 0.5).toFixed(2)),
                        y: Math.min(1.18, room.height * 0.65),
                        z: Number((room.length * 0.5).toFixed(2)),
                      },
                    })
                  }
                >
                  试50%死点
                </button>
              </div>

              <div className="coord-summary">
                <span>音箱: X={room.speakerPos.x.toFixed(1)}m, Z={room.speakerPos.z.toFixed(2)}m</span>
                <span>听音位: Z={room.listenerPos.z.toFixed(2)}m ({((room.listenerPos.z / room.length) * 100).toFixed(0)}%)</span>
              </div>
            </section>

            <section className="card-section grow-section">
              <div className="section-title">
                <Plus size={14} /> 4. 声学材料库 (点击选型并挂墙)
              </div>

              <div className="catalog-list">
                {(Object.keys(TREATMENT_CATALOG) as TreatmentProductId[]).map((pid) => {
                  const item = TREATMENT_CATALOG[pid];
                  const isCurr = activeCatalogId === pid;
                  const count = materialCounts.get(pid)?.count ?? 0;
                  return (
                    <div
                      key={pid}
                      className={`catalog-item ${isCurr ? 'active' : ''}`}
                      onClick={() => setActiveCatalogId(pid)}
                    >
                      <div className="cat-head">
                        <span className="swatch" style={{ background: item.color }} />
                        <strong>{item.name}</strong>
                        {count > 0 && <span className="count-pill">×{count}</span>}
                      </div>
                      <p className="cat-desc">{item.description}</p>
                    </div>
                  );
                })}
              </div>

              <div className="place-box">
                <div className="place-box-title">
                  投放【{activeSpec.shortName}】到墙面：
                </div>
                {activeSpec.cornerSnap ? (
                  <div className="place-btn-grid">
                    <button type="button" onClick={() => addPanelOnTarget(activeCatalogId, 'front', 0)}>
                      + 左前墙角
                    </button>
                    <button type="button" onClick={() => addPanelOnTarget(activeCatalogId, 'front', 1)}>
                      + 右前墙角
                    </button>
                    <button type="button" onClick={() => addPanelOnTarget(activeCatalogId, 'rear', 2)}>
                      + 左后墙角
                    </button>
                    <button type="button" onClick={() => addPanelOnTarget(activeCatalogId, 'rear', 3)}>
                      + 右后墙角
                    </button>
                  </div>
                ) : (
                  <div className="place-btn-grid">
                    {activeSpec.allowedFaces.map((f) => (
                      <button key={f} type="button" onClick={() => addPanelOnTarget(activeCatalogId, f)}>
                        + {WALL_FACE_LABELS[f].split(' ')[0]}
                      </button>
                    ))}
                  </div>
                )}
                <div className="car-audio-tip">
                  <strong>车载调音对照：</strong>{activeSpec.carAudioNote}
                </div>
              </div>

              {selectedPanel && (
                <div className="inspector-box">
                  <div className="inspector-head">
                    <strong>已选中：{TREATMENT_CATALOG[selectedPanel.productId].shortName}</strong>
                    <button
                      type="button"
                      className="del-btn"
                      onClick={() => {
                        setPanels((prev) => prev.filter((p) => p.id !== selectedPanel.id));
                        setSelectedPanelId(null);
                      }}
                    >
                      <Trash2 size={12} /> 删除
                    </button>
                  </div>
                  {TREATMENT_CATALOG[selectedPanel.productId].category === 'bass_trap' && (
                    <div className="efficiency-tag">
                      当前坐标低频驻波效率:{' '}
                      <b>{(computeCornerPressureWeight(selectedPanel.center, room) * 100).toFixed(0)}%</b>
                    </div>
                  )}
                  <div className="slider-row compact">
                    <label>宽度</label>
                    <input
                      type="range"
                      min={0.3}
                      max={2.0}
                      step={0.1}
                      value={selectedPanel.width}
                      onChange={(e) => {
                        const w = Number(e.target.value);
                        setPanels((prev) =>
                          prev.map((p) =>
                            p.id === selectedPanel.id ? clampPanelToRoom({ ...p, width: w }, room) : p
                          )
                        );
                      }}
                    />
                    <span className="val">{selectedPanel.width.toFixed(1)}m</span>
                  </div>
                  <div className="slider-row compact">
                    <label>高度</label>
                    <input
                      type="range"
                      min={0.4}
                      max={Math.max(0.5, Math.min(2.6, room.height - 0.1))}
                      step={0.1}
                      value={selectedPanel.height}
                      onChange={(e) => {
                        const h = Number(e.target.value);
                        setPanels((prev) =>
                          prev.map((p) =>
                            p.id === selectedPanel.id ? clampPanelToRoom({ ...p, height: h }, room) : p
                          )
                        );
                      }}
                    />
                    <span className="val">{selectedPanel.height.toFixed(1)}m</span>
                  </div>
                </div>
              )}
            </section>
          </aside>
        )}

        {/* 中栏：CAD 3D 视窗 + 图表 */}
        <section className="center-col">
          <div className="viewport-card">
            <div className="viewport-toolbar">
              <label className="toggle-item">
                <input
                  type="checkbox"
                  checked={showRays}
                  onChange={(e) => setShowRays(e.target.checked)}
                />
                <span>第一反射声线</span>
              </label>

              <label className="toggle-item">
                <input
                  type="checkbox"
                  checked={showFloorRays}
                  disabled={!showRays}
                  onChange={(e) => setShowFloorRays(e.target.checked)}
                />
                <span>含地面反射</span>
              </label>

              <label
                className="toggle-item"
                title="开启后以空心虚线框预览建议安装靶位（非真实已放材料）"
              >
                <input
                  type="checkbox"
                  checked={showHints}
                  onChange={(e) => setShowHints(e.target.checked)}
                />
                <span>预览建议虚线位</span>
              </label>

              <label className="toggle-item highlight-heat">
                <input
                  type="checkbox"
                  checked={showBassHeatmap}
                  onChange={(e) => setShowBassHeatmap(e.target.checked)}
                />
                <Flame size={13} />
                <span>驻波热力图</span>
              </label>

              {showBassHeatmap && (
                <div className="heat-freq-slider">
                  <input
                    type="range"
                    min={35}
                    max={180}
                    step={1}
                    value={heatmapFreqHz}
                    onChange={(e) => setHeatmapFreqHz(Number(e.target.value))}
                  />
                  <span>{heatmapFreqHz}Hz</span>
                </div>
              )}

              {panels.length > 0 && (
                <button
                  type="button"
                  className="toolbar-clear-btn"
                  onClick={() => {
                    setPanels([]);
                    setSelectedPanelId(null);
                  }}
                >
                  <Eraser size={12} /> 清空房内材料 ({panels.length})
                </button>
              )}
            </div>

            <RoomViewport3D
              room={room}
              panels={panels}
              selectedPanelId={selectedPanelId}
              reflections={sim.reflections}
              recommendations={sim.recommendations}
              hoveredHintId={hoveredHintId}
              showRays={showRays}
              showFloorRays={showFloorRays}
              showHints={showHints}
              showBassHeatmap={showBassHeatmap}
              heatmapFreqHz={heatmapFreqHz}
              isExpanded={isViewportExpanded}
              onToggleExpand={() => setIsViewportExpanded((v) => !v)}
              onSelectPanel={setSelectedPanelId}
              onUpdatePanel={(updated) =>
                setPanels((prev) => prev.map((p) => (p.id === updated.id ? updated : p)))
              }
              onUpdateSpeakerPos={(pos) => updateRoom({ speakerPos: pos })}
              onUpdateListenerPos={(pos) => updateRoom({ listenerPos: pos })}
            />
          </div>

          <AcousticCharts
            sim={sim}
            goalId={goalId}
            panelsCount={panels.length}
            onPickModeFreq={(f) => {
              setShowBassHeatmap(true);
              setHeatmapFreqHz(Math.round(f));
            }}
          />
        </section>

        {/* 右栏 */}
        {!isViewportExpanded && (
          <aside className="panel-col right-col">
            <div className="kpi-grid">
              <div className="kpi-card">
                <span className="kpi-label">声学健康评分</span>
                <strong
                  className="kpi-val"
                  style={{
                    color: sim.score >= 80 ? '#34d399' : sim.score >= 60 ? '#fbbf24' : '#f87171',
                  }}
                >
                  {sim.score} <small>/ 100</small>
                </strong>
              </div>

              <div className="kpi-card">
                <span className="kpi-label">中频混响 RT60</span>
                <strong className="kpi-val">
                  {sim.rt60MidTreated.toFixed(2)}s
                </strong>
                <span className="kpi-sub">空房 {sim.rt60MidUntreated.toFixed(2)}s</span>
              </div>

              <div className="kpi-card">
                <span className="kpi-label">清晰度指数 C50</span>
                <strong className="kpi-val" style={{ color: '#38bdf8' }}>
                  {sim.clarityC50Treated >= 0 ? `+${sim.clarityC50Treated.toFixed(1)}` : sim.clarityC50Treated.toFixed(1)} dB
                </strong>
                <span className="kpi-sub">空房 {sim.clarityC50Untreated.toFixed(1)} dB</span>
              </div>

              <div className="kpi-card">
                <span className="kpi-label">对外隔声量 STC</span>
                <strong className="kpi-val">
                  {sim.estimatedStcDb.toFixed(0)} dB
                </strong>
                <span className="kpi-sub">隔音板增益 +{sim.stcGainDb.toFixed(1)}dB</span>
              </div>
            </div>

            <section className="card-section">
              <div className="section-title-between">
                <span>当前已摆材料清单 ({panels.length} 件)</span>
                {panels.length > 0 && (
                  <button
                    type="button"
                    className="clear-btn"
                    onClick={() => {
                      setPanels([]);
                      setSelectedPanelId(null);
                    }}
                  >
                    <Eraser size={12} /> 清空全部
                  </button>
                )}
              </div>

              {panels.length === 0 ? (
                <div className="empty-tip">
                  当前房间为 <b>0 件声学材料</b> 的裸房状态。可从左侧手动添加，或点击下方「一键摆放理想方案」。
                </div>
              ) : (
                <div className="bom-list">
                  {Array.from(materialCounts.entries()).map(([pid, info]) => {
                    const s = TREATMENT_CATALOG[pid];
                    return (
                      <div key={pid} className="bom-row">
                        <span className="swatch" style={{ background: s.color }} />
                        <span className="bom-name">{s.shortName}</span>
                        <span className="bom-qty">
                          {info.count} 块 ({info.area.toFixed(1)} m²)
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            <section className="card-section">
              <div className="section-title">
                <CheckCircle2 size={14} /> 实时收音诊断分析
              </div>
              <div className="diag-list">
                {sim.diagnostics.map((d, i) => (
                  <div key={i} className={`diag-item ${d.level}`}>
                    <strong>{d.title}</strong>
                    <p>{d.detail}</p>
                  </div>
                ))}
              </div>
            </section>

            <section className="card-section grow-section">
              <div className="section-title-between">
                <span className="flex-title">
                  <Sparkles size={14} /> 理想声学布置建议
                </span>
                <span className="hover-tip">悬停可在3D预览位置</span>
              </div>

              <button type="button" className="magic-apply-btn" onClick={applyAllRecommendations}>
                <Wand2 size={15} />
                一键自动摆放整套理想方案 ({sim.recommendations.length} 件)
              </button>

              <div className="rec-list">
                {sim.recommendations.map((rec) => {
                  const spec = TREATMENT_CATALOG[rec.productId];
                  return (
                    <div
                      key={rec.id}
                      className="rec-card"
                      onMouseEnter={() => setHoveredHintId(rec.id)}
                      onMouseLeave={() => setHoveredHintId(null)}
                    >
                      <div className="rec-card-top">
                        <span className="swatch" style={{ background: spec.color }} />
                        <strong>{rec.title}</strong>
                        <button
                          type="button"
                          className="rec-single-btn"
                          onClick={() => applySingleRecommendation(rec)}
                        >
                          + 放置
                        </button>
                      </div>
                      <p>{rec.reason}</p>
                    </div>
                  );
                })}
              </div>
            </section>
          </aside>
        )}
      </main>
    </div>
  );
};

export default App;
