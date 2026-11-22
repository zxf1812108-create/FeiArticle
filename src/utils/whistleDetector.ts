import { WhistleSensitivity } from '../types';
import { ensureNativeMicrophonePermission } from './readerNative';

export interface WhistleDetectionEvent {
  frequencyHz: number;
  peakDb: number;
  prominenceDb: number;
  concentration: number;
  timestamp: number;
}

interface SensitivityPreset {
  minPeakDb: number;
  minProminenceDb: number;
  minConcentration: number;
  adaptiveMarginDb: number;
  requiredFrames: number;
  cooldownMs: number;
}

const SENSITIVITY_PRESETS: Record<WhistleSensitivity, SensitivityPreset> = {
  high: {
    minPeakDb: -62,
    minProminenceDb: 17,
    minConcentration: 0.32,
    adaptiveMarginDb: 10,
    requiredFrames: 3, // ~105ms
    cooldownMs: 750,
  },
  medium: {
    minPeakDb: -54,
    minProminenceDb: 21,
    minConcentration: 0.40,
    adaptiveMarginDb: 13,
    requiredFrames: 4, // ~140ms
    cooldownMs: 850,
  },
  low: {
    minPeakDb: -46,
    minProminenceDb: 25,
    minConcentration: 0.50,
    adaptiveMarginDb: 16,
    requiredFrames: 5, // ~175ms
    cooldownMs: 950,
  },
};

const POLL_INTERVAL_MS = 35;
const FFT_SIZE = 2048;
const WHISTLE_MIN_HZ = 750;
const WHISTLE_MAX_HZ = 3600;
const REF_MIN_HZ = 250;
const REF_MAX_HZ = 4500;
const PEAK_EXCLUSION_BINS = 3;
const PEAK_ENERGY_BINS = 2;
const MAX_FRAME_FREQ_RATIO = 1.15; // Allows natural vibrato/glissando while rejecting erratic noise jumps
const RELEASE_SILENCE_FRAMES = 2;

export function formatMicErrorMessage(err: unknown): string {
  if (err && typeof err === 'object') {
    const name = 'name' in err ? String((err as { name?: unknown }).name || '') : '';
    const message = 'message' in err ? String((err as { message?: unknown }).message || '') : '';
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
      return '未获得麦克风权限，请在浏览器或系统设置中允许访问';
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      return '未检测到可用的麦克风设备';
    }
    if (name === 'NotReadableError' || name === 'TrackStartError') {
      return '麦克风正被其他应用占用，请关闭后重试';
    }
    if (message.trim()) {
      return message.trim();
    }
  }
  return '无法启动麦克风，请检查设备权限设置';
}

export class WhistleDetector {
  private sensitivity: WhistleSensitivity;
  private onWhistle: (event: WhistleDetectionEvent) => void;
  private onError?: (message: string) => void;

  private running = false;
  private startToken = 0;
  private stream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private pollTimer: number | null = null;

  private freqDb: Float32Array<ArrayBuffer> | null = null;
  private scratchDb: number[] = [];

  private streakCount = 0;
  private lastPeakHz = 0;
  private cooldownUntil = 0;
  private waitingForRelease = false;
  private releaseCount = 0;
  private ambientPeakDb = -75;

  constructor(options: {
    sensitivity: WhistleSensitivity;
    onWhistle: (event: WhistleDetectionEvent) => void;
    onError?: (message: string) => void;
  }) {
    this.sensitivity = options.sensitivity;
    this.onWhistle = options.onWhistle;
    this.onError = options.onError;
  }

  public isRunning(): boolean {
    return this.running;
  }

  public setSensitivity(next: WhistleSensitivity): void {
    this.sensitivity = next;
    this.streakCount = 0;
  }

  public async start(): Promise<void> {
    if (this.running) return;
    const token = ++this.startToken;

    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getUserMedia !== 'function'
    ) {
      const msg = '当前环境不支持麦克风访问（需在安全环境或原生应用中使用）';
      this.onError?.(msg);
      throw new Error(msg);
    }

    const nativeGranted = await ensureNativeMicrophonePermission();
    if (token !== this.startToken) return;
    if (!nativeGranted) {
      const msg = '未获得麦克风权限，请在系统设置中允许录音权限';
      this.onError?.(msg);
      throw new Error(msg);
    }

