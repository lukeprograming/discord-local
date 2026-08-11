#!/usr/bin/env python3
"""Receiver do protocolo "telefone como microfone" (MVP fase 1).

Contrato acordado com o Codex em CHAT DE AI/claudeChat.md (2026-08-11):
- UDP, PCM signed 16-bit little-endian, 48000 Hz, mono, frame de 10ms (960 bytes).
- Header de 19 bytes, big-endian: magic(4)="PMIC" + version(1)=1 + sequence(4)
  uint32 + timestamp_ms(8) uint64 + payload_len(2) uint16, seguido do payload PCM.
- Pacote com magic/version/tamanho inválido é descartado, sem reordenação (MVP),
  só log de gap de sequence.

Sem PipeWire virtual source ainda (fase 2) — toca ao vivo via paplay e grava
WAV opcional, só pra provar que o áudio chega íntegro.
"""

import argparse
import socket
import struct
import subprocess
import sys
import time
import wave

MAGIC = b"PMIC"
VERSION = 1
HEADER_FMT = ">4sBIQH"  # magic, version, sequence, timestamp_ms, payload_len
HEADER_SIZE = struct.calcsize(HEADER_FMT)
assert HEADER_SIZE == 19, HEADER_SIZE

SAMPLE_RATE = 48000
CHANNELS = 1
SAMPLE_WIDTH = 2  # bytes (16-bit)
EXPECTED_PAYLOAD = 960  # 10ms @ 48kHz mono 16-bit


def parse_args():
    p = argparse.ArgumentParser(description="Receiver UDP do phone-mic MVP")
    p.add_argument("--host", default="0.0.0.0", help="interface pra bind (default 0.0.0.0)")
    p.add_argument("--port", type=int, default=47100)
    p.add_argument("--wav", default=None, help="caminho pra gravar WAV opcional (ex: teste.wav)")
    p.add_argument("--no-play", action="store_true", help="não tocar ao vivo, só gravar/logar")
    return p.parse_args()


def start_playback():
    return subprocess.Popen(
        ["paplay", "--raw", "--rate", str(SAMPLE_RATE), "--channels", str(CHANNELS), "--format", "s16le"],
        stdin=subprocess.PIPE,
    )


def main():
    args = parse_args()

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind((args.host, args.port))
    print(f"[receiver] ouvindo em {args.host}:{args.port} (UDP)", flush=True)

    player = None if args.no_play else start_playback()
    wav_file = None
    if args.wav:
        wav_file = wave.open(args.wav, "wb")
        wav_file.setnchannels(CHANNELS)
        wav_file.setsampwidth(SAMPLE_WIDTH)
        wav_file.setframerate(SAMPLE_RATE)
        print(f"[receiver] gravando WAV em {args.wav}", flush=True)

    last_seq = None
    packets_ok = 0
    packets_dropped = 0
    t0 = time.monotonic()
    last_report = t0

    try:
        while True:
            data, addr = sock.recvfrom(2048)

            if len(data) < HEADER_SIZE:
                packets_dropped += 1
                continue

            magic, version, sequence, timestamp_ms, payload_len = struct.unpack(HEADER_FMT, data[:HEADER_SIZE])
            payload = data[HEADER_SIZE:]

            if magic != MAGIC or version != VERSION or payload_len != len(payload):
                packets_dropped += 1
                print(f"[receiver] pacote inválido de {addr}: magic={magic!r} version={version} "
                      f"payload_len_header={payload_len} payload_real={len(payload)}", flush=True)
                continue

            if last_seq is not None:
                expected = (last_seq + 1) & 0xFFFFFFFF
                if sequence != expected:
                    gap = (sequence - expected) & 0xFFFFFFFF
                    print(f"[receiver] gap de sequence: esperado={expected} recebido={sequence} (gap={gap})", flush=True)
            last_seq = sequence
            packets_ok += 1

            if player and player.stdin:
                try:
                    player.stdin.write(payload)
                except BrokenPipeError:
                    print("[receiver] paplay morreu, parando playback", flush=True)
                    player = None
            if wav_file:
                wav_file.writeframes(payload)

            now = time.monotonic()
            if now - last_report >= 5:
                print(f"[receiver] status: ok={packets_ok} dropped={packets_dropped} last_seq={last_seq} "
                      f"payload_len={payload_len} (esperado {EXPECTED_PAYLOAD})", flush=True)
                last_report = now

    except KeyboardInterrupt:
        print("\n[receiver] encerrando...", flush=True)
    finally:
        if player and player.stdin:
            player.stdin.close()
            player.wait()
        if wav_file:
            wav_file.close()
        sock.close()
        print(f"[receiver] final: ok={packets_ok} dropped={packets_dropped}", flush=True)


if __name__ == "__main__":
    sys.exit(main())
