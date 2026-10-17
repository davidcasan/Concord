import workletUrl from './mic-gate-worklet.js?url&no-inline';
import { createRnnoiseNode } from './rnnoise.js';

const workletModules = new WeakMap();

function normalizedSettings(settings) {
  return {
    sensitivity: Math.max(0, Math.min(200, Number(settings.micSensitivity) || 0)) / 100,
    gateEnabled: settings.micGateEnabled === true,
    gateCut: 10 ** (Math.max(-60, Math.min(-20, Number(settings.micGateCut) || -50)) / 20),
  };
}

function applySettings(node, settings) {
  const normalized = normalizedSettings(settings);
  node.port.postMessage(normalized);
  return normalized;
}

async function loadWorklet(context) {
  let module = workletModules.get(context);
  if (!module) {
    module = context.audioWorklet.addModule(workletUrl);
    workletModules.set(context, module);
  }
  await module;
}

export function createMicAudioProcessor(settings) {
  let context;
  let source;
  let node;
  let destination;
  let rnnoise = null;
  let currentSettings = settings;
  let fallbackGateGain = 1;

  const updateFallback = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    const rms = Math.sqrt(input.reduce((sum, sample) => sum + sample * sample, 0) / Math.max(1, input.length));
    const normalized = normalizedSettings(currentSettings);
    const target = !normalized.gateEnabled || rms >= normalized.gateCut ? 1 : 0;
    const coefficient = Math.exp(-1 / (context.sampleRate * (target ? 0.008 : 0.12)));

    for (let channelIndex = 0; channelIndex < event.outputBuffer.numberOfChannels; channelIndex++) {
      const output = event.outputBuffer.getChannelData(channelIndex);
      for (let i = 0; i < output.length; i++) {
        fallbackGateGain = target + (fallbackGateGain - target) * coefficient;
        const sample = input[i] * normalized.sensitivity * fallbackGateGain;
        output[i] = Math.max(-1, Math.min(1, sample));
      }
    }
  };

  // Cadeia: microfone → (RNNoise) → sensibilidade/gate → destino.
  const wire = () => {
    if (!source || !node) return;
    source.disconnect();
    rnnoise?.disconnect();
    if (rnnoise && currentSettings.noiseEngine === 'rnnoise') {
      source.connect(rnnoise);
      rnnoise.connect(node);
    } else {
      source.connect(node);
    }
  };

  const syncNoiseEngine = async () => {
    if (currentSettings.noiseEngine === 'rnnoise' && !rnnoise) {
      const created = await createRnnoiseNode(context);
      if (!node) {
        // O processador foi destruído enquanto o RNNoise carregava.
        created.destroy();
        return;
      }
      rnnoise = created;
    }
    wire();
    if (currentSettings.noiseEngine !== 'rnnoise' && rnnoise) {
      rnnoise.destroy();
      rnnoise = null;
    }
  };

  const connectTrack = (track) => {
    source?.disconnect();
    source = context.createMediaStreamSource(new MediaStream([track]));
    wire();
  };

  return {
    name: 'concord-mic-sensitivity-gate',
    processedTrack: undefined,
    noiseError: undefined,

    async init({ track, audioContext }) {
      if (!audioContext) throw new Error('O processamento do microfone precisa de um AudioContext.');
      context = audioContext;
      destination = context.createMediaStreamDestination();
      if (context.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
        await loadWorklet(context);
        node = new AudioWorkletNode(context, 'concord-mic-gate', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
          channelCount: 1,
          channelCountMode: 'explicit',
        });
        applySettings(node, currentSettings);
      } else {
        node = context.createScriptProcessor(512, 1, 1);
        node.onaudioprocess = updateFallback;
      }
      node.connect(destination);
      connectTrack(track);
      try {
        await syncNoiseEngine();
      } catch (error) {
        // Sem o RNNoise a voz segue só com ganho/gate; quem chamou decide como avisar.
        this.noiseError = error;
      }
      this.processedTrack = destination.stream.getAudioTracks()[0];
    },

    async restart({ track }) {
      connectTrack(track);
      if (node.port) applySettings(node, currentSettings);
    },

    async update(nextSettings) {
      currentSettings = nextSettings;
      if (node?.port) applySettings(node, currentSettings);
      await syncNoiseEngine();
    },

    async destroy() {
      source?.disconnect();
      rnnoise?.disconnect();
      rnnoise?.destroy();
      rnnoise = null;
      node?.disconnect();
      if (node && 'onaudioprocess' in node) node.onaudioprocess = null;
      for (const track of destination?.stream.getTracks() || []) track.stop();
      source = null;
      node = null;
      destination = null;
      this.processedTrack = undefined;
    },
  };
}
