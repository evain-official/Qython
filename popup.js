/* ═══════════════════════════════════════════════
   Qython v1.0.0 · popup.js  (shared: popup + app)
═══════════════════════════════════════════════ */
'use strict';

const $ = id => document.getElementById(id);
const IS_FULLPAGE = document.body.classList.contains('fullpage');

// ── DOM refs ─────────────────────────────────
const output           = $('output');
const inp              = $('inp');
const inputbar         = $('inputbar');
const ispinner         = $('ispinner');
const sdot             = $('sdot');
const slbl             = $('slbl');
const stmsg            = $('stmsg');
const stln             = $('stln');
const ac               = $('ac');
const palette          = $('palette');
const palInput         = $('palInput');
const palList          = $('palList');
const settings         = $('settings');
const inputOverlay     = $('input-overlay');
const inputPromptLabel = $('input-prompt-label');
const inputField       = $('input-field');

// ── state ─────────────────────────────────────
let pyodide      = null;
let busy         = false;
let inputWaiting = false;
let fontSize     = IS_FULLPAGE ? 13 : 12;
let lineCount    = 0;
const cmdHistory = [];
let hIdx = -1, draft = '';
const sessionLog = [];
const installed  = new Set();
let lastVars     = [];
let acList = [], acIdx = -1;
let palItems = [], palIdx = -1;
let inputResolve = null;

// ═══════════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════════
async function boot() {
  setStatus('loading', 'Initialising Pyodide\u2026');
  const saved = localStorage.getItem('qython-fs');
  if (saved) setFs(parseInt(saved), false);

  try {
    pyodide = await loadPyodide({ indexURL: chrome.runtime.getURL('pyodide/') });

    // NOTE: no triple-quoted Python docstrings inside JS template literals.
    await pyodide.runPythonAsync(`
import sys, io, json, types, builtins as _bi

class _Cap(io.StringIO): pass
sys.stdout = _Cap()
sys.stderr = _Cap()

def _flush():
    o = sys.stdout.getvalue(); e = sys.stderr.getvalue()
    sys.stdout.seek(0); sys.stdout.truncate(0)
    sys.stderr.seek(0); sys.stderr.truncate(0)
    return o, e

def _flush_stdout():
    o = sys.stdout.getvalue()
    sys.stdout.seek(0); sys.stdout.truncate(0)
    return o

def _vars():
    SKIP = {'__name__','__doc__','__package__','__loader__','__spec__',
            '__builtins__','_Cap','_flush','_flush_stdout','_vars',
            'json','types','io','sys','__qr__','_bi'}
    rows = []
    for k, v in list(globals().items()):
        if k.startswith('_') or k in SKIP: continue
        if isinstance(v, types.ModuleType): continue
        try:
            t = type(v).__name__
            r = repr(v)
            if len(r) > 200: r = r[:200] + '\u2026'
        except:
            t = r = '?'
        rows.append({'name': k, 'type': t, 'value': r})
    return json.dumps(rows)
`);

    // Wire input() — flush pending stdout first so print() appears before modal
    pyodide.globals.set('_js_input_fn', (prompt_str) => {
      try {
        const pending = pyodide.runPython('_flush_stdout()');
        if (pending && pending.trim()) appendPendingOutput(pending);
      } catch(_) {}
      return promptUser(prompt_str || '');
    });

    await pyodide.runPythonAsync(`
from pyodide.ffi import run_sync

def _patched_input(prompt=''):
    result = run_sync(_js_input_fn(str(prompt)))
    if result is None:
        raise KeyboardInterrupt('input cancelled')
    val = str(result)
    sys.stdout.write(str(prompt) + val + '\\n')
    return val

_bi.input = _patched_input
`);

    // ── Pre-install packages ──────────────────────────────
    // pyodide-http MUST be installed and patched before requests,
    // otherwise requests tries to open real TCP sockets (impossible in WASM).
    // Each step is awaited individually — no keep_going, no silent swallowing.
    setStatus('loading', 'Loading micropip\u2026');
    await pyodide.loadPackage('micropip');

    setStatus('loading', 'Installing pyodide-http\u2026');
    await pyodide.runPythonAsync(`
import micropip
await micropip.install('pyodide-http')
import pyodide_http
pyodide_http.patch_all()
`);

    setStatus('loading', 'Installing requests\u2026');
    await pyodide.runPythonAsync(`await micropip.install('requests')`);

    setStatus('loading', 'Installing rich\u2026');
    await pyodide.runPythonAsync(`await micropip.install('rich')`);

    // Eagerly import both so they are cached and ready for user code
    await pyodide.runPythonAsync(`import requests; import rich`);

    setStatus('ready', 'Qython v1.0.0  \u00b7  Python 3 \u00b7  Pyodide ' + (pyodide.version || ''));
    // Mark pre-installed packages in the UI
    ['rich', 'requests'].forEach(p => installed.add(p));
    addWelcome();
    renderTags(); // show pre-installed tags in Packages tab
    unlock();
  } catch(e) {
    setStatus('error', 'Failed to load \u2014 ' + e.message);
    sysLine('Error: ' + e.message);
    console.error(e);
  }
}

// ═══════════════════════════════════════════════
// INPUT() MODAL
// ═══════════════════════════════════════════════
function promptUser(promptStr) {
  return new Promise(resolve => {
    inputResolve = resolve;
    inputWaiting = true;
    inputPromptLabel.textContent = promptStr || '';
    inputField.value = '';
    inputOverlay.style.display = 'flex';
    sdot.className = 'dot-input';
    slbl.textContent = 'input'; slbl.className = 's-input';
    stmsg.textContent = '\u2328 waiting for input\u2026';
    setTimeout(() => inputField.focus(), 30);
  });
}
function resolveInput(value) {
  inputOverlay.style.display = 'none';
  inputWaiting = false;
  sdot.className = 'dot-running';
  slbl.textContent = 'running'; slbl.className = 's-running';
  stmsg.textContent = 'Running\u2026';
  if (inputResolve) { const r = inputResolve; inputResolve = null; r(value); }
}
function confirmInput() { resolveInput(inputField.value); }
function cancelInput()  { resolveInput(null); }   // null => KeyboardInterrupt in Python

inputField.addEventListener('keydown', e => {
  if (e.key === 'Enter')  { e.preventDefault(); confirmInput(); }
  if (e.key === 'Escape') { e.preventDefault(); cancelInput();  }
});
$('inputConfirm').addEventListener('click', confirmInput);
$('inputCancel').addEventListener('click',  cancelInput);
inputOverlay.addEventListener('mousedown', e => {
  if (e.target === inputOverlay) cancelInput();
});