    let stream: MediaStream;
    try {
      // Disable OS noise suppression & echo cancellation because they often filter out pure whistles
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
        video: false,
      });
    } catch (firstErr) {
      // Fallback for WebViews that reject detailed audio constraints
      const errName =
        firstErr && typeof firstErr === 'object' && 'name' in firstErr
          ? String((firstErr as { name?: unknown }).name || '')
          : '';
      if (errName === 'OverconstrainedError' || errName === 'TypeError') {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      } else {
        const msg = formatMicErrorMessage(firstErr);
        this.onError?.(msg);
        throw new Error(msg);
      }
    }

    if (token !== this.startToken) {
      for (const track of stream.getTracks()) {
        try {
          track.stop();
        } catch {
          // ignore
        }
      }
      return;
    }

    const AudioCtxCtor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtxCtor) {
      for (const track of stream.getTracks()) {
        try {
          track.stop();
        } catch {
          // ignore
        }
      }
      const msg = '当前浏览器不支持音频频谱分析';
      this.onError?.(msg);
      throw new Error(msg);
    }

    try {
      const audioCtx = new AudioCtxCtor();
      if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
      }
      if (token !== this.startToken) {
        for (const track of stream.getTracks()) track.stop();
        void audioCtx.close().catch(() => {});
        return;
      }

      const sourceNode = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      analyser.smoothingTimeConstant = 0.2;
      sourceNode.connect(analyser);

      this.stream = stream;
      this.audioCtx = audioCtx;
      this.sourceNode = sourceNode;
      this.analyser = analyser;
      this.freqDb = new Float32Array(new ArrayBuffer(analyser.frequencyBinCount * 4));
      this.scratchDb = [];
      this.streakCount = 0;
      this.lastPeakHz = 0;
      this.cooldownUntil = 0;
      this.waitingForRelease = false;
      this.releaseCount = 0;
      this.ambientPeakDb = -75;
      this.running = true;

      this.pollTimer = window.setInterval(() => {
        this.analyzeFrame();
      }, POLL_INTERVAL_MS);
    } catch (err) {
      for (const track of stream.getTracks()) {
        try {
          track.stop();
        } catch {
          // ignore
        }
      }
      const msg = formatMicErrorMessage(err);
      this.onError?.(msg);
      throw new Error(msg);
    }
  }

  public stop(): void {
    this.startToken++;
    this.running = false;

    if (this.pollTimer !== null) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    if (this.sourceNode) {
      try {
        this.sourceNode.disconnect();
      } catch {
        // ignore
      }
      this.sourceNode = null;
    }

    this.analyser = null;
    this.freqDb = null;
    this.scratchDb = [];

    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        try {
          track.stop();
        } catch {
          // ignore
        }
      }
      this.stream = null;
    }

    if (this.audioCtx) {
      const ctx = this.audioCtx;
      this.audioCtx = null;
      void ctx.close().catch(() => {});
    }

    this.streakCount = 0;
    this.lastPeakHz = 0;
    this.waitingForRelease = false;
    this.releaseCount = 0;
  }

  private analyzeFrame(): void {
    if (!this.running || !this.analyser || !this.audioCtx || !this.freqDb) return;

    if (this.audioCtx.state === 'suspended') {
      void this.audioCtx.resume().catch(() => {});
      return;
    }

    const freqDb = this.freqDb;
    this.analyser.getFloatFrequencyData(freqDb);

    const binCount = freqDb.length;
    const binHz = this.audioCtx.sampleRate / (binCount * 2);
    if (!Number.isFinite(binHz) || binHz <= 0) return;

    const minBin = Math.max(1, Math.floor(WHISTLE_MIN_HZ / binHz));
    const maxBin = Math.min(binCount - 2, Math.ceil(WHISTLE_MAX_HZ / binHz));
    const refMinBin = Math.max(1, Math.floor(REF_MIN_HZ / binHz));
    const refMaxBin = Math.min(binCount - 2, Math.ceil(REF_MAX_HZ / binHz));

    if (maxBin <= minBin || refMaxBin <= refMinBin) return;

    // 1. Locate dominant peak in whistle frequency range (750Hz - 3600Hz)
    let peakIdx = minBin;
    let peakDb = -Infinity;
    for (let i = minBin; i <= maxBin; i++) {
      const v = freqDb[i];
      if (Number.isFinite(v) && v > peakDb) {
        peakDb = v;
        peakIdx = i;
      }
    }

    if (!Number.isFinite(peakDb) || peakDb <= -120) {
      this.handleNonWhistleFrame(-95);
      return;
    }

    // Parabolic interpolation for sub-bin frequency precision
    const leftDb = Number.isFinite(freqDb[peakIdx - 1]) ? freqDb[peakIdx - 1] : peakDb;
    const rightDb = Number.isFinite(freqDb[peakIdx + 1]) ? freqDb[peakIdx + 1] : peakDb;
    const denom = leftDb - 2 * peakDb + rightDb;
    const delta = Math.abs(denom) > 1e-6 ? 0.5 * ((leftDb - rightDb) / denom) : 0;
    const clampedDelta = Math.max(-0.5, Math.min(0.5, delta));
    const peakHz = (peakIdx + clampedDelta) * binHz;

    // 2. Measure broadband reference floor (60th percentile outside peak neighborhood) & linear energy concentration
    const scratch = this.scratchDb;
    scratch.length = 0;

    let peakPower = 0;
    let totalPower = 0;
    for (let i = refMinBin; i <= refMaxBin; i++) {
      const db = freqDb[i];
      if (!Number.isFinite(db)) continue;
      const clampedDb = Math.max(-120, Math.min(0, db));
      const power = Math.pow(10, clampedDb / 10);
      totalPower += power;
      const dist = Math.abs(i - peakIdx);
      if (dist <= PEAK_ENERGY_BINS) {
        peakPower += power;
      }
      if (dist > PEAK_EXCLUSION_BINS) {
        scratch.push(clampedDb);
      }
    }

    if (scratch.length < 8 || totalPower <= 0) {
      this.handleNonWhistleFrame(peakDb);
      return;
    }

    scratch.sort((a, b) => a - b);
    const floorIdx = Math.min(scratch.length - 1, Math.floor(scratch.length * 0.6));
    const bandFloorDb = scratch[floorIdx];
    const prominenceDb = peakDb - bandFloorDb;
    const concentration = peakPower / totalPower;

    const preset = SENSITIVITY_PRESETS[this.sensitivity];
    const adaptiveMinPeakDb = Math.max(
      preset.minPeakDb,
      Math.min(-34, this.ambientPeakDb + preset.adaptiveMarginDb)
    );

    const isWhistleFrame =
      peakHz >= WHISTLE_MIN_HZ &&
      peakHz <= WHISTLE_MAX_HZ &&
      peakDb >= adaptiveMinPeakDb &&
      prominenceDb >= preset.minProminenceDb &&
      concentration >= preset.minConcentration;

    const now = performance.now();

    if (!isWhistleFrame) {
      this.handleNonWhistleFrame(peakDb);
      return;
    }

    // If a long whistle already triggered a page turn, wait until the whistle stops before arming again
    if (this.waitingForRelease) {
      this.releaseCount = 0;
      return;
    }

    if (now < this.cooldownUntil) {
      return;
    }

    // 3. Enforce pitch continuity across consecutive frames so erratic clinks/speech bursts cannot accumulate
    if (this.streakCount > 0 && this.lastPeakHz > 0) {
      const ratio = peakHz > this.lastPeakHz ? peakHz / this.lastPeakHz : this.lastPeakHz / peakHz;
      if (ratio > MAX_FRAME_FREQ_RATIO) {
        this.streakCount = 1;
        this.lastPeakHz = peakHz;
        return;
      }
    }

    this.streakCount++;
    this.lastPeakHz = peakHz;

    if (this.streakCount >= preset.requiredFrames) {
      this.streakCount = 0;
      this.waitingForRelease = true;
      this.releaseCount = 0;
      this.cooldownUntil = now + preset.cooldownMs;
      this.onWhistle({
        frequencyHz: Math.round(peakHz),
        peakDb: Math.round(peakDb),
        prominenceDb: Math.round(prominenceDb),
        concentration,
        timestamp: Date.now(),
      });
    }
  }

  private handleNonWhistleFrame(peakDb: number): void {
    this.streakCount = 0;
    this.lastPeakHz = 0;

    if (this.waitingForRelease) {
      this.releaseCount++;
      if (this.releaseCount >= RELEASE_SILENCE_FRAMES) {
        this.waitingForRelease = false;
        this.releaseCount = 0;
      }
    }

    // Smoothly track quiet room / mild ambient baseline without letting sudden loud claps poison it
    const cappedSample = Math.max(-95, Math.min(-45, peakDb));
    this.ambientPeakDb = this.ambientPeakDb * 0.94 + cappedSample * 0.06;
  }
}
