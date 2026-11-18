import { BandArray, ReflectionRay, RoomModePoint, SimulationResult } from '../acoustics/types';

export type ListenMode = 'dry' | 'untreated' | 'treated';
export type AudioSourceKind =
  | 'guitar'
  | 'speech'
  | 'drums'
  | 'bass'
  | 'music'
  | 'pink_burst'
  | 'custom';

export const AUDIO_SOURCE_OPTIONS: { id: AudioSourceKind; label: string }[] = [
  { id: 'guitar', label: '原声木吉他干声 (PyRoomAcoustics标准源)' },
  { id: 'speech', label: '消声室播音人声 (测C50清晰度与混响尾音)' },
  { id: 'drums', label: '录音棚原声鼓组 (测瞬态与第一反射回声)' },
  { id: 'bass', label: '低音电贝斯律动 (测墙角低频驻波轰头)' },
  { id: 'music', label: '无混响器乐参考曲 (Resonance标准源)' },
  { id: 'pink_burst', label: '粉红噪声脉冲 (-3dB/Oct 声学测量信号)' },
];

const BUILTIN_URLS: Partial<Record<AudioSourceKind, string>> = {
  guitar: '/audio/anechoic_guitar.wav',
  speech: '/audio/anechoic_speech.wav',
  drums: '/audio/acoustic_drums.mp3',
  bass: '/audio/studio_bass.mp3',
  music: '/audio/studio_music.wav',
};

/**
 * 专业级可听化（Auralization）Web Audio 实时卷积收音引擎
 * 采用真实消声室/录音棚无混响干声样本 + 多频段物理脉冲响应合成 + 防削波母线保护
 */
class RoomAuralizer {
  private ctx: AudioContext | null = null;
  private isPlaying = false;
  private listenMode: ListenMode = 'treated';
  private sourceKind: AudioSourceKind = 'guitar';

  private bufferCache = new Map<AudioSourceKind, AudioBuffer>();
  private activeSourceNode: AudioBufferSourceNode | null = null;
  private playToken = 0;

  // 音频路由：SourceBus -> ModeFilter1 -> ModeFilter2 -> (DirectGain + WetConvolver->WetLPF->WetGain) -> Limiter -> Destination
  private sourceBus: GainNode | null = null;
  private modeFilter1: BiquadFilterNode | null = null;
  private modeFilter2: BiquadFilterNode | null = null;
  private highDampFilter: BiquadFilterNode | null = null;
  private reverbWarmthFilter: BiquadFilterNode | null = null;
  private directGain: GainNode | null = null;
  private untreatedConvolver: ConvolverNode | null = null;
  private untreatedGain: GainNode | null = null;
  private treatedConvolver: ConvolverNode | null = null;
  private treatedGain: GainNode | null = null;
  private limiter: DynamicsCompressorNode | null = null;
  private masterGain: GainNode | null = null;

  private lastSim: SimulationResult | null = null;