// ═══════════════════════════════════════════════
// RUN CODE
// ═══════════════════════════════════════════════
async function runCode(code, target = 'terminal') {
  if (!pyodide || busy) return;

  if (target === 'terminal' && /^clear\s*$/.test(code.trim())) {
    clearTerminal(); return;
  }

  busy = true;
  const t0 = Date.now();
  setStatus('running', 'Running\u2026');
  if (target === 'terminal') lockInput();
  else $('edRun').disabled = true;

  pyodide.runPython('sys.stdout.seek(0);sys.stdout.truncate(0)\nsys.stderr.seek(0);sys.stderr.truncate(0)');

  let text = '', kind = 'out';
  try {
    // REPL echo: only for single-line non-statement expressions
    let reprVal = null;
    const trimmed = code.trim();
    const isStatement = /^(import |from |def |class |for |while |if |elif |else|with |try:|except|finally|async |@|[a-zA-Z_]\w*(\.\w+)*\s*[+\-*\/%&|^]?=(?!=))/.test(trimmed)
                     || trimmed.includes('\n');
    if (!isStatement) {
      try {
        await pyodide.runPythonAsync('__qr__ = eval(' + JSON.stringify(trimmed) + ')');
        reprVal = pyodide.runPython('repr(__qr__)');
      } catch(_) {}
      pyodide.runPython('sys.stdout.seek(0);sys.stdout.truncate(0)\nsys.stderr.seek(0);sys.stderr.truncate(0)');
    }

    // Auto-load any Pyodide packages needed by imports in the code
    // This is what makes stdlib extensions (sqlite3, lzma, etc.) and
    // scientific packages (numpy, pandas, matplotlib…) work automatically.
    try {
      await pyodide.loadPackagesFromImports(code, {
        messageCallback: (msg) => setStatus('running', msg),
        errorCallback:   (err) => console.warn('pkg load:', err),
      });
    } catch(_) {}
    setStatus('running', 'Running\u2026');

    await pyodide.runPythonAsync(code);
    const fl = pyodide.runPython('_flush()').toJs();
    const [out_, err_] = fl;

    if (err_ && err_.trim())                { text = cleanErr(err_.trim()); kind = 'err';   }
    else if (out_ && out_.trim())           { text = out_.trim();           kind = 'out';   }
    else if (reprVal && reprVal !== 'None') { text = reprVal;               kind = 'repr';  }
    else                                    { text = '';                    kind = 'empty'; }
  } catch(e) {
    let err_ = '';
    try { err_ = pyodide.runPython('_flush()').toJs()[1] || ''; } catch(_) {}
    text = cleanErr(err_.trim() || e.message);
    kind = 'err';
  }

  const ms = Date.now() - t0;
  const timeStr = ms < 1000 ? ms + 'ms' : (ms/1000).toFixed(2) + 's';

  if (target === 'terminal') {
    clearPendingOutput();
    addEntry(code, text, kind);
    setStatus('ready', 'done in ' + timeStr + '  \u00b7  ready');
    unlock();
  } else {
    renderEdOut(text, kind);
    setStatus('ready', 'done in ' + timeStr + '  \u00b7  ready');
    $('edRun').disabled = false;
  }

  // Auto-refresh vars if that tab is currently visible
  if (document.querySelector('.tab.active')?.dataset.tab === 'vars') refreshVars();

  busy = false;
}

function cleanErr(msg) {
  if (!msg) return msg;
  const INTERNAL = ['/_pyodide/', '/pyodide/', '_pyodide/_base.py',
    '/lib/python3', 'site-packages/pyodide', 'CodeRunner'];
  const lines = msg.split('\n')
    .filter(l => !INTERNAL.some(p => l.includes(p)));
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() || msg;
}

// ═══════════════════════════════════════════════
// RENDER TERMINAL
// ═══════════════════════════════════════════════
function addEntry(cmd, text, kind) {
  lineCount++;
  sessionLog.push({ cmd, text, kind, line: lineCount, ts: Date.now() });

  const wrap = document.createElement('div');
  wrap.className = 'entry';

  const gut = document.createElement('div');
  gut.className = 'egut';
  gut.dataset.line = lineCount;
  gut.textContent = $('optLines').checked ? lineCount : '';

  const body = document.createElement('div');
  body.className = 'ebody';

  const cmdEl = document.createElement('div');
  cmdEl.className = 'ecmd';
  cmdEl.innerHTML = highlight(cmd);

  const rrow = document.createElement('div');
  rrow.className = 'erow';

  const res = document.createElement('div');
  res.className = 'eres r' + kind;
  res.textContent = kind === 'empty' ? '# no output' : text;

  const cp = document.createElement('button');
  cp.className = 'ecopy';
  cp.textContent = 'copy';
  cp.title = 'Copy result';
  cp.onclick = () => doCopy(kind === 'empty' ? cmd : text, cp);

  rrow.append(res, cp);
  body.append(cmdEl, rrow);
  wrap.append(gut, body);
  output.appendChild(wrap);

  if ($('optScroll').checked) scrollOutput('bottom');
  stln.textContent = 'ln:' + lineCount;

  // Only re-render history panel if it is currently visible
  if (document.querySelector('.tab.active')?.dataset.tab === 'history') refreshHistPanel();
}

function sysLine(msg) {
  const wrap = document.createElement('div'); wrap.className = 'entry sys';
  const gut  = document.createElement('div'); gut.className = 'egut'; gut.textContent = '\u00b7';
  const body = document.createElement('div'); body.className = 'ebody';
  const t    = document.createElement('div'); t.className = 'ecmd sys-text'; t.textContent = msg;
  body.appendChild(t); wrap.append(gut, body);
  output.appendChild(wrap);
  if ($('optScroll').checked) scrollOutput('bottom');
}

