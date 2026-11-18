import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowUpRight, Layers, X } from 'lucide-react';
import { PLAN_STAGES } from '../plans/catalog';
import { generateStagePlan } from '../plans/generatePlan';
import { TREATMENT_CATALOG, TARGET_GOALS } from '../acoustics/materials';
import type { PlacedPanel, RoomConfig, TargetGoalId } from '../acoustics/types';
import { ProjectLibrary } from './ProjectLibrary';
import type { SavedDesign } from '../projects/storage';

type StageId = (typeof PLAN_STAGES)[number]['id'];
export type ScenarioId = 'bare_concrete' | 'foam_mistake' | 'pro_studio' | 'car_cabin_sim';
export type LibraryTab = 'stages' | 'scenarios' | 'projects';
interface Props {
  room: RoomConfig; panels: PlacedPanel[]; goalId: TargetGoalId; planId?: string;
  initialTab: LibraryTab; previewName: string | null; isPlaying: boolean; listenDescription: string;
  onClose: () => void; onApply: (panels: PlacedPanel[], goalId: TargetGoalId, planId: string) => void;
  onScenario: (id: ScenarioId) => void; onLoad: (design: SavedDesign) => void;
  onPreview: (design: SavedDesign, label: string, goal: TargetGoalId) => void;
  onEndPreview: () => void; onTogglePlay: () => void;
}
const SCENARIOS: { id: ScenarioId; title: string; summary: string; tag: string }[] = [
  { id: 'bare_concrete', title: '毛坯水泥房', summary: '从硬表面空房开始，观察混响与强反射。', tag: '空房基线' },
  { id: 'foam_mistake', title: '满墙薄棉', summary: '高频被吸收，并不代表低频得到控制。', tag: '误区对照 · Hi-Fi' },
  { id: 'pro_studio', title: '标准科学方案', summary: '标准房间与引擎推荐布局的完整案例。', tag: '混音参考' },
  { id: 'car_cabin_sim', title: '类车载偏置声场', summary: '小尺度、偏置听音位的声场实验。', tag: '座舱实验' },
];
function materialShape(panels: PlacedPanel[]) {
  return JSON.stringify(panels.map(({ id: _id, ...p }) => p));
}
export const PlanLibrary: React.FC<Props> = (props) => {
  const { room, panels, onClose, onEndPreview } = props;
  const dialog = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState<LibraryTab>(props.initialTab);
  const [selected, setSelected] = useState<StageId | null>(null);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = dialog.current;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    element?.showModal();
    return () => { document.body.style.overflow = overflow; element?.close(); previous?.focus(); };
  }, []);
  const result = useMemo(() => {
    if (!selected) return null;
    try {
      const index = PLAN_STAGES.findIndex((s) => s.id === selected);
      return { plan: generateStagePlan(room, selected), previous: index > 0 ? generateStagePlan(room, PLAN_STAGES[index - 1].id) : null };
    } catch (error) { return { error: error instanceof Error ? error.message : '生成失败，请检查房间参数。' }; }
  }, [room, selected]);
  const plan = result && 'plan' in result ? result.plan : undefined;
  const previous = result && 'previous' in result ? result.previous : undefined;
  const totals = useMemo(() => {
    const map = new Map<string, { name: string; count: number; area: number }>();
    for (const p of plan?.panels ?? []) {
      const item = map.get(p.productId) ?? { name: TREATMENT_CATALOG[p.productId].shortName, count: 0, area: 0 };
      map.set(p.productId, { ...item, count: item.count + 1, area: item.area + p.width * p.height });
    }
    return Array.from(map.values());
  }, [plan]);
  const switchTab = (next: LibraryTab) => { onEndPreview(); setTab(next); setSelected(null); setNotice(''); };
  return <dialog ref={dialog} className="library-dialog" aria-labelledby="library-title" onCancel={(e) => { e.preventDefault(); onClose(); }} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="library-shell">
      <header className="library-header"><div><span className="eyebrow">为当前空间，找到下一步</span><h2 id="library-title"><Layers size={22} />方案库</h2></div><button type="button" className="icon-btn" aria-label="关闭方案库" onClick={onClose} autoFocus><X size={19} /></button></header>
      <div className="library-tabs" role="tablist" aria-label="方案库分类">{([['stages', '升级方案'], ['scenarios', '场景案例'], ['projects', '我的方案']] as const).map(([id, text]) => <button type="button" key={id} id={`library-tab-${id}`} role="tab" aria-selected={id === tab} aria-controls={`library-panel-${id}`} tabIndex={id === tab ? 0 : -1} className={id === tab ? 'is-active' : ''} onClick={() => switchTab(id)} onKeyDown={(e) => { const ids: LibraryTab[] = ['stages', 'scenarios', 'projects']; const i = ids.indexOf(tab); if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) { e.preventDefault(); const next = e.key === 'Home' ? ids[0] : e.key === 'End' ? ids[2] : ids[(i + (e.key === 'ArrowRight' ? 1 : 2)) % 3]; switchTab(next); document.getElementById(`library-tab-${next}`)?.focus(); } }}>{text}</button>)}</div>
      <div className="library-scroll" role="tabpanel" id={`library-panel-${tab}`} aria-labelledby={`library-tab-${tab}`}>
        {notice && <p className="library-feedback" role="status">{notice}</p>}
        {tab === 'stages' && <>
          {!selected ? <><div className="library-intro"><h3>五个阶段，一间你的房间。</h3><p>保留尺寸、材质与摆位，只为当前空间生成材料布局。</p><span>{room.length.toFixed(1)} × {room.width.toFixed(1)} × {room.height.toFixed(1)} m · {panels.length} 件现有材料</span></div>
            <div className="stage-grid">{PLAN_STAGES.map((stage) => <button type="button" className={`stage-card stage-${stage.step}`} key={stage.id} onClick={() => { setSelected(stage.id); setNotice(''); }}><span className="stage-number">0{stage.step}<ArrowUpRight size={18} /></span><h3>{stage.title}</h3><p>{stage.summary}</p><span className="library-tags">{stage.focus.map((focus) => <span key={focus}>{focus}</span>)}</span><span className="stage-cta">查看当前房间方案 →</span></button>)}</div>
            <p className="library-footnote">阶段不是专业等级认证。更高阶段不保证材料更多或分数更高；母带监听参考仍需现场测量与验证。</p></> : <>
            <button type="button" className="text-btn" onClick={() => setSelected(null)}><ArrowLeft size={15} />全部升级方案</button>
            {result && 'error' in result && <p role="alert" className="library-error">无法生成方案：{result.error}</p>}
            {plan && <div className="stage-detail"><div className="detail-title"><div><span className="eyebrow">阶段 0{plan.stage.step} · {TARGET_GOALS[plan.stage.goalId].name}</span><h3>{plan.stage.title}</h3><p>{plan.stage.summary}</p></div><button type="button" className="primary-btn" onClick={() => { if (panels.length > 0 && !window.confirm(`应用「${plan.stage.title}」将替换现有 ${panels.length} 件材料，并切换目标用途；房间尺寸、材质和摆位保持不变。继续？`)) return; props.onApply(plan.panels, plan.stage.goalId, plan.stage.id); setNotice(`已应用「${plan.stage.title}」。当前房间保持不变。`); }}>应用到当前房间</button></div>
              <div className="plan-metrics"><div><span>材料件数</span><strong>{plan.panels.length}<small> 件</small></strong></div><div><span>中频 RT60</span><strong>{plan.simulation.rt60MidTreated.toFixed(2)}<small> s</small></strong></div><div><span>当前用途评分</span><strong>{plan.simulation.score}<small> /100</small></strong></div></div>
              <section className="upgrade-note"><h4>{previous ? '相对上一阶段' : '从当前空间起步'}</h4><p>{plan.stage.upgrade}</p>{previous && <p>{materialShape(previous.panels) === materialShape(plan.panels) ? (plan.stage.id === 'mastering' ? '与上一阶段物料布局相同，不编造处理差异。重点转向测量和验证。' : '与上一阶段物料布局相同：当前房间未新增材料，请查看生成说明与适用边界。') : `上一阶段 ${previous.panels.length} 件 → 本阶段 ${plan.panels.length} 件；中频 RT60 ${previous.simulation.rt60MidTreated.toFixed(2)} → ${plan.simulation.rt60MidTreated.toFixed(2)} s。`}</p>}<small>用途映射并非认证；不同用途的评分不直接比较。RT60 需结合用途目标范围，不是越低越好。</small></section>
              <div className="detail-columns"><section><h4>当前房间材料汇总</h4><div className="plan-materials">{totals.map((item) => <div key={item.name}><strong>{item.name}</strong><span>{item.count} 件 · {item.area.toFixed(2)} m²</span></div>)}</div><p className="field-help">面积按面板宽 × 高汇总，不代表净墙面覆盖率。</p></section><section><h4>生成说明</h4><ul className="library-bullets">{plan.notes.map((note, i) => <li key={i}>{note}</li>)}</ul></section></div>
              <details className="library-limits" open={plan.stage.id === 'mastering'}><summary>适用边界与未达标提醒</summary><p>母带监听参考不是母带室认证。本模型不能替代测量、隔声测试与专业验收。</p><ul className="library-bullets">{plan.stage.limitations.map((limit, i) => <li key={i}>{limit}</li>)}{plan.simulation.diagnostics.filter((d) => d.level === 'bad' || d.level === 'warn').map((d, i) => <li key={`diagnostic-${i}`}>{d.title}：{d.detail}</li>)}</ul></details>
            </div>}
          </>}
        </>}
        {tab === 'scenarios' && <><div className="library-intro"><h3>换个场景，理解声音。</h3><p>完整案例会替换尺寸、表面材质、音箱 / 听音位、目标和全部材料，不是当前房间的升级方案。</p></div><div className="scenario-grid">{SCENARIOS.map((scenario) => <article className="scenario-card" key={scenario.id}><span className="tag">{scenario.tag}</span><h3>{scenario.title}</h3><p>{scenario.summary}</p><p className="scenario-warning">替换房间尺寸 / 材质 / 摆位 / 材料</p><button type="button" className="outline-btn" onClick={() => props.onScenario(scenario.id)}>加载完整案例 <ArrowUpRight size={14} /></button></article>)}</div></>}
        {tab === 'projects' && <ProjectLibrary room={room} panels={panels} goalId={props.goalId} planId={props.planId} onLoad={props.onLoad} onPreview={props.onPreview} onEndPreview={onEndPreview} previewName={props.previewName} isPlaying={props.isPlaying} onTogglePlay={props.onTogglePlay} listenDescription={props.listenDescription} />}
      </div>
    </div>
  </dialog>;
};
