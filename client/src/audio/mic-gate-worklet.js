class ConcordMicGate extends AudioWorkletProcessor {
  constructor() {
    super();
    this.sensitivity = 1;
    this.gateEnabled = false;
    this.gateCut = 0.00316227766;
    this.gateGain = 1;
    this.port.onmessage = ({ data }) => {
      this.sensitivity = Math.max(0, Math.min(2, Number(data.sensitivity) || 0));
      this.gateEnabled = data.gateEnabled === true;
      this.gateCut = Math.max(0.001, Math.min(0.1, Number(data.gateCut) || 0.00316227766));
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input?.length || !output?.length) return true;

    let sum = 0;
    let count = 0;
    for (const channel of input) {
      for (const sample of channel) {
        sum += sample * sample;
        count++;
      }
    }
    const rms = Math.sqrt(sum / Math.max(1, count));
    const target = !this.gateEnabled || rms >= this.gateCut ? 1 : 0;
    const coefficient = Math.exp(-1 / (sampleRate * (target ? 0.008 : 0.12)));

    for (let channelIndex = 0; channelIndex < output.length; channelIndex++) {
      const source = input[Math.min(channelIndex, input.length - 1)];
      const destination = output[channelIndex];
      for (let i = 0; i < destination.length; i++) {
        this.gateGain = target + (this.gateGain - target) * coefficient;
        const sample = (source[i] || 0) * this.sensitivity * this.gateGain;
        destination[i] = Math.max(-1, Math.min(1, sample));
      }
    }
    return true;
  }
}

registerProcessor('concord-mic-gate', ConcordMicGate);