function addWelcome() {
  const wrap = document.createElement('div'); wrap.className = 'entry welcome';
  const gut  = document.createElement('div'); gut.className = 'egut';
  const body = document.createElement('div'); body.className = 'ebody';

  body.innerHTML = `
    <div class="wcard">
      <div class="wcard-title">\uD83D\uDC0D Qython Beta \u2014 Python 3 \u00b7 Pyodide \u00b7 100% Local</div>
      <div class="wcard-row">
        <kbd>Enter</kbd> run &nbsp;\u00b7&nbsp;
        <kbd>Shift+Enter</kbd> newline &nbsp;\u00b7&nbsp;
        <kbd>\u2191\u2193</kbd> history &nbsp;\u00b7&nbsp;
        <kbd>Tab</kbd> autocomplete &nbsp;\u00b7&nbsp;
        <kbd>Ctrl+L</kbd> / <kbd>clear</kbd> clears output
      </div>
      <div class="wcard-row">
        <kbd>Ctrl+F</kbd> find &nbsp;\u00b7&nbsp;
        <kbd>F3</kbd> next &nbsp;\u00b7&nbsp;
        <kbd>Ctrl+P</kbd> palette &nbsp;\u00b7&nbsp;
        <kbd>Alt+1\u20135</kbd> tabs &nbsp;\u00b7&nbsp;
        <kbd>Alt+\u2191\u2193</kbd> scroll &nbsp;\u00b7&nbsp;
        ${IS_FULLPAGE ? '<kbd>Ctrl+W</kbd> close tab' : '<kbd>\u29c6</kbd> full tab'}
      </div>
    </div>`;
  wrap.append(gut, body);
  output.appendChild(wrap);
}

// ── Pending output: mid-execution print() before input() ─────
let pendingOutputEl = null;
function appendPendingOutput(text) {
  if (!text || !text.trim()) return;
  if (pendingOutputEl) {
    pendingOutputEl.textContent += text;
    if ($('optScroll').checked) scrollOutput('bottom');
    return;
  }
  const wrap = document.createElement('div');
  wrap.className = 'entry pending-out';
  wrap.id = 'pending-output-block';
  const gut = document.createElement('div'); gut.className = 'egut'; gut.textContent = '\u2026';
  const body = document.createElement('div'); body.className = 'ebody pending-body';
  const res  = document.createElement('div'); res.className = 'eres rout'; res.textContent = text;
  body.appendChild(res); wrap.append(gut, body);
  output.appendChild(wrap);
  pendingOutputEl = res;
  if ($('optScroll').checked) scrollOutput('bottom');
}
function clearPendingOutput() {
  $('pending-output-block')?.remove();
  pendingOutputEl = null;
}

// ═══════════════════════════════════════════════
// SYNTAX HIGHLIGHT (hljs)
// ═══════════════════════════════════════════════
function highlight(code) {
  if (typeof hljs === 'undefined')
    return code.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return hljs.highlight(code, { language: 'python', ignoreIllegals: true }).value;
}

// ── KW / BI for autocomplete only (not for highlighting) ─────
const KW = new Set(['False','None','True','and','as','assert','async','await',
  'break','class','continue','def','del','elif','else','except','finally',
  'for','from','global','if','import','in','is','lambda','nonlocal','not',
  'or','pass','raise','return','try','while','with','yield']);
const BI = new Set(['print','len','range','type','int','str','float','list',
  'dict','set','tuple','bool','input','open','abs','all','any','bin',
  'callable','chr','dir','divmod','enumerate','eval','exec','filter',
  'format','getattr','globals','hasattr','hash','hex','id','isinstance',
  'issubclass','iter','locals','map','max','min','next','oct','ord','pow',
  'repr','reversed','round','sorted','sum','super','vars','zip','object',
  'staticmethod','classmethod','property','Exception','ValueError',
  'TypeError','KeyError','IndexError','AttributeError','RuntimeError',
  'StopIteration','NameError','IOError','OSError','FileNotFoundError',
  'NotImplementedError','OverflowError','ZeroDivisionError','ImportError',
  'KeyboardInterrupt','PermissionError','TimeoutError']);

// ═══════════════════════════════════════════════
// AUTOCOMPLETE
// ═══════════════════════════════════════════════
const SNIPS = [
  'import ','from ','def ','class ','return ','print(',
  'range(','len(','enumerate(','zip(','map(','filter(','sorted(',
  'isinstance(','list(','dict(','set(','tuple(','open(','lambda ',
  'async def ','await ',
  'try:\n    \nexcept Exception as e:\n    print(e)',
  'if __name__ == "__main__":\n    ',
];

function getSugs(partial) {
  if (!partial || partial.length < 1) return [];
  const p = partial.toLowerCase();
  const res = [];
  if (pyodide) {
    try {
      JSON.parse(pyodide.runPython('_vars()')).forEach(v => {
        if (v.name.toLowerCase().startsWith(p))
          res.push({ name: v.name, badge: 'va', meta: v.type });
      });
    } catch(_) {}
  }
  [...KW].filter(k => k.toLowerCase().startsWith(p))
    .forEach(k => res.push({ name: k, badge: 'kw', meta: 'keyword' }));
  [...BI].filter(k => k.toLowerCase().startsWith(p))
    .forEach(k => res.push({ name: k + '(', badge: 'bi', meta: 'builtin' }));
  SNIPS.filter(s => s.toLowerCase().startsWith(p))
    .forEach(s => res.push({ name: s, badge: 'fn', meta: 'snippet' }));
  return res.slice(0, 14);
}

function lastWord(str) { return (str.match(/[\w.]*$/) || [''])[0]; }

function showAC(items) {
  acList = items; acIdx = -1; ac.innerHTML = '';
  items.forEach(it => {
    const d = document.createElement('div'); d.className = 'acrow';
    d.innerHTML = `<span class="acbadge ${it.badge}">${it.badge}</span>`
                + `<span class="acname">${eh(it.name)}</span>`
                + `<span class="actype">${eh(it.meta)}</span>`;
    d.onmousedown = ev => { ev.preventDefault(); applyAC(it); };
    ac.appendChild(d);
  });
  ac.style.display = 'block';
}
function hideAC()    { ac.style.display = 'none'; acList = []; acIdx = -1; }
function acVisible() { return ac.style.display !== 'none'; }
function moveAC(dir) {
  const rows = ac.querySelectorAll('.acrow');
  if (!rows.length) return;
  if (acIdx >= 0) rows[acIdx].classList.remove('s');
  acIdx = (acIdx + dir + rows.length) % rows.length;
  rows[acIdx].classList.add('s');
  rows[acIdx].scrollIntoView({ block: 'nearest' });
}
function applyAC(item) {
  const val = inp.value, pos = inp.selectionStart;
  const word = lastWord(val.slice(0, pos));
  const before = val.slice(0, pos - word.length);
  const after  = val.slice(pos);
  inp.value = before + item.name + after;
  const np = before.length + item.name.length;
  inp.setSelectionRange(np, np);
  hideAC(); resizeInp();
}

