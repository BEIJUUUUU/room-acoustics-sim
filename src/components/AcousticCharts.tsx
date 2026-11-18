import React, { useState } from 'react';
import { TARGET_GOALS } from '../acoustics/materials';
import { OCTAVE_BANDS, SimulationResult, TargetGoalId } from '../acoustics/types';

interface AcousticChartsProps {
  sim: SimulationResult;
  goalId: TargetGoalId;
  panelsCount: number;
  onPickModeFreq: (freqHz: number) => void;
}

export const AcousticCharts: React.FC<AcousticChartsProps> = ({
  sim,
  goalId,
  panelsCount,
  onPickModeFreq,
}) => {
  const [activeTab, setActiveTab] = useState<'rt60' | 'spl' | 'etc'>('rt60');
  const goal = TARGET_GOALS[goalId];

  return (
    <div className="charts-panel">
      <div className="charts-header">
        <div className="chart-tabs">
          <button
            type="button"
            className={`chart-tab ${activeTab === 'rt60' ? 'active' : ''}`}
            onClick={() => setActiveTab('rt60')}
          >
            RT60 混响曲线
          </button>
          <button
            type="button"
            className={`chart-tab ${activeTab === 'spl' ? 'active' : ''}`}
            onClick={() => setActiveTab('spl')}
          >
            REW 频响 & 驻波
          </button>
          <button
            type="button"
            className={`chart-tab ${activeTab === 'etc' ? 'active' : ''}`}
            onClick={() => setActiveTab('etc')}
          >
            ETC 反射脉冲
          </button>
        </div>

        <div className="chart-quick-meta">
          f_s = {sim.schroederFreqHz.toFixed(0)} Hz
        </div>
      </div>

      {activeTab === 'rt60' && (
        <RT60Chart
          sim={sim}
          rtMin={goal.rt60Min}
          rtMax={goal.rt60Max}
          goalName={goal.name}
          hasPanels={panelsCount > 0}
        />
      )}
      {activeTab === 'spl' && (
        <ModalSplChart
          sim={sim}
          hasPanels={panelsCount > 0}
          onPickModeFreq={onPickModeFreq}
        />
      )}
      {activeTab === 'etc' && <EtcReflectionChart sim={sim} hasPanels={panelsCount > 0} />}
    </div>
  );
};