  private ensureContext(): AudioContext {
    if (!this.ctx) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AudioCtx();
      this.ctx = ctx;

      this.sourceBus = ctx.createGain();

      this.modeFilter1 = ctx.createBiquadFilter();
      this.modeFilter1.type = 'peaking';
      this.modeFilter1.frequency.value = 65;
      this.modeFilter1.Q.value = 5.0;
      this.modeFilter1.gain.value = 0;

      this.modeFilter2 = ctx.createBiquadFilter();
      this.modeFilter2.type = 'peaking';
      this.modeFilter2.frequency.value = 115;
      this.modeFilter2.Q.value = 4.5;
      this.modeFilter2.gain.value = 0;

      // 薄海绵过多导致高频闷暗的搁架滤波
      this.highDampFilter = ctx.createBiquadFilter();
      this.highDampFilter.type = 'highshelf';
      this.highDampFilter.frequency.value = 2500;
      this.highDampFilter.gain.value = 0;

      // 真实房间空气高频自然阻尼滚降，消除数字白噪金属毛刺感！
      this.reverbWarmthFilter = ctx.createBiquadFilter();
      this.reverbWarmthFilter.type = 'lowpass';
      this.reverbWarmthFilter.frequency.value = 5800;
      this.reverbWarmthFilter.Q.value = 0.6;

      this.directGain = ctx.createGain();

      this.untreatedConvolver = ctx.createConvolver();
      this.untreatedConvolver.normalize = false;
      this.untreatedGain = ctx.createGain();

      this.treatedConvolver = ctx.createConvolver();
      this.treatedConvolver.normalize = false;
      this.treatedGain = ctx.createGain();

      // 母线软限幅保护，确保叠加低频驻波谐振后永不破音削波
      this.limiter = ctx.createDynamicsCompressor();
      this.limiter.threshold.value = -3.0;
      this.limiter.knee.value = 6.0;
      this.limiter.ratio.value = 12.0;
      this.limiter.attack.value = 0.003;
      this.limiter.release.value = 0.12;

      this.masterGain = ctx.createGain();
      this.masterGain.gain.value = 0.88;

      // 连接信号图
      this.sourceBus.connect(this.modeFilter1);
      this.modeFilter1.connect(this.modeFilter2);

      // 直达干声通路（全频无损）
      this.modeFilter2.connect(this.directGain);
      this.directGain.connect(this.limiter);

      // 湿声房间反射与混响卷积通路
      this.modeFilter2.connect(this.highDampFilter);
      this.highDampFilter.connect(this.reverbWarmthFilter);

      this.reverbWarmthFilter.connect(this.untreatedConvolver);
      this.untreatedConvolver.connect(this.untreatedGain);
      this.untreatedGain.connect(this.limiter);

      this.reverbWarmthFilter.connect(this.treatedConvolver);
      this.treatedConvolver.connect(this.treatedGain);
      this.treatedGain.connect(this.limiter);

      this.limiter.connect(this.masterGain);
      this.masterGain.connect(ctx.destination);
    }
    return this.ctx;
  }

  /**
   * 生成符合 IEC / AES 标准的 -3dB/Octave 专业测量粉红噪声脉冲 (1.3s 粉噪 + 1.2s 静音留白听混响衰减)
   */
  private createPinkNoiseBurstBuffer(ctx: AudioContext): AudioBuffer {
    const sr = ctx.sampleRate;
    const onSamples = Math.floor(1.3 * sr);
    const totalSamples = Math.floor(2.5 * sr);
    const buf = ctx.createBuffer(1, totalSamples, sr);
    const out = buf.getChannelData(0);

    // Paul Kellet 经典 7 阶高精度粉红噪声滤波器状态机 (±0.05dB 精度)
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    const fadeSamples = Math.floor(0.015 * sr);

    for (let i = 0; i < onSamples; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.96900 * b2 + white * 0.1538520;
      b3 = 0.86650 * b3 + white * 0.3104856;
      b4 = 0.55000 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.0168980;
      const pink = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.045;
      b6 = white * 0.115926;

      let env = 1.0;
      if (i < fadeSamples) env = i / fadeSamples;
      else if (i > onSamples - fadeSamples) env = (onSamples - i) / fadeSamples;
      out[i] = pink * env;
    }

    return buf;
  }

  /**
   * 在消声室人声样本末尾追加 1.15s 静音留白，使每句话结束后能极其清晰地听到房间混响尾巴！
   */
  private padTrailingSilence(ctx: AudioContext, src: AudioBuffer, silenceSec: number): AudioBuffer {
    const extra = Math.floor(silenceSec * src.sampleRate);
    const out = ctx.createBuffer(src.numberOfChannels, src.length + extra, src.sampleRate);
    for (let ch = 0; ch < src.numberOfChannels; ch++) {
      out.getChannelData(ch).set(src.getChannelData(ch), 0);
    }
    return out;
  }

  private async getOrLoadSourceBuffer(kind: AudioSourceKind): Promise<AudioBuffer | null> {
    const ctx = this.ensureContext();
    if (this.bufferCache.has(kind)) {
      return this.bufferCache.get(kind)!;
    }

    if (kind === 'pink_burst') {
      const pink = this.createPinkNoiseBurstBuffer(ctx);
      this.bufferCache.set('pink_burst', pink);
      return pink;
    }

    const url = BUILTIN_URLS[kind];
    if (!url) return null;

    const resp = await fetch(url);
    const arr = await resp.arrayBuffer();
    let decoded = await ctx.decodeAudioData(arr);
    if (kind === 'speech') {
      decoded = this.padTrailingSilence(ctx, decoded, 1.15);
    }
    this.bufferCache.set(kind, decoded);
    return decoded;
  }

  /**
   * 合成自然细腻的双耳立体声房间脉冲响应 (RIR)
   */
  private buildSyntheticRIR(
    ctx: AudioContext,
    rt60: BandArray,
    reflections: ReflectionRay[],
    useTreatedRays: boolean
  ): AudioBuffer {
    const sr = ctx.sampleRate;
    const maxRt = Math.min(Math.max(...rt60, 0.25), 2.5);
    const duration = Math.min(maxRt * 1.08 + 0.1, 2.65);
    const length = Math.max(Math.floor(sr * duration), 4096);
    const buffer = ctx.createBuffer(2, length, sr);

    const chL = buffer.getChannelData(0);
    const chR = buffer.getChannelData(1);

    const rtLow = Math.max(0.5 * (rt60[0] + rt60[1]), 0.08);
    const rtMid = Math.max(0.5 * (rt60[2] + rt60[3]), 0.08);
    const rtHigh = Math.max(0.5 * (rt60[4] + rt60[5]), 0.06);

    const alphaLow = 1 - Math.exp((-2 * Math.PI * 260) / sr);
    const alphaMid = 1 - Math.exp((-2 * Math.PI * 2200) / sr);

    let lpLowL = 0, lpMidL = 0;
    let lpLowR = 0, lpMidR = 0;

    // 精确标定漫反射混响能量系数，使真实干声录音叠加上极其自然的房间空间感
    const tailScale = 0.026 * Math.sqrt(Math.max(rtMid, 0.1));
    const preDelaySamples = Math.floor(0.014 * sr);

    for (let i = preDelaySamples; i < length; i++) {
      const t = i / sr;
      const buildUp = Math.min((i - preDelaySamples) / (0.022 * sr), 1.0);

      // 采用近似高斯分布随机数（两次均匀随机相加），混响质感比硬白噪更丝滑自然
      const nL = (Math.random() + Math.random() - 1);
      const nR = (Math.random() + Math.random() - 1);

      lpLowL += alphaLow * (nL - lpLowL);
      lpMidL += alphaMid * (nL - lpLowL);
      const bandLowL = lpLowL;
      const bandMidL = lpMidL - lpLowL;
      const bandHighL = nL - lpMidL;

      lpLowR += alphaLow * (nR - lpLowR);
      lpMidR += alphaMid * (nR - lpLowR);
      const bandLowR = lpLowR;
      const bandMidR = lpMidR - lpLowR;
      const bandHighR = nR - lpMidR;

      const envLow = Math.exp((-6.908 * t) / rtLow);
      const envMid = Math.exp((-6.908 * t) / rtMid);
      const envHigh = Math.exp((-6.908 * t) / rtHigh);

      chL[i] = buildUp * tailScale * (bandLowL * envLow * 1.4 + bandMidL * envMid + bandHighL * envHigh * 0.72);
      chR[i] = buildUp * tailScale * (bandLowR * envLow * 1.4 + bandMidR * envMid + bandHighR * envHigh * 0.72);
    }

    // 注入 6 面墙一阶早期反射声
    for (const ray of reflections) {
      const db = useTreatedRays ? ray.gainDb : ray.rawGainDb;
      const linearAmp = Math.pow(10, db / 20) * 0.42;
      const baseIdx = Math.max(1, Math.floor((ray.delayMs / 1000) * sr));
      if (baseIdx >= length - 64) continue;

      let panL = 0.7;
      let panR = 0.7;
      if (ray.face === 'left') {
        panL = 0.94;
        panR = 0.28;
      } else if (ray.face === 'right') {
        panL = 0.28;
        panR = 0.94;
      }

      if (useTreatedRays && ray.status === 'diffused') {
        const taps = [0, 47, 113, 191, 283, 389, 461, 557];
        const signs = [1, -1, 1, 1, -1, 1, -1, -1];
        for (let k = 0; k < taps.length; k++) {
          const idx = baseIdx + taps[k];
          if (idx < length) {
            const tapAmp = (linearAmp / Math.sqrt(taps.length)) * signs[k];
            chL[idx] += tapAmp * panL;
            chR[idx] += tapAmp * panR;
          }
        }
      } else {
        chL[baseIdx] += linearAmp * panL;
        chR[baseIdx] += linearAmp * panR;
        if (baseIdx + 1 < length) {
          chL[baseIdx + 1] += linearAmp * 0.35 * panL;
          chR[baseIdx + 1] += linearAmp * 0.35 * panR;
        }
      }
    }

    return buffer;
  }

  public updateSimulation(sim: SimulationResult): void {
    this.lastSim = sim;
    if (!this.ctx || !this.untreatedConvolver || !this.treatedConvolver) return;

    this.untreatedConvolver.buffer = this.buildSyntheticRIR(
      this.ctx,
      sim.rt60Untreated,
      sim.reflections,
      false
    );
    this.treatedConvolver.buffer = this.buildSyntheticRIR(
      this.ctx,
      sim.rt60Treated,
      sim.reflections,
      true
    );

    this.applyModeResonators(sim.modes);
    this.applyRoutingGains();
  }

  private applyModeResonators(modes: RoomModePoint[]): void {
    if (!this.ctx || !this.modeFilter1 || !this.modeFilter2 || !this.highDampFilter || !this.lastSim) return;
    const now = this.ctx.currentTime;

    const sorted = [...modes].sort((a, b) => b.untreatedDb - a.untreatedDb);
    const m1 = sorted[0];
    const m2 = sorted[1];

    if (this.listenMode === 'dry') {
      this.modeFilter1.gain.setTargetAtTime(0, now, 0.03);
      this.modeFilter2.gain.setTargetAtTime(0, now, 0.03);
      this.highDampFilter.gain.setTargetAtTime(0, now, 0.03);
      return;
    }

    const useTreated = this.listenMode === 'treated';
    if (m1) {
      this.modeFilter1.frequency.setTargetAtTime(Math.max(42, m1.freqHz), now, 0.03);
      const boost1 = Math.min(useTreated ? m1.treatedDb * 0.65 : m1.untreatedDb * 0.85, 9.0);
      this.modeFilter1.Q.setTargetAtTime(useTreated ? 3.8 : 7.0, now, 0.03);
      this.modeFilter1.gain.setTargetAtTime(boost1, now, 0.03);
    }

    if (m2) {
      this.modeFilter2.frequency.setTargetAtTime(Math.max(55, m2.freqHz), now, 0.03);
      const boost2 = Math.min(useTreated ? m2.treatedDb * 0.55 : m2.untreatedDb * 0.75, 7.5);
      this.modeFilter2.Q.setTargetAtTime(useTreated ? 3.5 : 6.0, now, 0.03);
      this.modeFilter2.gain.setTargetAtTime(boost2, now, 0.03);
    }

    const highTilt =
      useTreated && this.lastSim.trebleRatio < 0.75
        ? (this.lastSim.trebleRatio - 0.85) * 16
        : 0;
    this.highDampFilter.gain.setTargetAtTime(highTilt, now, 0.04);
  }

  private applyRoutingGains(): void {
    if (!this.ctx || !this.directGain || !this.untreatedGain || !this.treatedGain) return;
    const now = this.ctx.currentTime;

    if (this.listenMode === 'dry') {
      this.directGain.gain.setTargetAtTime(0.95, now, 0.025);
      this.untreatedGain.gain.setTargetAtTime(0.0, now, 0.025);
      this.treatedGain.gain.setTargetAtTime(0.0, now, 0.025);
    } else if (this.listenMode === 'untreated') {
      this.directGain.gain.setTargetAtTime(0.68, now, 0.025);
      this.untreatedGain.gain.setTargetAtTime(0.95, now, 0.025);
      this.treatedGain.gain.setTargetAtTime(0.0, now, 0.025);
    } else {
      this.directGain.gain.setTargetAtTime(0.80, now, 0.025);
      this.untreatedGain.gain.setTargetAtTime(0.0, now, 0.025);
      this.treatedGain.gain.setTargetAtTime(0.92, now, 0.025);
    }

    if (this.lastSim) {
      this.applyModeResonators(this.lastSim.modes);
    }
  }

  public setListenMode(mode: ListenMode): void {
    this.listenMode = mode;
    this.applyRoutingGains();
  }

  public async setSourceKind(kind: AudioSourceKind): Promise<void> {
    this.sourceKind = kind;
    if (this.isPlaying) {
      await this.startSourcePlayback();
    }
  }

  public async loadCustomAudioFile(file: File): Promise<void> {
    const ctx = this.ensureContext();
    const arrayBuf = await file.arrayBuffer();
    const decoded = await ctx.decodeAudioData(arrayBuf);
    this.bufferCache.set('custom', decoded);
    await this.setSourceKind('custom');
  }

  public async togglePlay(sim: SimulationResult): Promise<boolean> {
    const ctx = this.ensureContext();
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }

    if (this.isPlaying) {
      this.stop();
      return false;
    }

    this.updateSimulation(sim);
    this.isPlaying = true;
    await this.startSourcePlayback();
    return true;
  }

  public stop(): void {
    this.isPlaying = false;
    this.playToken++;
    this.stopActiveNode();
  }

  private stopActiveNode(): void {
    if (this.activeSourceNode) {
      try {
        this.activeSourceNode.stop();
        this.activeSourceNode.disconnect();
      } catch {
        // ignore already stopped
      }
      this.activeSourceNode = null;
    }
  }

  private async startSourcePlayback(): Promise<void> {
    const token = ++this.playToken;
    this.stopActiveNode();

    const buf = await this.getOrLoadSourceBuffer(this.sourceKind);
    if (!buf || !this.isPlaying || token !== this.playToken || !this.ctx || !this.sourceBus) {
      return;
    }

    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.connect(this.sourceBus);
    src.start();
    this.activeSourceNode = src;
  }
}

export const roomAuralizer = new RoomAuralizer();