// ═══════════════════════════════════════════════
// EXPAND TO FULL TAB
// ═══════════════════════════════════════════════
$('btnExpand').addEventListener('click', () => {
  if (IS_FULLPAGE) window.close();
  else chrome.tabs.create({ url: chrome.runtime.getURL('app.html') });
});

// ═══════════════════════════════════════════════
// COMMAND PALETTE
// ═══════════════════════════════════════════════
const CMDS = [
  { i:'\u29c6', n: IS_FULLPAGE ? 'Close full tab' : 'Open in full tab', k:'Ctrl+Shift+F', a: () => $('btnExpand').click() },
  { i:'\u2b21', n:'Terminal',            k:'Alt+1', a: () => goTab('terminal')  },
  { i:'\uD83D\uDCDD',n:'Editor',         k:'Alt+2', a: () => goTab('editor')    },
  { i:'\u25a0', n:'Variables',           k:'Alt+3', a: () => goTab('vars')      },
  { i:'\uD83D\uDCE6',n:'Packages',       k:'Alt+4', a: () => goTab('packages')  },
  { i:'\uD83D\uDD50',n:'History',        k:'Alt+5', a: () => goTab('history')   },
  { i:'\uD83D\uDDD1',n:'Clear terminal', k:'Ctrl+L', a: clearTerminal           },
  { i:'\uD83D\uDD0D',n:'Find in output', k:'Ctrl+F', a: openFind                },
  { i:'\u2191',  n:'Find previous',      k:'Shift+F3', a: () => findStep(-1)    },
  { i:'\u2193',  n:'Find next',          k:'F3',       a: () => findStep(1)     },
  { i:'\u2191',  n:'Scroll to top',      k:'Alt+Home', a: () => scrollOutput('top')      },
  { i:'\u2193',  n:'Scroll to bottom',   k:'Alt+End',  a: () => scrollOutput('bottom')   },
  { i:'\u2191',  n:'Scroll up',          k:'Alt+\u2191', a: () => scrollOutput('up')     },
  { i:'\u2193',  n:'Scroll down',        k:'Alt+\u2193', a: () => scrollOutput('down')   },
  { i:'\u21d1',  n:'Page up',            k:'Alt+PgUp',   a: () => scrollOutput('pageup') },
  { i:'\u21d3',  n:'Page down',          k:'Alt+PgDn',   a: () => scrollOutput('pagedown')},
  { i:'\u27f3',  n:'Refresh variables',  k:'Alt+R',    a: refreshVars            },
  { i:'\u2193',  n:'Export .py',         k:'', a: exportPy  },
  { i:'\u2193',  n:'Export .txt',        k:'', a: exportTxt },
  { i:'\uD83D\uDDD1',n:'Delete history', k:'', a: deleteHistory },
  { i:'\u2699',  n:'Toggle settings',    k:'Ctrl+,', a: toggleSettings },
  { i:'+',       n:'Font size +',        k:'Ctrl+=',  a: () => setFs(fontSize+1) },
  { i:'\u2212',  n:'Font size \u2212',   k:'Ctrl+-',  a: () => setFs(fontSize-1) },
  { i:'\u25d1',  n:'Theme: Dark',        k:'', a: () => setTheme('dark')  },
  { i:'\u25cb',  n:'Theme: Light',       k:'', a: () => setTheme('light') },
  { i:'\u25b6',  n:'Run editor script',  k:'Ctrl+Enter', a: () => { goTab('editor'); $('edRun').click(); } },
  { i:'\u2193',  n:'Save editor .py',    k:'', a: () => $('edSave').click() },
  { i:'\u2191',  n:'Load .py to editor', k:'', a: () => $('edFile').click() },
];

function openPalette() {
  palInput.value = ''; renderPalette('');
  palette.style.display = 'block';
  palInput.focus();
  $('btnPalette').classList.add('active');
}
function closePalette() {
  palette.style.display = 'none';
  $('btnPalette').classList.remove('active');
  if (!inp.disabled) inp.focus();
}
function paletteOpen() { return palette.style.display !== 'none'; }

function renderPalette(q) {
  const f = q ? CMDS.filter(c => c.n.toLowerCase().includes(q.toLowerCase())) : CMDS;
  palItems = f; palIdx = -1; palList.innerHTML = '';
  f.forEach(cmd => {
    const d = document.createElement('div'); d.className = 'pitem';
    d.innerHTML = `<i class="pitem-icon">${cmd.i}</i>`
                + `<span class="pitem-name">${eh(cmd.n)}</span>`
                + `<span class="pitem-kbd">${cmd.k}</span>`;
    d.onclick = () => { cmd.a(); closePalette(); };
    palList.appendChild(d);
  });
}
function movePal(dir) {
  const items = palList.querySelectorAll('.pitem');
  if (!items.length) return;
  if (palIdx >= 0) items[palIdx].classList.remove('sel');
  palIdx = (palIdx + dir + items.length) % items.length;
  items[palIdx].classList.add('sel');
  items[palIdx].scrollIntoView({ block: 'nearest' });
}

palInput.addEventListener('input', () => renderPalette(palInput.value));
palInput.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown') { e.preventDefault(); movePal(1);  return; }
  if (e.key === 'ArrowUp')   { e.preventDefault(); movePal(-1); return; }
  if (e.key === 'Enter') {
    e.preventDefault();
    const run = palIdx >= 0 ? palItems[palIdx] : palItems[0];
    if (run) { run.a(); closePalette(); }
  }
  if (e.key === 'Escape') closePalette();
});
$('btnPalette').addEventListener('click', () => paletteOpen() ? closePalette() : openPalette());

// ═══════════════════════════════════════════════
// SCROLL HELPER
// ═══════════════════════════════════════════════
function scrollOutput(dir) {
  const step = Math.max(55, output.clientHeight * 0.18);
  const page = output.clientHeight * 0.85;
  switch (dir) {
    case 'up':       output.scrollTop -= step;               break;
    case 'down':     output.scrollTop += step;               break;
    case 'pageup':   output.scrollTop -= page;               break;
    case 'pagedown': output.scrollTop += page;               break;
    case 'top':      output.scrollTop = 0;                   break;
    case 'bottom':   output.scrollTop = output.scrollHeight; break;
  }
}

