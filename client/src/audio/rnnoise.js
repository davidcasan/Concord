import { RnnoiseWorkletNode, loadRnnoise } from '@sapphi-red/web-noise-suppressor';
import rnnoiseWorkletUrl from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url&no-inline';
import rnnoiseWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url&no-inline';
import rnnoiseSimdWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url&no-inline';

// O RNNoise trabalha a 48 kHz: o AudioContext do microfone precisa ser criado com essa taxa.
export const RNNOISE_SAMPLE_RATE = 48000;

let wasmBinary;
const workletModules = new WeakMap();

/** Cria o nó de redução de ruído (RNNoise, local, sem serviços externos) para o contexto informado. */
export async function createRnnoiseNode(context) {
  if (context.sampleRate !== RNNOISE_SAMPLE_RATE) {
    throw new Error(`a redução de ruído precisa de áudio a 48 kHz (o dispositivo está a ${context.sampleRate} Hz)`);
  }
  wasmBinary ??= loadRnnoise({ url: rnnoiseWasmUrl, simdUrl: rnnoiseSimdWasmUrl }).catch((error) => {
    wasmBinary = undefined;
    throw error;
  });
  let module = workletModules.get(context);
  if (!module) {
    module = context.audioWorklet.addModule(rnnoiseWorkletUrl);
    workletModules.set(context, module);
  }
  const [binary] = await Promise.all([wasmBinary, module]);
  const node = new RnnoiseWorkletNode(context, { maxChannels: 1, wasmBinary: binary });
  node.channelCount = 1;
  node.channelCountMode = 'explicit';
  return node;
}
