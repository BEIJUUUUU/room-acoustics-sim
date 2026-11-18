import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AudioLines,
  CheckCircle2,
  ChevronDown,
  Compass,
  Eraser,
  Flame,
  Headphones,
  Layers,
  Plus,
  Radio,
  RotateCcw,
  Box,
  ChartNoAxesCombined,
  SlidersHorizontal,
  ArrowUpRight,
  Check,
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
import { PlanLibrary } from './components/PlanLibrary';
import type { LibraryTab } from './components/PlanLibrary';
import type { SavedDesign } from './projects/storage';
import { PLAN_STAGES } from './plans/catalog';

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

type WorkspaceContext = 'space' | 'materials' | 'analysis' | 'listen';
type MaterialTab = 'library' | 'advice' | 'list';

const DimensionInput: React.FC<{
  value: number; min: number; max: number; step: number; label: string; onCommit: (value: number) => void;
}> = ({ value, min, max, step, label, onCommit }) => {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const numeric = Number(draft);
    const next = draft.trim() !== '' && Number.isFinite(numeric) ? Math.max(min, Math.min(max, numeric)) : value;
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };
  return <input aria-label={label} type="number" min={min} max={max} step={step} value={draft}
    onChange={(e) => setDraft(e.target.value)} onBlur={commit}
    onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />;
};

const REFLECTION_TAG: Record<string, { label: string; tone: string }> = {
  absorbed: { label: '已吸音', tone: 'ok' },
  diffused: { label: '已扩散', tone: 'info' },
  raw: { label: '未拦截', tone: 'bad' },
  soft_surface: { label: '弱软面', tone: 'warn' },
};

