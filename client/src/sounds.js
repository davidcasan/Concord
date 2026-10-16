// Efeitos sonoros curtos gerados na hora, sem arquivos de áudio.
let ctx;

function tone(freqs, { duration = 0.09, gap = 0.07, volume = 0.12, type = 'sine' } = {}) {
  try {
    ctx ||= new AudioContext();
    if (ctx.state === 'suspended') ctx.resume();
    freqs.forEach((freq, i) => {
      const start = ctx.currentTime + i * gap;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(volume, start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + duration + 0.02);
    });
  } catch {
    // sem suporte a áudio: ignora
  }
}

export const sounds = {
  join: () => tone([523, 784]),
  leave: () => tone([784, 523]),
  otherJoin: () => tone([659, 880], { volume: 0.08 }),
  otherLeave: () => tone([880, 659], { volume: 0.08 }),
  mute: () => tone([440], { duration: 0.06, volume: 0.08 }),
  unmute: () => tone([660], { duration: 0.06, volume: 0.08 }),
  message: () => tone([988, 1319], { duration: 0.07, gap: 0.06, volume: 0.06, type: 'triangle' }),
};