const RT60Chart: React.FC<{
  sim: SimulationResult;
  rtMin: number;
  rtMax: number;
  goalName: string;
  hasPanels: boolean;
}> = ({ sim, rtMin, rtMax, goalName, hasPanels }) => {
  const W = 520;
  const H = 180;
  const padL = 46;
  const padR = 22;
  const padT = 22;
  const padB = 28;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const maxY = Math.max(0.8, ...sim.rt60Untreated, ...sim.rt60Treated) * 1.15;
  const toX = (idx: number) => padL + (idx / 5) * plotW;
  const toY = (val: number) => padT + plotH - Math.min(val / maxY, 1) * plotH;

  const rawPoints = sim.rt60Untreated.map((v, i) => `${toX(i)},${toY(v)}`).join(' ');
  const treatedPoints = sim.rt60Treated.map((v, i) => `${toX(i)},${toY(v)}`).join(' ');

  const bandTop = toY(rtMax);
  const bandBottom = toY(rtMin);
  const yTicks = [
    0,
    Number((maxY * 0.33).toFixed(2)),
    Number((maxY * 0.66).toFixed(2)),
    Number(maxY.toFixed(2)),
  ];

  return (
    <div className="svg-chart-box">
      <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg">
        <rect
          x={padL}
          y={bandTop}
          width={plotW}
          height={Math.max(3, bandBottom - bandTop)}
          fill="rgba(16, 185, 129, 0.16)"
          stroke="rgba(16, 185, 129, 0.45)"
          strokeDasharray="4 3"
        />
        <text x={W - padR - 4} y={Math.max(padT + 11, bandTop + 12)} textAnchor="end" fill="#34d399" fontSize="10.5">
          {goalName}目标带 ({rtMin}~{rtMax}s)
        </text>

        {yTicks.map((tick, idx) => (
          <g key={idx}>
            <line x1={padL} y1={toY(tick)} x2={W - padR} y2={toY(tick)} stroke="#1e293b" strokeWidth="1" />
            <text x={padL - 6} y={toY(tick) + 4} textAnchor="end" fill="#94a3b8" fontSize="10.5">
              {tick.toFixed(1)}s
            </text>
          </g>
        ))}

        {/* 空房基准曲线 */}
        <polyline
          fill="none"
          stroke="#f87171"
          strokeWidth={hasPanels ? '2' : '2.6'}
          strokeDasharray={hasPanels ? '5 4' : undefined}
          opacity={hasPanels ? '0.78' : '0.95'}
          points={rawPoints}
        />

        {/* 仅在放置了声学材料时叠加绘制处理后蓝线，避免0件时完全重叠误导 */}
        {hasPanels && (
          <polyline fill="none" stroke="#38bdf8" strokeWidth="2.8" points={treatedPoints} />
        )}

        {OCTAVE_BANDS.map((hz, i) => {
          const x = toX(i);
          const activeVal = hasPanels ? sim.rt60Treated[i] : sim.rt60Untreated[i];
          const yAct = toY(activeVal);
          return (
            <g key={hz}>
              {hasPanels && (
                <circle cx={x} cy={toY(sim.rt60Untreated[i])} r="3" fill="#f87171" opacity="0.7" />
              )}
              <circle
                cx={x}
                cy={yAct}
                r="4.5"
                fill={hasPanels ? '#38bdf8' : '#f87171'}
                stroke="#0f172a"
                strokeWidth="1.5"
              />
              <text x={x} y={Math.max(13, yAct - 8)} textAnchor="middle" fill="#f1f5f9" fontSize="11" fontWeight="600">
                {activeVal.toFixed(2)}s
              </text>
              <text x={x} y={H - 7} textAnchor="middle" fill="#cbd5e1" fontSize="11">
                {hz >= 1000 ? `${hz / 1000}k` : `${hz}`}Hz
              </text>
            </g>
          );
        })}
      </svg>
      <div className="chart-sub-legend">
        <span><i style={{ background: '#f87171' }} /> 空房基准 RT60</span>
        {hasPanels ? (
          <span><i style={{ background: '#38bdf8' }} /> 放置材料后 RT60</span>
        ) : (
          <span className="muted-note">（当前未放置声学材料，放置后将显示蓝线对比）</span>
        )}
        <span>低频比 BR = {sim.bassRatio.toFixed(2)}</span>
      </div>
    </div>
  );
};

