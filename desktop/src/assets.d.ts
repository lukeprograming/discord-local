// Binário .wasm embutido como base64 (plugin em vite-wasm-base64.ts).
declare module '*.wasm?base64' {
  const base64: string;
  export default base64;
}