// ═══════════════════════════════════════════════
// INPUT KEYBOARD
// ═══════════════════════════════════════════════
inp.addEventListener('keydown', async e => {
  if (inputWaiting) return;

  if (acVisible()) {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveAC(1);  return; }
    if (e.key === 'ArrowUp')   { e.preventDefault(); moveAC(-1); return; }
    if ((e.key === 'Tab' || e.key === 'Enter') && acIdx >= 0) {
      e.preventDefault(); applyAC(acList[acIdx]); return;
    }
    if (e.key === 'Escape') { e.preventDefault(); hideAC(); return; }
  }

  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault(); hideAC();
    const code = inp.value.trim();
    if (!code) return;
    if (cmdHistory[0] !== code) {
      cmdHistory.unshift(code);
      if (cmdHistory.length > 500) cmdHistory.pop();
    }
    hIdx = -1; draft = '';
    inp.value = ''; inp.classList.remove('ml'); inp.style.height = '';
    await runCode(code, 'terminal');
    return;
  }
  if (e.key === 'Enter' && e.shiftKey) {
    inp.classList.add('ml');
    requestAnimationFrame(resizeInp);
    return;
  }
  if (e.key === 'Tab') {
    e.preventDefault();
    const word = lastWord(inp.value.slice(0, inp.selectionStart));
    if (word.length >= 1) {
      const s = getSugs(word);
      if (s.length === 1) applyAC(s[0]);
      else if (s.length > 1) showAC(s);
    }
    return;
  }
  if (e.key === 'ArrowUp' && !acVisible() && inp.selectionStart === 0) {
    e.preventDefault();
    if (!cmdHistory.length) return;
    if (hIdx === -1) draft = inp.value;
    hIdx = Math.min(hIdx + 1, cmdHistory.length - 1);
    inp.value = cmdHistory[hIdx];
    inp.classList.toggle('ml', inp.value.includes('\n'));
    requestAnimationFrame(() => inp.setSelectionRange(9999, 9999));
    return;
  }
  if (e.key === 'ArrowDown' && !acVisible()) {
    if (hIdx === -1) return;
    e.preventDefault();
    hIdx--;
    inp.value = hIdx === -1 ? draft : cmdHistory[hIdx];
    inp.classList.toggle('ml', inp.value.includes('\n'));
    requestAnimationFrame(() => inp.setSelectionRange(9999, 9999));
    return;
  }
  if (e.ctrlKey && !e.shiftKey) {
    switch (e.key) {
      case 'l': case 'L': e.preventDefault(); clearTerminal();   return;
      case 'u': case 'U': e.preventDefault(); inp.value = ''; inp.classList.remove('ml'); return;
      case 'p': case 'P': e.preventDefault(); openPalette();     return;
      case 'f': case 'F': e.preventDefault(); openFind();        return;
      case ',':           e.preventDefault(); toggleSettings();  return;
      case '=': case '+': e.preventDefault(); setFs(fontSize+1); return;
      case '-':           e.preventDefault(); setFs(fontSize-1); return;
    }
  }
  if (e.ctrlKey && e.shiftKey && e.key === 'F') { e.preventDefault(); $('btnExpand').click(); return; }
});

inp.addEventListener('input', () => {
  resizeInp();
  const word = lastWord(inp.value.slice(0, inp.selectionStart));
  if (word.length >= 2) { const s = getSugs(word); s.length ? showAC(s) : hideAC(); }
  else hideAC();
});

function resizeInp() {
  if (!inp.classList.contains('ml')) { inp.style.height = ''; return; }
  inp.style.height = 'auto';
  inp.style.height = Math.min(inp.scrollHeight, 60) + 'px';
}

output.addEventListener('click', () => { if (!inp.disabled && !inputWaiting) inp.focus(); });
document.addEventListener('click', e => {
  if (acVisible() && !ac.contains(e.target) && e.target !== inp) hideAC();
  if (paletteOpen() && !palette.contains(e.target) && e.target !== $('btnPalette')) closePalette();
});

// ═══════════════════════════════════════════════
// GLOBAL SHORTCUTS
// ═══════════════════════════════════════════════
document.addEventListener('keydown', e => {
  if (inputWaiting) return;

  if (e.ctrlKey && !e.shiftKey && e.key === 'f') { e.preventDefault(); openFind();    return; }
  if (e.key === 'F3' && !e.shiftKey) { e.preventDefault(); findActive ? findStep(1)  : openFind(); return; }
  if (e.key === 'F3' &&  e.shiftKey) { e.preventDefault(); findActive ? findStep(-1) : openFind(); return; }
  if (e.ctrlKey && !e.shiftKey && e.key === 'p') { e.preventDefault(); openPalette();    return; }
  if (e.ctrlKey && !e.shiftKey && e.key === ',') { e.preventDefault(); toggleSettings(); return; }
  if (e.ctrlKey && !e.shiftKey && (e.key==='='||e.key==='+')) { e.preventDefault(); setFs(fontSize+1); return; }
  if (e.ctrlKey && !e.shiftKey && e.key==='-')               { e.preventDefault(); setFs(fontSize-1); return; }
  if (e.ctrlKey && e.shiftKey && e.key === 'F') { e.preventDefault(); $('btnExpand').click(); return; }
  if (e.ctrlKey && e.shiftKey && e.key === 'C') {
    e.preventDefault();
    if (sessionLog.length) doCopy(sessionLog[sessionLog.length-1].text || sessionLog[sessionLog.length-1].cmd);
    return;
  }
  if (e.altKey && !e.ctrlKey && !e.shiftKey) {
    switch (e.key) {
      case '1': e.preventDefault(); goTab('terminal');  return;
      case '2': e.preventDefault(); goTab('editor');    return;
      case '3': e.preventDefault(); goTab('vars');      return;
      case '4': e.preventDefault(); goTab('packages');  return;
      case '5': e.preventDefault(); goTab('history');   return;
      case 'ArrowUp':   e.preventDefault(); scrollOutput('up');       return;
      case 'ArrowDown': e.preventDefault(); scrollOutput('down');     return;
      case 'PageUp':    e.preventDefault(); scrollOutput('pageup');   return;
      case 'PageDown':  e.preventDefault(); scrollOutput('pagedown'); return;
      case 'Home':      e.preventDefault(); scrollOutput('top');      return;
      case 'End':       e.preventDefault(); scrollOutput('bottom');   return;
      case 'r': case 'R': e.preventDefault(); refreshVars();          return;
    }
  }
  if (e.key === 'Escape') {
    if (findActive)                         { closeFind();      return; }
    if (paletteOpen())                      { closePalette();   return; }
    if (acVisible())                        { hideAC();         return; }
    if (settings.style.display !== 'none') { toggleSettings(); return; }
  }
});

