/**
 * Supressão de ruído por IA (RNNoise / GTCRN em WebAssembly, rodando no AudioWorklet).
 * Fica num chunk separado: só é baixado quando a supressão por IA está ligada.
 *
 * Os .wasm vêm embutidos em base64 (plugin vite-wasm-base64) e são decodificados aqui, sem fetch:
 * no Electron a página é file:// e o fetch de file:// não funciona.
 */
import { GtcrnWorkletNode, RnnoiseWorkletNode } from '@sapphi-red/web-noise-suppressor';
import rnnoiseWorklet from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url';
import gtcrnWorklet from '@sapphi-red/web-noise-suppressor/gtcrnWorklet.js?url';
import rnnoiseWasm from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?base64';
import rnnoiseSimdWasm from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?base64';
import gtcrnWasm from '@sapphi-red/web-noise-suppressor/gtcrn.wasm?base64';

export type AiMode = 'rnnoise' | 'gtcrn';

function decode(base64: string): ArrayBuffer {
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

// Teste mínimo de suporte a WASM SIMD (o mesmo usado pela biblioteca).
const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
]);

const binaries = new Map<AiMode, ArrayBuffer>();
function binary(mode: AiMode): ArrayBuffer {
  let b = binaries.get(mode);
  if (!b) {
    b = decode(mode === 'gtcrn' ? gtcrnWasm : WebAssembly.validate(SIMD_PROBE) ? rnnoiseSimdWasm : rnnoiseWasm);
    binaries.set(mode, b);
  }
  return b;
}

const modules = new WeakMap<BaseAudioContext, Map<AiMode, Promise<void>>>();
function loadModule(ctx: AudioContext, mode: AiMode): Promise<void> {
  let m = modules.get(ctx);
  if (!m) modules.set(ctx, (m = new Map()));
  let p = m.get(mode);
  if (!p) {
    p = ctx.audioWorklet.addModule(mode === 'gtcrn' ? gtcrnWorklet : rnnoiseWorklet);
    p.catch(() => m.delete(mode));
    m.set(mode, p);
  }
  return p;
}

export type AiNode = AudioWorkletNode & { destroy(): void };

/** O AudioContext precisa estar a 48 kHz (o RNNoise assume isso; o GTCRN aceita 16 ou 48 kHz). */
export async function createAiNode(ctx: AudioContext, mode: AiMode): Promise<AiNode> {
  if (ctx.sampleRate !== 48000) throw new Error(`taxa de amostragem ${ctx.sampleRate} Hz (precisa 48000)`);
  await loadModule(ctx, mode);
  const opts = { maxChannels: 1, wasmBinary: binary(mode).slice(0) };
  return mode === 'gtcrn' ? new GtcrnWorkletNode(ctx, opts) : new RnnoiseWorkletNode(ctx, opts);
}