const ModalSplChart: React.FC<{
  sim: SimulationResult;
  hasPanels: boolean;
  onPickModeFreq: (freqHz: number) => void;
}> = ({ sim, hasPanels, onPickModeFreq }) => {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const W = 520;
  const H = 180;
  const padL = 46;
  const padR = 18;
  const padT = 24; // 留出顶部独立分界标签带，绝不与曲线重叠！
  const padB = 28;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const fMin = 30;
  const fMax = 500;
  const toX = (f: number) => padL + (Math.log10(f / fMin) / Math.log10(fMax / fMin)) * plotW;
  const toY = (db: number) => padT + plotH * 0.5 - (Math.max(-16, Math.min(16, db)) / 16) * (plotH * 0.5);

  const rawPath = sim.freqResponse
    .map((pt, i) => `${i === 0 ? 'M' : 'L'}${toX(pt.freqHz).toFixed(1)},${toY(pt.untreatedSplDb).toFixed(1)}`)
    .join(' ');
  const treatedPath = sim.freqResponse
    .map((pt, i) => `${i === 0 ? 'M' : 'L'}${toX(pt.freqHz).toFixed(1)},${toY(pt.treatedSplDb).toFixed(1)}`)
    .join(' ');

  const fTicks = [30, 50, 80, 125, 200, 300, 500];
  const dbTicks = [-15, -7.5, 0, 7.5, 15];
  const fsClamped = Math.max(fMin, Math.min(fMax, sim.schroederFreqHz));
  const fsX = toX(fsClamped);

  const hoveredSample = hoverIdx !== null ? sim.freqResponse[hoverIdx] : null;

  const handleSvgMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const relX = ((e.clientX - rect.left) / rect.width) * W;
    const norm = Math.max(0, Math.min(1, (relX - padL) / plotW));
    const idx = Math.round(norm * (sim.freqResponse.length - 1));
    setHoverIdx(idx);
  };

  return (
    <div className="svg-chart-box">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="chart-svg"
        onMouseMove={handleSvgMove}
        onMouseLeave={() => setHoverIdx(null)}
      >
        {dbTicks.map((db) => (
          <g key={db}>
            <line
              x1={padL}
              y1={toY(db)}
              x2={W - padR}
              y2={toY(db)}
              stroke={db === 0 ? '#334155' : '#1e293b'}
              strokeWidth={db === 0 ? '1.4' : '1'}
            />
            <text x={padL - 6} y={toY(db) + 3.5} textAnchor="end" fill="#94a3b8" fontSize="10.5">
              {db > 0 ? `+${db}` : db}
            </text>
          </g>
        ))}

        {fTicks.map((f) => (
          <g key={f}>
            <line x1={toX(f)} y1={padT} x2={toX(f)} y2={H - padB} stroke="#162033" />
            <text x={toX(f)} y={H - 7} textAnchor="middle" fill="#cbd5e1" fontSize="10.5">
              {f}Hz
            </text>
          </g>
        ))}

        {/* 施罗德频率分界线 —— 文字置于顶部 padT 上方安全区，彻底杜绝与曲线重叠 */}
        <line
          x1={fsX}
          y1={padT - 4}
          x2={fsX}
          y2={H - padB}
          stroke="#f59e0b"
          strokeDasharray="3 3"
          opacity="0.75"
        />
        <text
          x={Math.min(W - padR - 4, Math.max(padL + 4, fsX))}
          y={13}
          textAnchor={fsX > W * 0.65 ? 'end' : fsX < W * 0.32 ? 'start' : 'middle'}
          fill="#fbbf24"
          fontSize="10.5"
          fontWeight="600"
        >
          ← 低频驻波区 | f_s={sim.schroederFreqHz.toFixed(0)}Hz | 几何反射区 →
        </text>

        {/* 底部轴向驻波刻度（点击联动 3D 地面热力图） */}
        {sim.modes
          .filter((m) => m.type === 'axial' && m.freqHz >= fMin && m.freqHz <= 260)
          .map((m, idx) => (
            <g
              key={idx}
              style={{ cursor: 'pointer' }}
              onClick={() => onPickModeFreq(m.freqHz)}
            >
              <title>{`点击在3D地面查看 ${m.freqHz.toFixed(0)}Hz (${m.axisLabel}) 驻波分布`}</title>
              <line
                x1={toX(m.freqHz)}
                y1={H - padB - 9}
                x2={toX(m.freqHz)}
                y2={H - padB}
                stroke="#f59e0b"
                strokeWidth="2.4"
              />
            </g>
          ))}

        {/* 空房基准曲线 */}
        <path
          d={rawPath}
          fill="none"
          stroke="#f87171"
          strokeWidth={hasPanels ? '1.8' : '2.4'}
          strokeDasharray={hasPanels ? '4 3' : undefined}
          opacity={hasPanels ? '0.78' : '0.95'}
        />

        {/* 仅在放置了材料时叠加蓝青色处理后曲线 */}
        {hasPanels && <path d={treatedPath} fill="none" stroke="#22d3ee" strokeWidth="2.4" />}

        {/* 交互式十字测量光标 */}
        {hoveredSample && (
          <g>
            <line
              x1={toX(hoveredSample.freqHz)}
              y1={padT}
              x2={toX(hoveredSample.freqHz)}
              y2={H - padB}
              stroke="#94a3b8"
              strokeDasharray="2 2"
            />
            <circle
              cx={toX(hoveredSample.freqHz)}
              cy={toY(hasPanels ? hoveredSample.treatedSplDb : hoveredSample.untreatedSplDb)}
              r="4"
              fill={hasPanels ? '#22d3ee' : '#f87171'}
            />
          </g>
        )}
      </svg>

      <div className="chart-sub-legend">
        <span><i style={{ background: '#f87171' }} /> 空房频响 (dB)</span>
        {hasPanels && <span><i style={{ background: '#22d3ee' }} /> 处理后频响</span>}
        {hoveredSample ? (
          <span className="crosshair-readout">
            光标测量: <b>{hoveredSample.freqHz.toFixed(0)} Hz</b> · 空房 {hoveredSample.untreatedSplDb.toFixed(1)}dB
            {hasPanels ? ` → 当前 ${hoveredSample.treatedSplDb.toFixed(1)}dB` : ''}
          </span>
        ) : (
          <span className="muted-note">鼠标移入曲线可精确读数 · 点击橙色短竖线查看驻波热力图</span>
        )}
      </div>
    </div>
  );
};