// ═══════════════════════════════════════════════
// LOCK / UNLOCK
// ═══════════════════════════════════════════════
function lockInput() {
  inp.disabled = true;
  inputbar.className = 'state-running';
  ispinner.style.display = 'flex';
}
function unlock() {
  inp.disabled = false;
  inputbar.className = 'state-ready';
  ispinner.style.display = 'none';
  inp.focus();
}
function clearTerminal() {
  output.innerHTML = '';
  lineCount = 0; stln.textContent = 'ln:0';
  findMatches = []; findIdx = -1;
  if (findCount) { findCount.textContent = ''; findCount.className = ''; }
  if (findInput) findInput.classList.remove('no-match');
  if (!inp.disabled) inp.focus();
}

function setStatus(s, msg) {
  sdot.className   = 'dot-' + s;
  slbl.textContent = s;
  slbl.className   = 's-' + s;
  stmsg.textContent = msg;
}
function doCopy(text, btn) {
  navigator.clipboard.writeText(String(text || '')).then(() => {
    if (btn) {
      const orig = btn.textContent; btn.textContent = '\u2713'; btn.classList.add('ok');
      setTimeout(() => { btn.textContent = orig; btn.classList.remove('ok'); }, 1400);
    }
  });
}
function eh(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ═══════════════════════════════════════════════
// TABS
// ═══════════════════════════════════════════════
function goTab(name) {
  document.querySelectorAll('.tab').forEach(t =>
    t.classList.toggle('active', t.dataset.tab === name)
  );
  document.querySelectorAll('.panel').forEach(p =>
    p.classList.toggle('active', p.id === 'panel-' + name)
  );
  if (name === 'terminal' && !inp.disabled) inp.focus();
  if (name === 'vars')     refreshVars();
  if (name === 'history')  refreshHistPanel();
  if (name === 'packages') $('pkgName').focus();
}
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => goTab(tab.dataset.tab));
  tab.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goTab(tab.dataset.tab); }
  });
});

// ═══════════════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════════════
function toggleSettings() {
  const open = settings.style.display !== 'none';
  settings.style.display = open ? 'none' : 'flex';
  $('btnSettings').classList.toggle('active', !open);
}
$('btnSettings').addEventListener('click', toggleSettings);
$('fntDec').addEventListener('click', () => setFs(fontSize - 1));
$('fntInc').addEventListener('click', () => setFs(fontSize + 1));

function setFs(n, save = true) {
  fontSize = Math.max(9, Math.min(20, n));
  $('fntVal').textContent = fontSize;
  document.body.style.fontSize = fontSize + 'px';
  ['inp','edTa'].forEach(id => { const el = $(id); if (el) el.style.fontSize = fontSize + 'px'; });
  if (save) localStorage.setItem('qython-fs', fontSize);
}
function setTheme(t) {
  document.body.classList.toggle('t-light', t === 'light');
  [$('tDark'),$('tLight')].forEach((b,i) =>
    b.classList.toggle('active-theme', ['dark','light'][i] === t)
  );
  localStorage.setItem('qython-theme', t);
}
$('tDark').addEventListener('click',  () => setTheme('dark'));
$('tLight').addEventListener('click', () => setTheme('light'));
const savedTheme = localStorage.getItem('qython-theme');
if (savedTheme === 'light') setTheme('light');

$('optLines').addEventListener('change', () => {
  const on = $('optLines').checked;
  document.querySelectorAll('.egut').forEach(g => {
    const special = g.textContent === '\u00b7' || g.textContent === '\u2026';
    if (special) return;
    const n = parseInt(g.dataset.line);
    g.textContent = on && n ? n : '';
  });
});

// ═══════════════════════════════════════════════
// EDITOR
// ═══════════════════════════════════════════════
const edFmt = $('edFmt');

function syncGutter() {
  const n = $('edTa').value.split('\n').length;
  $('ed-gutter').textContent = Array.from({length:n},(_,i)=>i+1).join('\n');
  $('ed-gutter').scrollTop = $('edTa').scrollTop;
}
$('edTa').addEventListener('input', syncGutter);
$('edTa').addEventListener('scroll', () => { $('ed-gutter').scrollTop = $('edTa').scrollTop; });
syncGutter();

$('edTa').addEventListener('keydown', e => {
  if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); $('edRun').click(); return; }
  if (e.key === 'Tab' && !e.shiftKey) {
    e.preventDefault();
    const s = $('edTa').selectionStart, end = $('edTa').selectionEnd;
    if (s === end) {
      $('edTa').value = $('edTa').value.slice(0,s)+'    '+$('edTa').value.slice(end);
      $('edTa').selectionStart = $('edTa').selectionEnd = s+4;
    } else {
      const lines = $('edTa').value.slice(s,end).split('\n').map(l=>'    '+l).join('\n');
      $('edTa').value = $('edTa').value.slice(0,s)+lines+$('edTa').value.slice(end);
    }
    syncGutter(); return;
  }
  if (e.key === 'Tab' && e.shiftKey) {
    e.preventDefault();
    const s = $('edTa').selectionStart, end = $('edTa').selectionEnd;
    const lines = $('edTa').value.slice(s,end).split('\n')
      .map(l=>l.startsWith('    ')?l.slice(4):l).join('\n');
    $('edTa').value = $('edTa').value.slice(0,s)+lines+$('edTa').value.slice(end);
    syncGutter(); return;
  }
  if (e.key === 'Enter') {
    const pos = $('edTa').selectionStart;
    const cur = $('edTa').value.slice(0,pos).split('\n').pop();
    const indent = cur.match(/^(\s*)/)[1];
    const extra  = cur.trimEnd().endsWith(':') ? '    ' : '';
    setTimeout(() => {
      const p = $('edTa').selectionStart;
      $('edTa').value = $('edTa').value.slice(0,p)+indent+extra+$('edTa').value.slice(p);
      $('edTa').selectionStart = $('edTa').selectionEnd = p+indent.length+extra.length;
      syncGutter();
    }, 0);
  }
});
$('edRun').addEventListener('click', () => {
  const code = $('edTa').value.trim(); if (!code) return; runCode(code,'editor');
});
$('edClear').addEventListener('click', () => {
  $('edTa').value=''; syncGutter();
  $('ed-pre').textContent='Run a script to see output\u2026'; $('ed-pre').className='empty';
});
$('edSave').addEventListener('click', () => {
  if (!$('edTa').value.trim()) return; dl($('edTa').value,'script.py','text/plain');
});
$('edLoad').addEventListener('click', () => $('edFile').click());
$('edFile').addEventListener('change', e => {
  const f=e.target.files[0]; if(!f) return;
  const r=new FileReader(); r.onload=ev=>{$('edTa').value=ev.target.result;syncGutter();};
  r.readAsText(f); $('edFile').value='';
});
if (edFmt) edFmt.addEventListener('click', () => {
  $('edTa').value=$('edTa').value.split('\n').map(l=>l.trimEnd()).join('\n').trimEnd()+'\n';
  syncGutter();
});
$('edCpOut').addEventListener('click', () => doCopy($('ed-pre').textContent,$('edCpOut')));
$('edClOut').addEventListener('click', () => {
  $('ed-pre').textContent='Run a script to see output\u2026'; $('ed-pre').className='empty';
});
function renderEdOut(text,kind) {
  $('ed-pre').className=kind==='err'?'err':kind==='empty'?'empty':'';
  $('ed-pre').textContent=kind==='empty'?'# no output':text;
}
{
  let drag=false,sy=0,sh=0;
  $('ed-resizer').addEventListener('mousedown',e=>{
    drag=true;sy=e.clientY;sh=$('ed-out').offsetHeight;
    document.body.style.cursor='row-resize';
  });
  document.addEventListener('mousemove',e=>{
    if(!drag)return;
    $('ed-out').style.height=Math.max(44,Math.min(400,sh+(sy-e.clientY)))+'px';
  });
  document.addEventListener('mouseup',()=>{drag=false;document.body.style.cursor='';});
}

