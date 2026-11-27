"""Demo CLI chat app using a Burner Key against the local proxy (Owner: Kisi 4)."""

from __future__ import annotations

import argparse
import sys

import httpx


def send_prompt(proxy_url: str, api_key: str, model: str, message: str) -> int:
    """Send a single message to /v1/messages and print formatted response or error."""
    endpoint = f"{proxy_url.rstrip('/')}/v1/messages"
    payload = {
        "model": model,
        "max_tokens": 256,
        "messages": [{"role": "user", "content": message}],
    }

    try:
        res = httpx.post(
            endpoint,
            headers={
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json=payload,
            timeout=30.0,
        )
    except httpx.HTTPError as exc:
        print(f"[BAĞLANTI HATASI] Proxy sunucusuna ulaşılamadı: {exc}")
        return 1

    data = res.json()
    if res.status_code == 200:
        blocks = data.get("content") or []
        reply = blocks[0].get("text", "") if blocks else ""
        usage = data.get("usage") or {}
        print(f"\n[200 OK • {data.get('model')}]")
        print(f"Yanıt : {reply}")
        print(
            f"Token : input={usage.get('input_tokens', 0)}, "
            f"output={usage.get('output_tokens', 0)}"
        )
        return 0

    err = data.get("error") or {}
    print(f"\n[ENGELLENDİ • HTTP {res.status_code}] ({err.get('type', 'error')})")
    print(f"Mesaj : {err.get('message', res.text)}")
    return 1


def main() -> int:
    parser = argparse.ArgumentParser(description="Burner Key 3. Parti Demo Sohbet Uygulaması")
    parser.add_argument("--url", default="http://127.0.0.1:8000", help="Proxy base URL")
    parser.add_argument("--key", required=True, help="Burner Key (brk_live_...)")
    parser.add_argument(
        "--model",
        default="claude-3-5-haiku-20241022",
        help="Hedef Claude modeli",
    )
    parser.add_argument("--message", help="Tek seferlik mesaj (verilmezse interaktif mod açılır)")
    args = parser.parse_args()

    if args.message:
        return send_prompt(args.url, args.key, args.model, args.message)

    print("=== Burner Key Demo Sohbet (Çıkmak için 'exit' yazın) ===")
    print(f"Proxy: {args.url} | Model: {args.model}\n")
    while True:
        try:
            prompt = input("Sen > ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\nÇıkılıyor.")
            return 0
        if not prompt or prompt.lower() in {"exit", "quit"}:
            return 0
        send_prompt(args.url, args.key, args.model, prompt)


if __name__ == "__main__":
    sys.exit(main())