const EtcReflectionChart: React.FC<{ sim: SimulationResult; hasPanels: boolean }> = ({
  sim,
  hasPanels,
}) => {
  const W = 520;
  const H = 180;
  const padL = 46;
  const padR = 18;
  const padT = 20;
  const padB = 28;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const maxMs = Math.max(24, ...sim.reflections.map((r) => r.delayMs * 1.15));
  const toX = (ms: number) => padL + Math.min(ms / maxMs, 1) * plotW;
  const toY = (db: number) => padT + (Math.max(-30, Math.min(0, db)) / -30) * plotH;
  const safeLineY = toY(-12);

  return (
    <div className="svg-chart-box">
      <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg">
        {[-30, -20, -12, -6, 0].map((db) => (
          <g key={db}>
            <line
              x1={padL}
              y1={toY(db)}
              x2={W - padR}
              y2={toY(db)}
              stroke={db === -12 ? '#10b981' : '#1e293b'}
              strokeDasharray={db === -12 ? '4 3' : undefined}
            />
            <text
              x={padL - 6}
              y={toY(db) + 3.5}
              textAnchor="end"
              fill={db === -12 ? '#34d399' : '#94a3b8'}
              fontSize="10.5"
            >
              {db}dB
            </text>
          </g>
        ))}

        <text x={W - padR - 4} y={safeLineY - 5} textAnchor="end" fill="#34d399" fontSize="10.5">
          -12dB 早期反射抑制目标线
        </text>

        <line x1={toX(0)} y1={H - padB} x2={toX(0)} y2={toY(0)} stroke="#f8fafc" strokeWidth="3" />
        <circle cx={toX(0)} cy={toY(0)} r="4" fill="#f8fafc" />
        <text x={toX(0) + 6} y={toY(0) + 11} fill="#f8fafc" fontSize="10.5">
          直达声 0ms
        </text>

        {sim.reflections.map((r) => {
          const x = toX(r.delayMs);
          const yRaw = toY(r.rawGainDb);
          const yTr = toY(r.gainDb);
          const color =
            r.status === 'absorbed'
              ? '#10b981'
              : r.status === 'diffused'
              ? '#22d3ee'
              : '#ef4444';

          return (
            <g key={r.id}>
              {hasPanels && (
                <line x1={x} y1={H - padB} x2={x} y2={yRaw} stroke="#64748b" strokeWidth="1.2" strokeDasharray="2 2" />
              )}
              <line x1={x} y1={H - padB} x2={x} y2={yTr} stroke={color} strokeWidth="2.8" />
              <circle cx={x} cy={yTr} r="4" fill={color} />
              <text x={x} y={Math.max(13, yTr - 6)} textAnchor="middle" fill={color} fontSize="10">
                {r.faceLabel.slice(0, 2)}
              </text>
            </g>
          );
        })}

        {[0, 5, 10, 15, 20, 25].filter((t) => t <= maxMs).map((ms) => (
          <text key={ms} x={toX(ms)} y={H - 7} textAnchor="middle" fill="#cbd5e1" fontSize="10.5">
            {ms}ms
          </text>
        ))}
      </svg>
      <div className="chart-sub-legend">
        <span><i style={{ background: '#ef4444' }} /> 强反射脉冲</span>
        <span><i style={{ background: '#10b981' }} /> 已吸音衰减</span>
        <span><i style={{ background: '#22d3ee' }} /> 已扩散打散</span>
        <span>清晰度 C50: {sim.clarityC50Untreated.toFixed(1)}dB → {sim.clarityC50Treated.toFixed(1)}dB</span>
      </div>
    </div>
  );
};
