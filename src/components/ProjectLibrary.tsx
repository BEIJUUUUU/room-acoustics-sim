import React, { useMemo, useState } from 'react';
import { Headphones, Save, Trash2 } from 'lucide-react';
import type { PlacedPanel, RoomConfig, TargetGoalId } from '../acoustics/types';
import { TARGET_GOALS } from '../acoustics/materials';
import { createDesignSnapshot, loadDesigns, saveDesigns } from '../projects/storage';
import type { SavedDesign } from '../projects/storage';
import { compareRoomCompatibility, evaluateDesignComparison } from '../projects/comparison';

interface Props {
  room: RoomConfig; panels: PlacedPanel[]; goalId: TargetGoalId; planId?: string;
  previewName: string | null; isPlaying: boolean; listenDescription: string;
  onLoad: (design: SavedDesign) => void;
  onPreview: (design: SavedDesign, label: string, goal: TargetGoalId) => void;
  onEndPreview: () => void; onTogglePlay: () => void;
}
const describeError = (error: unknown) => error instanceof Error ? error.message : '本地存储不可用，请检查浏览器权限。';
const readLibrary = () => { try { return loadDesigns(); } catch (error) { return { designs: [] as SavedDesign[], error: describeError(error) }; } };
const numberText = (value: number, digits = 2) => Number.isFinite(value) ? value.toFixed(digits) : '—';
const changeText = (a: number, b: number, digits = 2) => {
  const delta = b - a;
  return !Number.isFinite(delta) ? '无法比较' : Math.abs(delta) < 0.5 * 10 ** -digits ? '持平' : `${delta > 0 ? '↑ +' : '↓ '}${delta.toFixed(digits)}`;
};
export const ProjectLibrary: React.FC<Props> = (props) => {
  const [library, setLibrary] = useState(readLibrary);
  const [name, setName] = useState('我的听音室方案');
  const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null);
  const [aId, setAId] = useState('');
  const [bId, setBId] = useState('');
  const [compareGoal, setCompareGoal] = useState<TargetGoalId>(props.goalId);
  const a = library.designs.find((design) => design.id === aId);
  const b = library.designs.find((design) => design.id === bId);
  const comparison = useMemo(() => {
    if (!a || !b || a.id === b.id) return null;
    const compatibility = compareRoomCompatibility(a.room, b.room);
    if (!compatibility.compatible) return { ...compatibility, goalId: compareGoal };
    return evaluateDesignComparison(a, b, compareGoal);
  }, [a, b, compareGoal]);
  const persist = (next: SavedDesign[], success: string) => {
    try {
      const saved = saveDesigns(next);
      if (!saved.ok) { setFeedback({ error: true, text: saved.error ?? '保存失败，未更改列表。' }); return false; }
      const reloaded = readLibrary();
      setLibrary(reloaded);
      setFeedback({ error: !!reloaded.error, text: reloaded.error ? `写入后无法重新读取：${reloaded.error}` : success });
      return !reloaded.error;
    } catch (error) { setFeedback({ error: true, text: describeError(error) }); return false; }
  };
  const saveCurrent = (event: React.FormEvent) => {
    event.preventDefault();
    if (library.error || props.previewName) return;
    if (!name.trim()) { setFeedback({ error: true, text: '请先填写非空方案名称。' }); return; }
    if (library.designs.length >= 20) { setFeedback({ error: true, text: '已达到20个方案上限，请先删除不需要的方案。' }); return; }
    try {
      const snapshot = createDesignSnapshot(name.trim(), props.room, props.panels, props.goalId, props.planId);
      persist([...library.designs, snapshot], `「${snapshot.name}」已保存到此浏览器。`);
    } catch (error) { setFeedback({ error: true, text: describeError(error) }); }
  };
  const choose = (side: 'a' | 'b', id: string) => { props.onEndPreview(); (side === 'a' ? setAId : setBId)(id); };
  const rows = comparison?.compatible && 'a' in comparison && comparison.a && comparison.b ? [
    { label: 'RT60', unit: 's', a: comparison.a.rt60MidTreated, b: comparison.b.rt60MidTreated, note: `目标 ${TARGET_GOALS[compareGoal].rt60Min}–${TARGET_GOALS[compareGoal].rt60Max} s` },
    { label: 'C50', unit: 'dB', a: comparison.a.clarityC50Treated, b: comparison.b.clarityC50Treated, note: '清晰度；需结合听音用途' },
    { label: 'BR', unit: '', a: comparison.a.bassRatio, b: comparison.b.bassRatio, note: '低 / 中频混响比；非越低越好' },
    { label: '评分', unit: '/100', a: comparison.a.score, b: comparison.b.score, note: '统一目标下的模型达标度' },
  ] : [];
  return <div className="project-library">
    <div className="library-intro"><h3>把每次探索，留在本地。</h3><p>仅手动保存房间与材料，不保存或上传音频，不自动复写工作区。</p></div>
    {library.error && <div className="library-error" role="alert"><strong>方案库只读：{library.error}</strong><p>为保护原始数据，保存和删除已禁用，不会用空库覆盖。请保留浏览器存储并检查数据 / 访问权限后重试。</p><button type="button" className="outline-btn" onClick={() => { props.onEndPreview(); setLibrary(readLibrary()); setAId(''); setBId(''); setFeedback(null); }}>重新读取</button></div>}
    {feedback && <p role={feedback.error ? 'alert' : 'status'} className={feedback.error ? 'library-error' : 'library-feedback'}>{feedback.text}</p>}
    <form className="save-design" onSubmit={saveCurrent}><label htmlFor="design-name">保存当前工作布局 <span>{library.designs.length} / 20 个</span><input id="design-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder="为这次方案命名" required /></label><button type="submit" className="primary-btn" disabled={!!library.error || !!props.previewName || library.designs.length >= 20 || !name.trim()}><Save size={16} />保存快照</button><p>{props.previewName ? '正在临时预览，先返回原工作布局再保存。' : library.designs.length >= 20 ? '已达20个上限；删除后可继续保存，不会覆盖旧方案。' : `${props.panels.length} 件材料 · ${TARGET_GOALS[props.goalId].name} · 仅此浏览器本地保存`}</p></form>
    <section className="saved-section" aria-labelledby="saved-title"><div className="library-section-title"><h4 id="saved-title">已保存的方案</h4><span>{library.designs.length} / 20</span></div>
      {library.designs.length === 0 ? <div className="library-empty"><Save size={24} /><h4>{library.error ? '暂时无法读取方案' : '还没有保存的方案'}</h4><p>{library.error ? '修复读取问题前不会写入任何数据。' : '填写名称并保存，之后可随时载入，或选两份快照做公平 A/B。'}</p></div> : <div className="saved-grid">{library.designs.map((design) => <article key={design.id} className="saved-card"><h4 title={design.name}>{design.name}</h4><time dateTime={design.createdAt}>{new Date(design.createdAt).toLocaleString('zh-CN')}</time><p>{design.panels.length} 件材料 · {TARGET_GOALS[design.goalId].name}</p><p className="saved-size">{design.room.length} × {design.room.width} × {design.room.height} m{design.planId ? ' · 有方案来源' : ''}</p><div className="saved-actions"><button type="button" className="outline-btn" disabled={!!props.previewName} onClick={() => { if (window.confirm(`载入「${design.name}」将替换当前房间（尺寸、材质、摆位）、目标用途和全部材料。未保存的修改不会自动保存。是否继续？`)) { props.onLoad(design); setFeedback({ error: false, text: `已载入「${design.name}」。` }); } }}>载入工作区</button><button type="button" className="icon-btn danger" disabled={!!library.error} aria-label={`删除${design.name}`} title="删除方案" onClick={() => { if (!window.confirm(`永久删除本地方案「${design.name}」？此操作不可撤销。`)) return; props.onEndPreview(); if (persist(library.designs.filter((d) => d.id !== design.id), `已删除「${design.name}」。`)) { if (aId === design.id) setAId(''); if (bId === design.id) setBId(''); } }}><Trash2 size={15} /></button></div></article>)}</div>}
    </section>
    <section className="comparison-section" aria-labelledby="comparison-title"><div className="library-section-title"><div><span className="eyebrow">公平比较 · 不会自动应用</span><h4 id="comparison-title">A / B 方案对比</h4></div><span>选择两个不同快照</span></div><div className="comparison-selectors">{(['a', 'b'] as const).map((side) => <label key={side}>方案 {side.toUpperCase()}<select aria-label={`比较方案${side.toUpperCase()}`} value={side === 'a' ? aId : bId} onChange={(e) => choose(side, e.target.value)}><option value="">请选择快照</option>{library.designs.map((d) => <option key={d.id} value={d.id} disabled={d.id === (side === 'a' ? bId : aId)}>{d.name}</option>)}</select></label>)}</div>
      {!comparison && <p className="comparison-empty">先选 A，再选不同的 B。仅同一房间、表面材质与音箱 / 听音位完全一致时才能对比。</p>}
      {comparison && !comparison.compatible && <div role="alert" className="library-error"><strong>不是同一房间，已禁用指标比较与 A/B 载入试听。</strong><ul>{comparison.differences.map((difference, i) => <li key={i}>{difference}</li>)}</ul><p>请在上方选择同一房间的其他快照；不会替你强行比较。</p></div>}
      {comparison?.compatible && a && b && <><label className="comparison-goal">统一评估用途<select value={compareGoal} onChange={(e) => { props.onEndPreview(); setCompareGoal(e.target.value as TargetGoalId); }}>{Object.values(TARGET_GOALS).map((goal) => <option value={goal.id} key={goal.id}>{goal.name}</option>)}</select></label><p className="comparison-caption">同一房间，统一以「{TARGET_GOALS[compareGoal].name}」评估</p>
        <div className="comparison-table" role="table" aria-label="统一目标声学指标对比"><div className="comparison-row comparison-table-head" role="row"><span role="columnheader">指标</span><span role="columnheader" title={a.name}>A · {a.name}</span><span role="columnheader" title={b.name}>B · {b.name}</span><span role="columnheader">B 相对 A</span></div>{rows.map((row) => <div className="comparison-row" role="row" key={row.label}><div role="cell"><strong>{row.label}</strong><small>{row.note}</small></div><span role="cell">{numberText(row.a)} <small>{row.unit}</small></span><span role="cell">{numberText(row.b)} <small>{row.unit}</small></span><span role="cell" className="comparison-delta">{changeText(row.a, row.b)}</span></div>)}</div><p className="field-help">箭头只表示数值变化方向，不代表改善。模拟结果不是现场测量或等级认证。</p>
        <div className="preview-panel"><div><strong>{props.previewName ? `当前试听布局：${props.previewName}` : '临时试听，不丢原布局'}</strong><p>沿用当前音源与模式（{props.listenDescription}）。首次试听保留原布局，返回 / 关闭 / 更换快照即恢复。</p></div><div className="preview-actions"><button type="button" className="outline-btn" onClick={() => props.onPreview(a, `A · ${a.name}`, compareGoal)}><Headphones size={15} />试听 A</button><button type="button" className="outline-btn" onClick={() => props.onPreview(b, `B · ${b.name}`, compareGoal)}><Headphones size={15} />试听 B</button><button type="button" className="outline-btn" disabled={!props.previewName} onClick={props.onEndPreview}>返回原工作布局</button><button type="button" className="primary-btn" onClick={props.onTogglePlay}>{props.isPlaying ? '停止播放' : '开始播放'}</button></div>{props.previewName && <p className="field-help">试听仅切换布局，不自动开始或停止音频；干声模式下不会听到布局差异。</p>}</div>
      </>}
    </section>
  </div>;
};
