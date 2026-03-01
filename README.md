# Qython — Local Python Terminal (Chrome Extension)

A Chromium extension that runs **Python 3 entirely locally** via
[Pyodide](https://pyodide.org) (WebAssembly). Zero servers. Zero CDN calls at runtime.

---

## File Structure

```
qython/
├── manifest.json          ← Extension manifest (MV3)
├── popup.html             ← Terminal UI shell
├── style.css              ← Deep-dark terminal theme
├── popup.js               ← Pyodide runner + REPL logic
├── icons/
│   ├── icon16.png
│   ├── icon32.png
│   ├── icon48.png
│   └── icon128.png
└── pyodide/               ← ⬅ YOU MUST ADD THIS FOLDER
    ├── pyodide.js
    ├── pyodide.asm.js
    ├── pyodide.asm.wasm
    ├── python_stdlib.zip
    └── package.json
```

---

## Setup (one-time)

### 1 — Download Pyodide

Download the latest Pyodide release from:
<https://github.com/pyodide/pyodide/releases>

Grab the file named `pyodide-x.y.z.tar.bz2` (full build).

Extract it and copy the entire `pyodide/` folder into the extension root so the
paths match the table above.

> **Minimum required files** (for base Python without extra packages):
> - `pyodide.js`
> - `pyodide.asm.js`
> - `pyodide.asm.wasm`
> - `python_stdlib.zip`
> - `package.json`

### 2 — Load in Chrome / Edge / Brave

1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode** (toggle, top-right).
3. Click **Load unpacked**.
4. Select the `qython/` folder.
5. Pin the extension and click its icon — the terminal opens instantly.

---

## Usage

| Action | Shortcut |
|---|---|
| Execute code | **Enter** |
| History previous | **↑** |
| History next | **↓** |
| Clear line | **Ctrl + U** |
| Clear history | **Ctrl + L** or click `clear` |

### Examples

```python
# Expressions echo their repr (like a real REPL)
2 ** 32

# print() works
for i in range(5):
    print(i * i)

# stdlib is available
import math, json
json.dumps({"pi": math.pi})

# Install packages at runtime (requires internet on first use)
import micropip
await micropip.install('numpy')
import numpy as np
np.random.rand(3, 3)
```

---

## Content Security Policy

The manifest includes:

```json
"content_security_policy": {
  "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';"
}
```

`wasm-unsafe-eval` is **required** for Pyodide's WASM compilation to work inside
a Manifest V3 extension page.

---

## Notes

- The first load compiles the WASM binary — this can take 2–5 seconds on slow
  machines. Subsequent loads are fast (Chrome caches compiled WASM).
- `micropip.install()` calls the PyPI CDN — still fully local execution, but
  package *download* needs internet access the first time.
- History is session-scoped (cleared when the popup closes). Persistent history
  across sessions can be added via `chrome.storage.local`.