// ═══════════════════════════════════════════════
// VARS
// ═══════════════════════════════════════════════
$('varsRef').addEventListener('click', refreshVars);
$('varsSrch').addEventListener('input', () => renderVars(lastVars));

async function refreshVars() {
  if (!pyodide) return;
  try { lastVars=JSON.parse(pyodide.runPython('_vars()')); renderVars(lastVars); }
  catch(e) { $('vars-body').innerHTML=`<div class="empty-hint">Error: ${eh(e.message)}</div>`; }
}
function renderVars(vars) {
  const q=$('varsSrch').value.toLowerCase();
  const f=q?vars.filter(v=>v.name.toLowerCase().includes(q)):vars;
  $('varsCnt').textContent=`${f.length} var${f.length!==1?'s':''}`;
  if(!f.length){ $('vars-body').innerHTML='<div class="empty-hint">No variables yet.</div>'; return; }
  $('vars-body').innerHTML='';
  f.forEach(v=>{
    const row=document.createElement('div'); row.className='vrow';
    row.innerHTML=`<span class="vn">${eh(v.name)}</span><span class="vt">${eh(v.type)}</span><span class="vv">${eh(v.value)}</span>`;
    $('vars-body').appendChild(row);
  });
}

// ═══════════════════════════════════════════════
// PACKAGES
// ═══════════════════════════════════════════════
$('pkgBtn').addEventListener('click', installPkg);
$('pkgName').addEventListener('keydown', e=>{ if(e.key==='Enter') installPkg(); });

async function installPkg() {
  const name=$('pkgName').value.trim();
  if(!name||!pyodide||busy) return;
  busy=true; $('pkgBtn').disabled=true;
  setStatus('running',`Installing ${name}\u2026`);
  pkgLine(`Installing ${name}\u2026`,'busy');
  try {
    await pyodide.runPythonAsync(`import micropip\nawait micropip.install(${JSON.stringify(name)})`);
    pkgLine(`\u2713 ${name} installed`,'ok');
    installed.add(name); renderTags(); $('pkgName').value='';
  } catch(e) { pkgLine(`\u2717 ${e.message}`,'err'); }
  setStatus('ready','Python 3 ready');
  $('pkgBtn').disabled=false; busy=false;
}
function pkgLine(msg,cls) {
  $('pkg-log').querySelector('.empty-hint')?.remove();
  const d=document.createElement('div'); d.className='pl '+cls; d.textContent=msg;
  $('pkg-log').appendChild(d); $('pkg-log').scrollTop=$('pkg-log').scrollHeight;
}
function renderTags() {
  $('pkg-tags').innerHTML='';
  installed.forEach(p=>{ const s=document.createElement('span'); s.className='ptag'; s.textContent=p; $('pkg-tags').appendChild(s); });
}

// ═══════════════════════════════════════════════
// HISTORY
// ═══════════════════════════════════════════════
$('histSrch').addEventListener('input', refreshHistPanel);
$('histTxt').addEventListener('click', exportTxt);
$('histPy').addEventListener('click',  exportPy);
$('histDel').addEventListener('click', deleteHistory);

function refreshHistPanel() {
  const q=$('histSrch').value.toLowerCase();
  const list=q
    ? sessionLog.filter(e=>e.cmd.toLowerCase().includes(q)||(e.text||'').toLowerCase().includes(q))
    : [...sessionLog].reverse();
  if(!list.length){ $('hist-body').innerHTML='<div class="empty-hint">No history yet.</div>'; return; }
  $('hist-body').innerHTML='';
  list.forEach(e=>{
    const row=document.createElement('div'); row.className='hrow';
    const num=document.createElement('div'); num.className='hnum'; num.textContent=e.line;
    const cont=document.createElement('div'); cont.className='hcont';
    const cmd=document.createElement('div'); cmd.className='hcmd'; cmd.textContent=e.cmd;
    const out=document.createElement('div');
    out.className='hout'+(e.kind==='err'?' err':'');
    const preview=(e.text||'').slice(0,120);
    out.textContent=e.kind==='empty'?'(no output)':preview+(e.text.length>120?'\u2026':'');
    cont.append(cmd,out);
    const acts=document.createElement('div'); acts.className='hacts';
    const cp=makeBtn('\u2398','Copy',()=>doCopy(e.cmd,cp));
    const rr=makeBtn('\u21b5','Paste to terminal',()=>{goTab('terminal');inp.value=e.cmd;inp.focus();});
    const del=makeBtn('\u2715','Delete entry',()=>{
      const i=sessionLog.indexOf(e); if(i!==-1) sessionLog.splice(i,1); refreshHistPanel();
    });
    acts.append(cp,rr,del);
    row.append(num,cont,acts);
    $('hist-body').appendChild(row);
  });
}

