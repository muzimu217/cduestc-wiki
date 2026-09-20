#!/usr/bin/env python3
import json
import os
import ssl
import sys
import urllib.error
import urllib.request

def main():
    payload = json.load(sys.stdin)
    url = payload["url"]
    method = payload.get("method", "GET").upper()
    body = payload.get("body")
    key = os.environ.get("OPENAI_COMPAT_KEY", "")
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "cduestc-wiki-console",
        },
    )
    try:
        with urllib.request.urlopen(req, context=ssl.create_default_context(), timeout=20) as response:
            text = response.read().decode("utf-8", "replace")
            json.dump({"ok": True, "status": response.status, "text": text}, sys.stdout, ensure_ascii=False)
    except urllib.error.HTTPError as error:
        text = error.read().decode("utf-8", "replace")
        json.dump({"ok": False, "status": error.code, "text": text}, sys.stdout, ensure_ascii=False)
    except Exception as error:
        json.dump({"ok": False, "status": 0, "text": str(error)}, sys.stdout, ensure_ascii=False)

if __name__ == "__main__":
    main()
