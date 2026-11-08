// WebView antigo (ex.: Poco F1 sem atualizar): completa o que falta antes do app subir.
if (typeof AbortSignal !== 'undefined' && !('timeout' in AbortSignal)) {
  (AbortSignal as unknown as { timeout: (ms: number) => AbortSignal }).timeout = (ms: number) => {
    const c = new AbortController();
    setTimeout(() => c.abort(new DOMException('tempo esgotado', 'TimeoutError')), ms);
    return c.signal;
  };
}
export {};
