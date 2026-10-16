// Transforma o PCM vindo do capturador nativo (app desktop) em uma faixa de áudio WebRTC.
// O capturador exclui o som do próprio Minicord, então os amigos não ouvem a própria voz de volta.

const RATE = 48000;

const WORKLET = `
class MinicordPcm extends AudioWorkletProcessor {
  constructor() {
    super();
    this.capacity = ${RATE}; // 1 s de quadros estéreo
    this.ring = new Float32Array(this.capacity * 2);
    this.read = 0;
    this.write = 0;
    this.count = 0;
    this.buffering = true;
    this.port.onmessage = (e) => this.push(e.data);
  }
  push(samples) {
    const frames = samples.length >> 1;
    for (let i = 0; i < frames; i++) {
      this.ring[this.write * 2] = samples[i * 2];
      this.ring[this.write * 2 + 1] = samples[i * 2 + 1];
      this.write = (this.write + 1) % this.capacity;
    }
    this.count += frames;
    // Mantém a latência baixa: se acumulou mais de 150 ms, descarta o excesso.
    const max = ${Math.round(RATE * 0.15)};
    if (this.count > max) {
      const drop = this.count - ${Math.round(RATE * 0.04)};
      this.read = (this.read + drop) % this.capacity;
      this.count -= drop;
    }
  }
  process(_inputs, outputs) {
    const [left, right] = outputs[0];
    const n = left.length;
    if (this.buffering && this.count < ${Math.round(RATE * 0.02)}) return true; // espera 20 ms antes de tocar
    this.buffering = false;
    for (let i = 0; i < n; i++) {
      if (this.count === 0) {
        this.buffering = true;
        left[i] = 0;
        if (right) right[i] = 0;
        continue;
      }
      left[i] = this.ring[this.read * 2];
      if (right) right[i] = this.ring[this.read * 2 + 1];
      this.read = (this.read + 1) % this.capacity;
      this.count--;
    }
    return true;
  }
}
registerProcessor('minicord-pcm', MinicordPcm);
`;

export const nativeSystemAudioAvailable = () => typeof window !== 'undefined' && !!window.minicordDesktop?.startSystemAudio;

/** Inicia a captura e devolve { track, stop }. Lança erro se o Windows não suportar. */
export async function createSystemAudioTrack({ onEnded } = {}) {
  const api = window.minicordDesktop;
  const ctx = new AudioContext({ sampleRate: RATE, latencyHint: 'interactive' });
  const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
  try {
    await ctx.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }
  const node = new AudioWorkletNode(ctx, 'minicord-pcm', { numberOfInputs: 0, outputChannelCount: [2] });
  const dest = ctx.createMediaStreamDestination();
  dest.channelCount = 2;
  node.connect(dest);
  const track = dest.stream.getAudioTracks()[0];

  const offData = api.onSystemAudioData((chunk) => {
    const samples = new Float32Array(chunk.byteLength / 4);
    new Uint8Array(samples.buffer).set(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    node.port.postMessage(samples, [samples.buffer]);
  });

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    offData();
    offEnded();
    api.stopSystemAudio();
    node.disconnect();
    track.stop();
    ctx.close().catch(() => {});
  };
  const offEnded = api.onSystemAudioEnded(() => {
    stop();
    onEnded?.();
  });

  try {
    await api.startSystemAudio();
    await ctx.resume();
  } catch (err) {
    stop();
    throw err;
  }
  return { track, stop };
}
