// "Is this person speaking" for the participant list: one AudioContext per call,
// one analyser per stream, sampled a few times a second. stop() closes the
// context; the engine calls it on every way out of a call, because browsers allow
// only a handful of AudioContexts per page and a leaked one per call ends with
// every indicator silently dead (LESSONS, Calls).

const SAMPLE_MS = 120;
const THRESHOLD = 0.015;   // RMS of the time-domain signal, 0..1
const HANGOVER_MS = 450;   // stay "speaking" through the gaps between words

interface Node {
  src: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  buf: Float32Array<ArrayBuffer>;
  speaking: boolean;
  lastLoud: number;
}

export class SpeakingMeter {
  private ctx: AudioContext | null = null;
  private readonly nodes = new Map<string, Node>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(private readonly onChange: (id: string, speaking: boolean) => void) {}

  add(id: string, stream: MediaStream): void {
    if (this.stopped || !stream.getAudioTracks().length) return;
    this.remove(id);
    const Ctor = typeof window !== 'undefined'
      ? (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
      : undefined;
    if (!Ctor) return;
    try {
      if (!this.ctx) this.ctx = new Ctor();
      if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => undefined);
      const src = this.ctx.createMediaStreamSource(stream);
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      this.nodes.set(id, { src, analyser, buf: new Float32Array(analyser.fftSize), speaking: false, lastLoud: 0 });
      if (!this.timer) this.timer = setInterval(() => this.tick(), SAMPLE_MS);
    } catch {
      // no analyser on this device: the indicator never lights, nothing else breaks
    }
  }

  remove(id: string): void {
    const n = this.nodes.get(id);
    if (!n) return;
    this.nodes.delete(id);
    try { n.src.disconnect(); } catch { /* already gone */ }
    if (n.speaking) this.onChange(id, false);
    if (!this.nodes.size && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const id of [...this.nodes.keys()]) this.remove(id);
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx) void ctx.close().catch(() => undefined);
  }

  get running(): boolean {
    return !!this.ctx;
  }

  private tick(): void {
    const now = Date.now();
    for (const [id, n] of this.nodes) {
      n.analyser.getFloatTimeDomainData(n.buf);
      let sum = 0;
      for (let i = 0; i < n.buf.length; i += 1) {
        const v = n.buf[i]!;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / n.buf.length);
      if (rms > THRESHOLD) n.lastLoud = now;
      const speaking = now - n.lastLoud < HANGOVER_MS;
      if (speaking !== n.speaking) {
        n.speaking = speaking;
        this.onChange(id, speaking);
      }
    }
  }
}