function makeBtn(icon,title,onclick) {
  const b=document.createElement('button'); b.className='ibtn'; b.title=title; b.textContent=icon;
  b.addEventListener('click',onclick); return b;
}

function exportTxt() {
  if(!sessionLog.length) return;
  const txt=sessionLog.map(e=>`[${e.line}] ${e.cmd}\n    => ${e.kind==='empty'?'(no output)':e.text.replace(/\n/g,'\n       ')}`).join('\n\n');
  dl(`Qython session log\n${'\u2500'.repeat(36)}\n\n${txt}\n`,`qython_${ts()}.txt`,'text/plain');
}
function exportPy() {
  if(!sessionLog.length) return;
  const py=sessionLog.map(e=>`# [${e.line}]\n${e.cmd}\n# => ${e.kind==='empty'?'(no output)':e.text.replace(/\n/g,'\n# => ')}`).join('\n\n');
  dl(`# Qython export \u2014 ${new Date().toISOString()}\n\n${py}\n`,`qython_${ts()}.py`,'text/plain');
}
function deleteHistory() {
  if(!sessionLog.length) return;
  const btn=$('histDel');
  if(btn.dataset.confirming) {
    sessionLog.length=0; lineCount=0; stln.textContent='ln:0';
    output.innerHTML='';
    refreshHistPanel();
    btn.textContent='Delete all'; delete btn.dataset.confirming;
  } else {
    btn.textContent='Sure?'; btn.dataset.confirming='1';
    setTimeout(()=>{ btn.textContent='Delete all'; delete btn.dataset.confirming; },2500);
  }
}

// ═══════════════════════════════════════════════
// UTILS
// ═══════════════════════════════════════════════
function dl(content,name,type) {
  const a=Object.assign(document.createElement('a'),{
    href:URL.createObjectURL(new Blob([content],{type})),download:name
  }); a.click(); URL.revokeObjectURL(a.href);
}
function ts() { return new Date().toISOString().replace(/[:.]/g,'-').slice(0,19); }

// ═══════════════════════════════════════════════
// ADVANCED FIND
// ═══════════════════════════════════════════════
const findbar   = $('findbar');
const findInput = $('findInput');
const findCount = $('findCount');
const findPrev  = $('findPrev');
const findNext  = $('findNext');
const findCase  = $('findCase');
const findRegex = $('findRegex');
const findClose = $('findClose');

let findMatches=[], findIdx=-1, findActive=false;

function openFind() {
  findbar.style.display='flex'; findActive=true;
  findInput.focus(); findInput.select();
  if(findInput.value) runFind();
}
function closeFind() {
  findbar.style.display='none'; findActive=false;
  clearFindHighlights();
  findCount.textContent=''; findCount.className='';
  findInput.classList.remove('no-match');
  if(!inp.disabled) inp.focus();
}
function clearFindHighlights() {
  output.querySelectorAll('mark.fm').forEach(mark=>{
    const p=mark.parentNode; if(!p) return;
    p.replaceChild(document.createTextNode(mark.textContent),mark);
    p.normalize();
  });
  findMatches=[]; findIdx=-1;
}
function runFind() {
  clearFindHighlights();
  const query=findInput.value;
  if(!query){ findCount.textContent=''; findCount.className=''; findInput.classList.remove('no-match'); return; }
  let pattern;
  try {
    const flags=findCase.checked?'g':'gi';
    const src=findRegex.checked?query:query.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    pattern=new RegExp(src,flags);
  } catch(_) {
    findInput.classList.add('no-match'); findCount.textContent='bad regex'; findCount.className='no-match'; return;
  }
  findInput.classList.remove('no-match');
  const allMarks=[];
  output.querySelectorAll('.ecmd,.eres').forEach(root=>{
    const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
    const nodes=[]; let node;
    while((node=walker.nextNode())) nodes.push(node);
    nodes.forEach(textNode=>{
      const text=textNode.nodeValue; const ranges=[]; pattern.lastIndex=0; let m;
      while((m=pattern.exec(text))!==null){ ranges.push({start:m.index,end:m.index+m[0].length}); if(!pattern.global) break; }
      if(!ranges.length) return;
      const frag=document.createDocumentFragment(); let cursor=0;
      ranges.forEach(({start,end})=>{
        if(start>cursor) frag.appendChild(document.createTextNode(text.slice(cursor,start)));
        const mark=document.createElement('mark'); mark.className='fm'; mark.textContent=text.slice(start,end);
        frag.appendChild(mark); allMarks.push(mark); cursor=end;
      });
      if(cursor<text.length) frag.appendChild(document.createTextNode(text.slice(cursor)));
      textNode.parentNode.replaceChild(frag,textNode);
    });
  });
  findMatches=allMarks;
  if(!findMatches.length){ findCount.textContent='no matches'; findCount.className='no-match'; findInput.classList.add('no-match'); findIdx=-1; }
  else { findInput.classList.remove('no-match'); findIdx=0; highlightCurrent(); }
}
function highlightCurrent() {
  findMatches.forEach((m,i)=>m.classList.toggle('current',i===findIdx));
  if(findIdx>=0&&findMatches[findIdx]) findMatches[findIdx].scrollIntoView({block:'nearest',behavior:'smooth'});
  findCount.textContent=findMatches.length?`${findIdx+1} / ${findMatches.length}`:'';
  findCount.className=findMatches.length?'has-match':'no-match';
}
function findStep(dir) {
  if(!findMatches.length) return;
  findIdx=(findIdx+dir+findMatches.length)%findMatches.length;
  highlightCurrent();
}
findInput.addEventListener('input',runFind);
findInput.addEventListener('keydown',e=>{
  if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();findStep(1);}
  if(e.key==='Enter'&&e.shiftKey){e.preventDefault();findStep(-1);}
  if(e.key==='Escape'){e.preventDefault();closeFind();}
  if(e.key==='F3'&&!e.shiftKey){e.preventDefault();findStep(1);}
  if(e.key==='F3'&&e.shiftKey){e.preventDefault();findStep(-1);}
});
findCase.addEventListener('change',runFind);
findRegex.addEventListener('change',runFind);
findNext.addEventListener('click',()=>findStep(1));
findPrev.addEventListener('click',()=>findStep(-1));
findClose.addEventListener('click',closeFind);

// ═══════════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════════
boot();