export const App: React.FC = () => {
  const [room, setRoom] = useState<RoomConfig>(structuredClone(INITIAL_ROOM));
  const [goalId, setGoalId] = useState<TargetGoalId>('hifi');
  const [panels, setPanels] = useState<PlacedPanel[]>([]);
  const [selectedPanelId, setSelectedPanelId] = useState<string | null>(null);
  const [activeCatalogId, setActiveCatalogId] = useState<TreatmentProductId>('absorber_thick');
  const [hoveredHintId, setHoveredHintId] = useState<string | null>(null);
  const [libraryTab, setLibraryTab] = useState<LibraryTab | null>(null);
  const [activePlanId, setActivePlanId] = useState<string | undefined>();
  const planBaseline = useRef<string | null>(null);
  const [previewName, setPreviewName] = useState<string | null>(null);
  const previewOriginal = useRef<{
    room: RoomConfig; panels: PlacedPanel[]; goalId: TargetGoalId; planId?: string; baseline: string | null;
  } | null>(null);


  // 3D 视图辅助开关：默认关闭推荐靶位框，确保 0 件材料时房间干干净净不混淆！
  const [showRays, setShowRays] = useState(false);
  const [showFloorRays, setShowFloorRays] = useState(false);
  const [showHints, setShowHints] = useState(false);
  const [showBassHeatmap, setShowBassHeatmap] = useState(false);
  const [heatmapFreqHz, setHeatmapFreqHz] = useState(71);
  const [isViewportExpanded, setIsViewportExpanded] = useState(false);

  const [context, setContext] = useState<WorkspaceContext>('space');
  const [materialTab, setMaterialTab] = useState<MaterialTab>('library');
  // 可听化收音试听状态（默认采用 PyRoomAcoustics 标准无混响原声木吉他参考干声）
  const [isPlaying, setIsPlaying] = useState(false);
  const [listenMode, setListenMode] = useState<ListenMode>('treated');
  const [sourceKind, setSourceKind] = useState<AudioSourceKind>('guitar');
  const [customFileName, setCustomFileName] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const sim = useMemo(() => runRoomSimulation(room, panels, goalId), [room, panels, goalId]);
  const workspaceSignature = JSON.stringify({ room, panels, goalId });
  const planAdjusted = !!activePlanId && planBaseline.current !== workspaceSignature;
  const resetTransient = () => {
    setSelectedPanelId(null);
    setHoveredHintId(null);
    setShowHints(false);
    setShowBassHeatmap(false);
    setIsViewportExpanded(false);
  };
  const endPreview = () => {
    const original = previewOriginal.current;
    if (!original) return;
    previewOriginal.current = null;
    setRoom(structuredClone(original.room));
    setPanels(structuredClone(original.panels));
    setGoalId(original.goalId);
    setActivePlanId(original.planId);
    planBaseline.current = original.baseline;
    setPreviewName(null);
    resetTransient();
  };
  const closeLibrary = () => { endPreview(); setLibraryTab(null); };
  const applyStage = (nextPanels: PlacedPanel[], nextGoal: TargetGoalId, planId: string) => {
    endPreview();
    const copied = structuredClone(nextPanels);
    setPanels(copied);
    setGoalId(nextGoal);
    setActivePlanId(planId);
    planBaseline.current = JSON.stringify({ room, panels: copied, goalId: nextGoal });
    resetTransient();
  };
  const loadSavedDesign = (design: SavedDesign) => {
    endPreview();
    const copied = structuredClone(design);
    setRoom(copied.room);
    setPanels(copied.panels);
    setGoalId(copied.goalId);
    setActivePlanId(copied.planId);
    planBaseline.current = copied.planId ? JSON.stringify({ room: copied.room, panels: copied.panels, goalId: copied.goalId }) : null;
    resetTransient();
  };
  const previewDesign = (design: SavedDesign, label: string, unifiedGoal: TargetGoalId) => {
    if (!previewOriginal.current) {
      previewOriginal.current = structuredClone({ room, panels, goalId, planId: activePlanId, baseline: planBaseline.current });
    }
    const copied = structuredClone(design);
    setRoom(copied.room);
    setPanels(copied.panels);
    setGoalId(unifiedGoal);
    setActivePlanId(undefined);
    setPreviewName(label);
    resetTransient();
  };


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
    if (!window.confirm('重置将替换当前房间尺寸、材质、摆位及全部材料；未保存的修改会丢失。继续？')) return;
    setActivePlanId(undefined);
    planBaseline.current = null;
    resetTransient();
    setRoom(structuredClone(INITIAL_ROOM));
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
    if (!window.confirm('加载完整场景案例将替换房间尺寸、表面材质、音箱和听音位、目标用途及全部材料。未保存的修改会丢失，继续？')) return;
    endPreview();
    setActivePlanId(undefined);
    planBaseline.current = null;
    resetTransient();
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
      setGoalId('hifi');
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

  // 关键早期强反射：侧墙与天花板的第一反射（立体声下共 6 条）
  const earlyReflections = useMemo(
    () => sim.reflections.filter((r) => r.face === 'left' || r.face === 'right' || r.face === 'ceiling'),
    [sim.reflections]
  );

  const clearAllPanels = () => {
    setPanels([]);
    setSelectedPanelId(null);
  };

  const titles: Record<WorkspaceContext, string> = {
    space: '房间设置', materials: '声学材料', analysis: '分析概览', listen: '收音试听',
  };
  const navigateToContext = (next: WorkspaceContext) => {
    setIsViewportExpanded(false);
    setContext(next);
  };
  const selectPanel = (id: string | null) => {
    setSelectedPanelId(id);
    if (id) { navigateToContext('materials'); setMaterialTab('library'); }
  };
  const chart = (
    <AcousticCharts sim={sim} goalId={goalId} panelsCount={panels.length}
      onPickModeFreq={(f) => {
        setShowBassHeatmap(true);
        setHeatmapFreqHz(Math.round(f));
        navigateToContext('space');
      }} />
  );
  const displayControls = (
    <details className="display-menu">
      <summary><SlidersHorizontal size={15} /> 显示 <ChevronDown size={12} /></summary>
      <div className="display-popover">
        <span className="popover-title">场景辅助</span>
        <label><input type="checkbox" checked={showRays} onChange={(e) => setShowRays(e.target.checked)} />第一反射声线</label>
        <label><input type="checkbox" checked={showFloorRays} disabled={!showRays} onChange={(e) => setShowFloorRays(e.target.checked)} />包含地面反射</label>
        <label><input type="checkbox" checked={showHints} onChange={(e) => setShowHints(e.target.checked)} />建议安装位置</label>
        <label><input type="checkbox" checked={showBassHeatmap} onChange={(e) => setShowBassHeatmap(e.target.checked)} />驻波热力图</label>
        {showBassHeatmap && <label className="heat-frequency">频率 <input aria-label="热力图频率" type="range" min={35} max={180} step={1} value={heatmapFreqHz} onChange={(e) => setHeatmapFreqHz(Number(e.target.value))} /><b>{heatmapFreqHz} Hz</b></label>}
      </div>
    </details>
  );

  return (
    <div className="app">
      <header className="app-header">
        <a className="brand" href="#workspace" aria-label="AcousticLab 3D 工作台">
          <span className="brand-mark"><AudioLines size={22} /></span>
          <span>AcousticLab <b>3D</b></span>
        </a>
        <span className="header-divider" />
        <div className="project-name">我的听音室 <span>个人工作区</span></div>
        <div className="header-actions">
          <button type="button" className="library-entry" onClick={() => { setIsViewportExpanded(false); setLibraryTab('stages'); }}><Layers size={16} /><span>方案库</span></button>
          <button type="button" className="saved-entry" onClick={() => { setIsViewportExpanded(false); setLibraryTab('projects'); }}>保存 / 已保存</button>
          <button type="button" className={`listen-shortcut ${isPlaying ? 'is-on' : ''}`} onClick={handleTogglePlay} aria-label={isPlaying ? '停止试听' : '开始试听'}>
            {isPlaying ? <Volume2 size={16} /> : <Headphones size={16} />}<span>{isPlaying ? '停止试听' : '试听'}</span>
          </button>
        </div>
      </header>

      <div className={`workbench ${isViewportExpanded ? 'is-expanded' : ''}`}>
        <nav className="navigation" aria-label="工作台导航">
          {([
            ['space', Box, '空间'], ['materials', Layers, '材料'],
            ['analysis', ChartNoAxesCombined, '分析'], ['listen', Headphones, '试听'],
          ] as const).map(([key, Icon, label]) => (
            <button key={key} type="button" className={context === key ? 'is-active' : ''} aria-current={context === key ? 'page' : undefined} onClick={() => navigateToContext(key)}>
              <Icon size={21} strokeWidth={1.7} /><span>{label}</span>
            </button>
          ))}
          <span className="nav-bottom" title="本地实时计算">实时<br />仿真</span>
        </nav>

        <main id="workspace" className="main-workspace">
          <div className="workspace-heading">
            <div><div className="eyebrow">空间设计 / 声学模拟</div><h1>{context === 'analysis' ? '声学分析' : '房间工作台'}</h1><p><span className="status-dot" />实时更新 · {TARGET_GOALS[goalId].name} · 已放置 {panels.length} 件材料</p>{activePlanId && <span className="plan-source">方案来源：{PLAN_STAGES.find((stage) => stage.id === activePlanId)?.title ?? '自定义方案'}{planAdjusted ? ' · 已调整（保存不再标为原方案）' : ' · 原始生成布局'}</span>}{previewName && <span className="plan-source">临时试听：{previewName} · 关闭方案库恢复原布局</span>}</div>
            <div className="summary-metrics" aria-label="房间关键指标">
              <div><span>空间体积</span><strong>{sim.volumeM3.toFixed(1)}<small>m³</small></strong></div>
              <div><span>中频 RT60</span><strong>{sim.rt60MidTreated.toFixed(2)}<small>s</small></strong></div>
              <div><span>声学评分</span><strong>{sim.score}<small>/100</small></strong></div>
            </div>
          </div>

          <section className={`scene-section ${context === 'analysis' ? 'is-hidden' : ''}`} aria-label="房间三维场景">
            <div className="scene-heading"><span><Box size={15} /> 三维空间</span><span>单位 · 米</span></div>
            <RoomViewport3D room={room} panels={panels} selectedPanelId={selectedPanelId}
              reflections={sim.reflections} recommendations={sim.recommendations} hoveredHintId={hoveredHintId}
              showRays={showRays} showFloorRays={showFloorRays} showHints={showHints}
              showBassHeatmap={showBassHeatmap} heatmapFreqHz={heatmapFreqHz}
              isExpanded={isViewportExpanded} onToggleExpand={() => setIsViewportExpanded((v) => !v)}
              sceneControls={displayControls} onSelectPanel={selectPanel}
              onUpdatePanel={(updated) => setPanels((prev) => prev.map((p) => (p.id === updated.id ? updated : p)))}
              onUpdateSpeakerPos={(pos) => updateRoom({ speakerPos: pos })}
              onUpdateListenerPos={(pos) => updateRoom({ listenerPos: pos })} />
            <div className="scene-caption"><span>拖动音箱、听音点或材料，探索更好的声音。</span><button type="button" onClick={() => { navigateToContext('materials'); setMaterialTab('advice'); }}>查看布置建议 <ArrowUpRight size={14} /></button></div>
          </section>

          <section className="analysis-section" aria-label="声学分析图表">
            <div className="section-heading"><div><span className="eyebrow">声学表现</span><h2>{context === 'analysis' ? '频率、混响与反射' : '混响与频率响应'}</h2></div>{context !== 'analysis' && <button className="text-btn" type="button" onClick={() => navigateToContext('analysis')}>完整分析 <ArrowUpRight size={15} /></button>}</div>
            {chart}
            {context === 'analysis' && <div className="diagnostic-details">                  <section className="block">
                    <div className="block-head">
                      <CheckCircle2 size={12} />
                      <span>实时收音诊断分析</span>
                    </div>
                    <div className="list">
                      {sim.diagnostics.map((d, i) => (
                        <div key={i} className={`list-row tone-${d.level}`}>
                          <span className="list-main">
                            <span className="list-title">{d.title}</span>
                            <span className="list-sub">{d.detail}</span>
                          </span>
                        </div>
                      ))}
                    </div>
                  </section>

                  <section className="block">
                    <div className="block-head">
                      <Flame size={12} />
                      <span>关键早期强反射 ({earlyReflections.length})</span>
                    </div>
                    <div className="list">
                      {earlyReflections.map((r) => {
                        const tag = REFLECTION_TAG[r.status] ?? { label: r.status, tone: 'info' };
                        return (
                          <div key={r.id} className="list-row">
                            <span className="list-main">
                              <span className="list-title">
                                {r.faceLabel} · {r.speakerLabel}
                              </span>
                              <span className="list-sub">
                                {r.delayMs.toFixed(2)} ms · {r.gainDb.toFixed(1)} dB
                                {r.hitProductName ? ` · ${r.hitProductName}` : ''}
                              </span>
                            </span>
                            <span className={`tag tone-${tag.tone}`}>{tag.label}</span>
                          </div>
                        );
                      })}
                    </div>
                  </section>
</div>}
          </section>
        </main>

        {!isViewportExpanded && <aside className="inspector" aria-label={titles[context]}>
          <div className="inspector-heading"><div><span className="eyebrow">{context === 'space' ? '当前任务' : '上下文检查器'}</span><h2>{titles[context]}</h2></div>{context === 'space' && <button type="button" className="icon-btn" title="重置标准房间并清空材料" aria-label="重置标准房间并清空材料" onClick={resetStandardRoom}><RotateCcw size={17} /></button>}</div>
          <div className="inspector-body">
            {context === 'space' && <>
              <section className="inspector-section">
                <label className="control-label" htmlFor="target-goal">目标用途</label>
                <select id="target-goal" value={goalId} onChange={(e) => setGoalId(e.target.value as TargetGoalId)}>{Object.values(TARGET_GOALS).map((g) => <option value={g.id} key={g.id}>{g.name}</option>)}</select>
                <p className="field-help">目标混响 {TARGET_GOALS[goalId].rt60Min}–{TARGET_GOALS[goalId].rt60Max} s</p>
              </section>
              <section className="inspector-section"><h3>空间尺寸 <span>m</span></h3>
                <div className="dimension-grid">{([
                  ['length', '长', 'Z', 2.2, 8.5, 0.1], ['width', '宽', 'X', 2, 7.5, 0.1], ['height', '高', 'Y', 1.5, 4.2, 0.05],
                ] as const).map(([key, label, axis, min, max, step]) => <label key={key}><span><i className={`axis-${axis.toLowerCase()}`} />{label}</span><DimensionInput label={`房间${label}度（米）`} min={min} max={max} step={step} value={room[key]} onCommit={(value) => updateRoom({ [key]: value })} /></label>)}</div>
                <p className="field-help">X 宽 · Y 高 · Z 长 · 回车确认尺寸</p>
              </section>
              <details className="inspector-details"><summary>表面材质 <span>墙面 / 地面 / 顶面</span><ChevronDown size={15} /></summary><div className="details-body">{([
                ['wallMaterial', '四面墙壁'], ['floorMaterial', '地面'], ['ceilingMaterial', '天花板'],
              ] as const).map(([key, label]) => <label className="stack-field" key={key}><span>{label}</span><select value={room[key]} onChange={(e) => updateRoom({ [key]: e.target.value as BaseSurfaceMaterialId })}>{Object.values(BASE_MATERIALS).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>)}</div></details>
              <details className="inspector-details"><summary>声源与听音位 <span>{room.speakerMode === 'mono' ? '单声源' : '双音箱'}</span><ChevronDown size={15} /></summary><div className="details-body">                <div className="segmented sm wrap">
                  <button
                    type="button"
                    className={room.speakerMode === 'mono' ? 'is-active' : ''}
                    aria-pressed={room.speakerMode === 'mono'}
                    onClick={() => updateRoom({ speakerMode: 'mono' })}
                  >
                    单声源
                  </button>
                  <button
                    type="button"
                    className={room.speakerMode === 'stereo' ? 'is-active' : ''}
                    aria-pressed={room.speakerMode === 'stereo'}
                    onClick={() => updateRoom({ speakerMode: 'stereo' })}
                  >
                    双音箱
                  </button>
                  <button
                    type="button"
                    className="is-accent"
                    title="将音箱与听音位沿房间中轴对称居中，并置入 38% 黄金听音位置"
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
                  >
                    38% 黄金位
                  </button>
                  <button
                    type="button"
                    className="is-danger"
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
                    50% 死点对照
                  </button>
                </div>

                <div className="readout">
                  <span>
                    音箱 X=<b>{room.speakerPos.x.toFixed(1)}</b>m · Z=<b>{room.speakerPos.z.toFixed(2)}</b>m
                  </span>
                  <span>
                    听音位 Z=<b>{room.listenerPos.z.toFixed(2)}</b>m ·{' '}
                    <b>{((room.listenerPos.z / room.length) * 100).toFixed(0)}%</b>
                  </span>
                </div>
</div></details>
              <div className="inspector-note"><Compass size={19} /><p>先定义空间，再布置声音。<br />从「材料」添加处理，效果将实时呈现。</p></div>
              <button className="outline-btn full-width" type="button" onClick={() => navigateToContext('materials')}><Plus size={16} /> 开始布置材料</button>
            </>}

            {context === 'materials' && <>
              <div className="inspector-tabs" role="tablist" aria-label="材料任务">{([['library', '材料库'], ['advice', '推荐'], ['list', `已摆 ${panels.length}`]] as const).map(([tab, label]) => <button key={tab} type="button" role="tab" aria-selected={materialTab === tab} className={materialTab === tab ? 'is-active' : ''} onClick={() => setMaterialTab(tab)}>{label}</button>)}</div>
              {materialTab === 'library' && <>
                <div className="material-list">{Object.values(TREATMENT_CATALOG).map((item) => <button type="button" key={item.id} className={`material-item ${activeCatalogId === item.id ? 'is-selected' : ''}`} aria-pressed={activeCatalogId === item.id} onClick={() => setActiveCatalogId(item.id)}>
                  <span className={`material-preview ${item.category}`} style={{ '--material-color': item.color } as React.CSSProperties}><span /><span /><span /></span>
                  <span className="material-copy"><strong>{item.shortName}</strong><span>{Math.round(item.defaultWidth * 100)} × {Math.round(item.defaultHeight * 100)} cm · 厚 {Math.round(item.thickness * 100)} cm</span></span>{activeCatalogId === item.id && <Check size={16} />}
                </button>)}</div>
                <details className="material-info"><summary>{activeSpec.shortName} · 材料说明 <ChevronDown size={14} /></summary><p>{activeSpec.description}</p><p>{activeSpec.carAudioNote}</p></details>
                <section className="inspector-section"><h3>添加到房间</h3><div className="btn-grid">{activeSpec.cornerSnap ? ([['front', 0, '左前墙角'], ['front', 1, '右前墙角'], ['rear', 2, '左后墙角'], ['rear', 3, '右后墙角']] as const).map(([face, corner, label]) => <button type="button" key={corner} onClick={() => addPanelOnTarget(activeCatalogId, face, corner)}><Plus size={13} />{label}</button>) : activeSpec.allowedFaces.map((f) => <button key={f} type="button" onClick={() => addPanelOnTarget(activeCatalogId, f)}><Plus size={13} />{WALL_FACE_LABELS[f].split(' ')[0]}</button>)}</div></section>
                                {selectedPanel ? (
                  <div className="sub-block is-accent">
                    <div className="sub-head">
                      <span className="sub-label">已选中 {TREATMENT_CATALOG[selectedPanel.productId].shortName}</span>
                      <button
                        type="button"
                        className="ghost-btn danger"
                        onClick={() => {
                          setPanels((prev) => prev.filter((p) => p.id !== selectedPanel.id));
                          setSelectedPanelId(null);
                        }}
                      >
                        <Trash2 size={12} /> 删除
                      </button>
                    </div>
                    {TREATMENT_CATALOG[selectedPanel.productId].category === 'bass_trap' ? (
                      <div className="readout">
                        <span>
                          当前坐标低频驻波效率{' '}
                          <b>{(computeCornerPressureWeight(selectedPanel.center, room) * 100).toFixed(0)}%</b>
                        </span>
                      </div>
                    ) : null}
                    <div className="field-row">
                      <label>宽度</label>
                      <input
                        type="range"
                        aria-label="选中材料宽度"
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
                      <span className="field-val">{selectedPanel.width.toFixed(1)}m</span>
                    </div>
                    <div className="field-row">
                      <label>高度</label>
                      <input
                        type="range"
                        aria-label="选中材料高度"
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
                      <span className="field-val">{selectedPanel.height.toFixed(1)}m</span>
                    </div>
                  </div>
                ) : null}

              </>}
              {materialTab === 'advice' && <section className="block">
                <button type="button" className="primary-btn full-width" onClick={() => { if (panels.length === 0 || window.confirm(`应用推荐方案将替换现有 ${panels.length} 件材料。是否继续？`)) applyAllRecommendations(); }}><Wand2 size={15} />应用推荐方案 ({sim.recommendations.length} 件)</button>
                <p className="field-help">应用将替换当前布局。悬停建议可在场景预览安装位置。</p>
                <div className="list">{sim.recommendations.map((rec) => <div key={rec.id} className="rec-row" onMouseEnter={() => setHoveredHintId(rec.id)} onMouseLeave={() => setHoveredHintId(null)} onFocus={() => setHoveredHintId(rec.id)} onBlur={() => setHoveredHintId(null)}>
                  <div className="rec-top"><span className="swatch" style={{ background: TREATMENT_CATALOG[rec.productId].color }} /><span className="list-title">{rec.title}</span><button type="button" className="ghost-btn" onClick={() => applySingleRecommendation(rec)}><Plus size={12} />放置</button></div><p className="list-sub">{rec.reason}</p>
                </div>)}</div>
              </section>}
              {materialTab === 'list' && <section className="block">
                <div className="block-head"><span>已摆材料</span><span className="block-meta">{panels.length} 件</span>{panels.length > 0 && <button type="button" className="ghost-btn danger" onClick={clearAllPanels}><Eraser size={12} />清空</button>}</div>
                {panels.length === 0 ? <div className="empty">当前尚未放置声学材料。切换「材料库」手动添加，或在「推荐」中应用建议方案。</div> : <>
                  <div className="material-totals">{Array.from(materialCounts.entries()).map(([pid, info]) => <div className="list-row" key={pid}><span className="swatch" style={{ background: TREATMENT_CATALOG[pid].color }} /><span className="list-main"><span className="list-title">{TREATMENT_CATALOG[pid].shortName}</span><span className="list-sub">{info.area.toFixed(1)} m²</span></span><span className="tag">{info.count} 块</span></div>)}</div>
                  <h3 className="placed-heading">选择材料以编辑</h3><div className="placed-items">{panels.map((p, i) => <button key={p.id} type="button" className={selectedPanelId === p.id ? 'is-active' : ''} onClick={() => { setSelectedPanelId(p.id); setMaterialTab('library'); }}><span>{TREATMENT_CATALOG[p.productId].shortName} {i + 1}</span><small>{WALL_FACE_LABELS[p.face].split(' ')[0]}</small><ArrowUpRight size={14} /></button>)}</div>
                </>}
              </section>}
            </>}

            {context === 'analysis' && <>
              <section className="inspector-section"><h3>方案指标</h3><dl className="analysis-metrics"><div><dt>综合达标度</dt><dd>{sim.score}<small>/100</small></dd></div><div><dt>中频混响 RT60</dt><dd>{sim.rt60MidTreated.toFixed(2)}<small>s</small></dd></div><div><dt>清晰度 C50</dt><dd>{sim.clarityC50Treated.toFixed(1)}<small>dB</small></dd></div><div><dt>估算隔声 STC</dt><dd>{sim.estimatedStcDb.toFixed(0)}<small>dB</small></dd></div><div><dt>隔声增益</dt><dd>+{sim.stcGainDb.toFixed(1)}<small>dB</small></dd></div><div><dt>施罗德频率</dt><dd>{sim.schroederFreqHz.toFixed(0)}<small>Hz</small></dd></div></dl></section>
              <div className="inspector-note"><ChartNoAxesCombined size={20} /><p>在频响图点选驻波频率，即可回到空间查看对应热力分布。</p></div>
              <button className="outline-btn full-width" type="button" onClick={() => { navigateToContext('materials'); setMaterialTab('advice'); }}>查看改善建议 <ArrowUpRight size={15} /></button>
            </>}

            {context === 'listen' && <>
              <section className="inspector-section"><h3>参考音源</h3><label className="stack-field"><span>试听内容</span><select value={sourceKind} onChange={(e) => handleChangeSource(e.target.value as AudioSourceKind)}>{AUDIO_SOURCE_OPTIONS.map((opt) => <option key={opt.id} value={opt.id}>{opt.label}</option>)}{customFileName && <option value="custom">本地：{customFileName}</option>}</select></label>
                <button type="button" className="outline-btn full-width" onClick={() => fileInputRef.current?.click()}><Upload size={15} />上传本地音频</button>{customFileName && <p className="field-help file-name">{customFileName}</p>}
              </section>
              <section className="inspector-section"><h3>对比模式</h3><div className="listen-modes">{([['dry', '干声原音', '不叠加房间响应'], ['untreated', '空房混响', '未放置材料的空间'], ['treated', '当前方案', '应用当前全部声学处理']] as const).map(([mode, label, detail]) => <button key={mode} type="button" className={listenMode === mode ? 'is-active' : ''} aria-pressed={listenMode === mode} onClick={() => handleChangeListenMode(mode)}><span><strong>{label}</strong><small>{detail}</small></span>{listenMode === mode && <CheckCircle2 size={17} />}</button>)}</div></section>
              <button type="button" className="primary-btn full-width" onClick={handleTogglePlay}>{isPlaying ? <Volume2 size={17} /> : <Headphones size={17} />}{isPlaying ? '停止收音试听' : '开始收音试听'}</button>
              <p className="field-help">建议佩戴耳机，切换模式听取空间处理前后的差异。模拟试听不替代现场测量。</p>
            </>}
          </div>
        </aside>}
      </div>
      {libraryTab && <PlanLibrary room={room} panels={panels} goalId={goalId} planId={planAdjusted ? undefined : activePlanId}
        initialTab={libraryTab} previewName={previewName} isPlaying={isPlaying}
        listenDescription={`${customFileName && sourceKind === 'custom' ? customFileName : AUDIO_SOURCE_OPTIONS.find((source) => source.id === sourceKind)?.label ?? sourceKind} / ${{ dry: '干声原音', untreated: '空房混响', treated: '当前方案' }[listenMode]}`}
        onClose={closeLibrary} onApply={applyStage} onScenario={loadScenarioPreset} onLoad={loadSavedDesign}
        onPreview={previewDesign} onEndPreview={endPreview} onTogglePlay={handleTogglePlay} />}
      <input ref={fileInputRef} type="file" accept="audio/*" hidden onChange={handleUploadAudio} />
    </div>
  );
};

export default App;
