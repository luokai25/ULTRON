#!/usr/bin/env python3
"""Rewrite the provider host allowlist in UltronProviderHttpPlugin.java from the app's provider registry.

The native plugin only talks to hosts listed there, so every provider the app can call must appear in it and nothing
else may. Run after editing src/provider-adapters.ts or regenerating src/free-catalog.generated.ts:

    python3 tools/sync_native_allowlist.py
"""
import re
from pathlib import Path
from urllib.parse import urlparse

root = Path(__file__).resolve().parent.parent
adapters = (root / "src/provider-adapters.ts").read_text()
generated = (root / "src/free-catalog.generated.ts").read_text()
java_path = root / "android/app/src/main/java/app/ultron/mobile/UltronProviderHttpPlugin.java"

hosts = set()
# Hand-written registry entries: modelsUrl / chatUrl / verifyUrl string literals inside the provider table only.
table = adapters[adapters.index("const HAND_WRITTEN_PROVIDERS"):adapters.index("/** Every OpenAI-compatible chat gateway")]
for url in re.findall(r'(?:modelsUrl|chatUrl|verifyUrl):\s*"(https://[^"]+)"', table):
    hosts.add(urlparse(url.replace("{model}", "x")).hostname)
for base in re.findall(r'"base":\s*"(https://[^"]+)"', generated):
    hosts.add(urlparse(base).hostname)

block = "    private static final Set<String> ALLOWED_HOSTS = new HashSet<>(Arrays.asList(\n" + ",\n".join(f'        "{h}"' for h in sorted(hosts)) + "\n    ));"
java = java_path.read_text()
java, n = re.subn(r"    private static final Set<String> ALLOWED_HOSTS = new HashSet<>\(Arrays\.asList\([\s\S]*?\)\);", block, java, count=1)
assert n == 1, "allowlist block not found"
java_path.write_text(java)
print(f"{len(hosts)} provider hosts written to the native allowlist")
