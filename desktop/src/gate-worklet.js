// Noise gate do microfone. Roda na thread de áudio: não sofre com o
// "throttling" de timers quando a janela está minimizada.
// Mensagens recebidas: { threshold: number | null } (dB; null = sempre aberto).
// Mensagens enviadas (~20x/s): { db: number, open: boolean }.

const HOLD_S = 0.3; // continua aberto um pouco depois da última sílaba
const ATTACK_S = 0.005;
const RELEASE_S = 0.05;

class NoiseGate extends AudioWorkletProcessor {
  constructor() {
    super();
    this.threshold = null;
    this.gain = 1;
    this.hold = 0;
    this.peak = 0;
    this.sinceReport = 0;
    this.attack = 1 - Math.exp(-1 / (ATTACK_S * sampleRate));
    this.release = 1 - Math.exp(-1 / (RELEASE_S * sampleRate));
    this.port.onmessage = (e) => {
      if ('threshold' in e.data) this.threshold = e.data.threshold;
    };
  }

  process(inputs, outputs) {
    const input = inputs[0] && inputs[0][0];
    const out = outputs[0];
    if (!input) {
      for (const ch of out) ch.fill(0);
      return true;
    }
    let sum = 0;
    for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
    const rms = Math.sqrt(sum / input.length);
    const db = 20 * Math.log10(rms + 1e-9);
    this.peak = Math.max(this.peak, rms);

    if (this.threshold === null || db >= this.threshold) this.hold = HOLD_S * sampleRate;
    else this.hold = Math.max(0, this.hold - input.length);
    const open = this.hold > 0;
    const target = open ? 1 : 0;
    const k = target > this.gain ? this.attack : this.release;

    for (let i = 0; i < input.length; i++) {
      this.gain += (target - this.gain) * k;
      const v = input[i] * this.gain;
      for (const ch of out) ch[i] = v;
    }

    this.sinceReport += input.length;
    if (this.sinceReport >= sampleRate / 20) {
      this.port.postMessage({ db: 20 * Math.log10(this.peak + 1e-9), open });
      this.sinceReport = 0;
      this.peak = 0;
    }
    return true;
  }
}

registerProcessor('noise-gate', NoiseGate);
