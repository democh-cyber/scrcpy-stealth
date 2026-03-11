const { app, BrowserWindow, ipcMain, dialog, screen, desktopCapturer, globalShortcut, clipboard } = require('electron');
const path = require('path');
const { spawn, execFile } = require('child_process');
const fs = require('fs');

// --- Anti-detection: disguise process identity ---
// Appear as a legitimate Windows system process in Task Manager / process list
app.setAppUserModelId('Microsoft.Windows.RuntimeBroker');
if (process.platform === 'win32') {
  try { process.title = 'Runtime Broker'; } catch (_) { /* ignore */ }
}

// Disable hardware acceleration fingerprint (reduces GPU process visibility)
// app.disableHardwareAcceleration(); // uncomment if GPU process detection is a concern

// Prevent background throttling — keeps our capture smooth even when not focused
app.commandLine.appendSwitch('disable-background-timer-throttling');
// Disable renderer backgrounding so capture continues when window is behind others
app.commandLine.appendSwitch('disable-renderer-backgrounding');
// Prevent Chromium from reporting as "App Not Responding" in Windows process monitor
app.commandLine.appendSwitch('disable-hang-monitor');
// Disable crash reporting / crash dumps (leaves no forensic trace)
app.commandLine.appendSwitch('disable-breakpad');
app.commandLine.appendSwitch('disable-crash-reporter');
// Clear recent documents list so the app doesn't show up in Windows jump lists
app.clearRecentDocuments();

let mainWindow;
let scrcpyProcess = null;
let stealthHelper = null;
let stealthReady = false;
let scrcpyHwnd = null;
let helperQueue = [];
let activeSerial = null;
let deviceScreenSize = null;
let mainWindowHwnd = null;
let passThroughActive = false;
// stealthActive and alwaysOnTop state are reflected directly on the window
// (no separate variable needed)
let windowOpacity = 1.0;
let focusGuardActive = false;
let autoReconnect = true;
let lastScrcpyOptions = null;
let miniMode = false;
let normalBounds = null;

// --- Config ---
function getConfigPath() {
  return path.join(app.getPath('userData'), 'scrcc-config.json');
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8'));
  } catch {
    return {};
  }
}

function saveConfig(cfg) {
  fs.writeFileSync(getConfigPath(), JSON.stringify(cfg, null, 2), 'utf-8');
}

function getScrcpyDir() {
  const cfg = loadConfig();
  if (cfg.scrcpyPath && fs.existsSync(path.join(cfg.scrcpyPath, 'scrcpy.exe'))) {
    return cfg.scrcpyPath;
  }
  const bundled = path.join(process.resourcesPath || __dirname, 'scrcpy');
  if (fs.existsSync(path.join(bundled, 'scrcpy.exe'))) {
    return bundled;
  }
  return null;
}

function getScrcpyExe() {
  const dir = getScrcpyDir();
  if (dir) return path.join(dir, 'scrcpy.exe');
  return 'scrcpy';
}

function getAdbExe() {
  const dir = getScrcpyDir();
  if (dir) {
    const adbPath = path.join(dir, 'adb.exe');
    if (fs.existsSync(adbPath)) return adbPath;
  }
  return 'adb';
}

function getStealthHelperExe() {
  const local = path.join(__dirname, 'stealth-helper.exe');
  if (fs.existsSync(local)) return local;
  const res = path.join(process.resourcesPath || __dirname, 'stealth-helper.exe');
  if (fs.existsSync(res)) return res;
  // Also check next to the executable itself (portable mode)
  const exeDir = path.dirname(app.getPath('exe'));
  const beside = path.join(exeDir, 'stealth-helper.exe');
  if (fs.existsSync(beside)) return beside;
  return null;
}

// --- Stealth Helper (persistent interactive process) ---
function spawnStealthHelper() {
  const exe = getStealthHelperExe();
  if (!exe) {
    sendLog('[STEALTH] stealth-helper.exe not found!');
    return;
  }

  stealthHelper = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

  let buffer = '';
  stealthHelper.stdout.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed === 'READY') {
        stealthReady = true;
        sendLog('[STEALTH] Helper ready');
        // Apply full stealth to main window immediately
        applyStealthToMainWindow(true);
        continue;
      }
      if (helperQueue.length > 0) {
        helperQueue.shift()(trimmed);
      }
    }
  });

  stealthHelper.stderr.on('data', (data) => {
    // Debug logs from helper
    sendLog('[HELPER] ' + data.toString().trim());
  });

  stealthHelper.on('close', () => {
    stealthHelper = null;
    stealthReady = false;
    while (helperQueue.length > 0) {
      helperQueue.shift()('ERR:helper_closed');
    }
  });
}

function helperCmd(cmd) {
  return new Promise((resolve) => {
    if (!stealthHelper || !stealthReady) {
      resolve('ERR:helper_not_ready');
      return;
    }
    helperQueue.push(resolve);
    stealthHelper.stdin.write(cmd + '\n');
  });
}

function killStealthHelper() {
  if (stealthHelper) {
    try {
      stealthHelper.stdin.write('exit\n');
      stealthHelper.kill();
    } catch (_) { /* ignore */ }
    stealthHelper = null;
    stealthReady = false;
    helperQueue = [];
  }
}

function sendLog(msg) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('scrcpy-log', msg);
  }
}

function getDeviceScreenSize(serial) {
  const adb = getAdbExe();
  const args = serial ? ['-s', serial, 'shell', 'wm', 'size'] : ['shell', 'wm', 'size'];
  return new Promise((resolve) => {
    execFile(adb, args, { timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err) { resolve(null); return; }
      const m = stdout.match(/(\d+)x(\d+)/);
      if (m) resolve({ width: parseInt(m[1]), height: parseInt(m[2]) });
      else resolve(null);
    });
  });
}

function adbInput(cmdArgs) {
  const adb = getAdbExe();
  const args = activeSerial ? ['-s', activeSerial] : [];
  args.push('shell', 'input', ...cmdArgs);
  execFile(adb, args, { timeout: 5000, windowsHide: true }, () => {});
}

// Apply full stealth to the Electron window via C# helper
// WDA_EXCLUDEFROMCAPTURE (0x11) makes it completely invisible in screen sharing
async function applyStealthToMainWindow(enable) {
  if (!mainWindowHwnd) {
    // Get native HWND from Electron
    try {
      const handleBuf = mainWindow.getNativeWindowHandle();
      // Buffer is little-endian pointer (4 or 8 bytes)
      mainWindowHwnd = handleBuf.byteLength >= 8
        ? Number(handleBuf.readBigUInt64LE(0))
        : handleBuf.readUInt32LE(0);
      sendLog('[STEALTH] Main window HWND: ' + mainWindowHwnd);
    } catch (e) {
      sendLog('[STEALTH] Failed to get HWND: ' + e.message);
      return;
    }
  }

  if (enable) {
    // Apply WDA_EXCLUDEFROMCAPTURE — completely invisible in Teams/Zoom/OBS
    const wdaResult = await helperCmd(`wda ${mainWindowHwnd} on`);
    sendLog('[STEALTH] Main window WDA: ' + wdaResult);
    // Hide from Alt-Tab (WS_EX_TOOLWINDOW)
    const styleResult = await helperCmd(`toolwindow ${mainWindowHwnd} on`);
    sendLog('[STEALTH] Main window hidden from Alt-Tab: ' + styleResult);
    // Enable no-activate (prevents focus steal — HackerRank/CoderPad won't detect tab switch)
    const naResult = await helperCmd(`noactivate ${mainWindowHwnd} on`);
    focusGuardActive = true;
    sendLog('[STEALTH] Focus guard ON: ' + naResult);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('focusguard-changed', true);
    }
  } else {
    const wdaResult = await helperCmd(`wda ${mainWindowHwnd} off`);
    sendLog('[STEALTH] Main window WDA off: ' + wdaResult);
    const styleResult = await helperCmd(`toolwindow ${mainWindowHwnd} off`);
    sendLog('[STEALTH] Main window visible in Alt-Tab: ' + styleResult);
    const naResult = await helperCmd(`noactivate ${mainWindowHwnd} off`);
    focusGuardActive = false;
    sendLog('[STEALTH] Focus guard OFF: ' + naResult);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('focusguard-changed', false);
    }
  }
}

// --- Window ---
function createWindow() {
  const cfg = loadConfig();
  // Restore previous window bounds if present
  const initialBounds = cfg.windowBounds || {};

  mainWindow = new BrowserWindow({
    width: 420,
    height: 780,
    minWidth: 300,
    minHeight: 500,
    frame: false,
    transparent: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#1a1a2e',
    title: 'scrcpy',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: false, // prevent DevTools from being opened (anti-fingerprint)
    },
    icon: path.join(__dirname, 'renderer', 'icon.png'),
    show: false,
  });

  // Apply restored bounds if available
  if (initialBounds && typeof initialBounds.width === 'number' && typeof initialBounds.height === 'number') {
    try {
      mainWindow.setBounds({
        x: initialBounds.x || undefined,
        y: initialBounds.y || undefined,
        width: initialBounds.width,
        height: initialBounds.height,
      });
    } catch (_) { /* ignore invalid bounds */ }
  }

  mainWindow.setContentProtection(true);

  // Anti-detection: remove Electron/Chrome signature from user-agent
  const defaultUA = mainWindow.webContents.getUserAgent();
  mainWindow.webContents.setUserAgent(defaultUA.replace(/Electron\/\S+\s?/g, '').replace(/\s{2,}/g, ' '));

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    killScrcpy();
    killStealthHelper();
    mainWindow = null;
  });

  // Persist window bounds on move/resize (debounced)
  let _boundsSaveTimer = null;
  function scheduleSaveBounds() {
    if (_boundsSaveTimer) clearTimeout(_boundsSaveTimer);
    _boundsSaveTimer = setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      try {
        const b = mainWindow.getBounds();
        const cfg = loadConfig();
        cfg.windowBounds = { x: b.x, y: b.y, width: b.width, height: b.height };
        saveConfig(cfg);
      } catch (_) { /* ignore */ }
    }, 300);
  }

  mainWindow.on('resize', scheduleSaveBounds);
  mainWindow.on('move', scheduleSaveBounds);

  spawnStealthHelper();

  // Global hotkey: Ctrl+Shift+S to show/hide the window
  globalShortcut.register('CommandOrControl+Shift+S', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  // Global hotkey: Ctrl+Shift+D to toggle mouse pass-through
  // When on, mouse clicks go through the window so screen share viewers
  // don't see you clicking on an invisible area
  globalShortcut.register('CommandOrControl+Shift+D', async () => {
    await togglePassthrough();
  });

  // Global hotkey: Ctrl+Shift+Q — PANIC KEY
  // Instantly kills scrcpy, hides window, clears ALL traces
  globalShortcut.register('CommandOrControl+Shift+Q', () => {
    sendLog('[PANIC] Emergency exit triggered!');
    panicCleanup();
  });
}

// --- PANIC: kill everything, clear traces, hide ---
function panicCleanup() {
  // Kill scrcpy + helper
  killScrcpy();
  // Kill any lingering adb processes we spawned
  try {
    execFile('taskkill', ['/IM', 'adb.exe', '/F'], { timeout: 3000, windowsHide: true }, () => {});
  } catch (_) { /* ignore */ }
  // Clear clipboard so no phone data leaks
  try { clipboard.clear(); } catch (_) { /* ignore */ }
  // Hide window
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('panic');
    mainWindow.hide();
  }
}

async function togglePassthrough() {
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindowHwnd) return;
  passThroughActive = !passThroughActive;
  const result = await helperCmd(`clickthrough ${mainWindowHwnd} ${passThroughActive ? 'on' : 'off'}`);
  sendLog('[STEALTH] Click-through ' + (passThroughActive ? 'ON' : 'OFF') + ': ' + result);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('passthrough-changed', passThroughActive);
  }
}

// --- scrcpy process ---
function killScrcpy() {
  lastScrcpyOptions = null; // prevent auto-reconnect on intentional stop
  if (scrcpyHwnd) {
    scrcpyHwnd = null;
  }
  if (scrcpyProcess) {
    try { scrcpyProcess.kill('SIGTERM'); } catch (_) { /* ignore */ }
    // We do not immediately null the process here; allow graceful shutdown handlers to run.
    // scrcpyProcess will be cleared in the 'close' event listener or by stopScrcpyGraceful.
  }
  activeSerial = null;
  deviceScreenSize = null;
}

// Graceful stop: wait for scrcpy to exit, force-kill after timeout if needed
function stopScrcpyGraceful(timeout = 4000) {
  return new Promise((resolve) => {
    if (!scrcpyProcess) {
      // nothing to stop
      scrcpyHwnd = null;
      activeSerial = null;
      deviceScreenSize = null;
      return resolve(true);
    }

    const pid = scrcpyProcess.pid;
    let finished = false;

    const onClose = () => {
      finished = true;
      scrcpyProcess = null;
      scrcpyHwnd = null;
      activeSerial = null;
      deviceScreenSize = null;
      resolve(true);
    };

    scrcpyProcess.once('close', onClose);

    try {
      scrcpyProcess.kill();
    } catch (_) { /* ignore */ }

    // After timeout, if still running, attempt force kill (Windows taskkill)
    setTimeout(() => {
      if (finished) return;
      try {
        // Try to see if process is alive; if so, attempt taskkill
        execFile('taskkill', ['/PID', String(pid), '/F', '/T'], { timeout: 3000, windowsHide: true }, () => {
          // ignore
        });
      } catch (_) { /* ignore */ }
      // Give one final tick for 'close' to fire
      setTimeout(() => {
        if (!finished) {
          try { scrcpyProcess = null; } catch (_) { /* ignore */ }
          scrcpyHwnd = null;
          activeSerial = null;
          deviceScreenSize = null;
        }
        resolve(true);
      }, 300);
    }, timeout);
  });
}

// --- IPC ---

ipcMain.handle('get-devices', async () => {
  const adb = getAdbExe();
  return new Promise((resolve) => {
    execFile(adb, ['devices', '-l'], { timeout: 10000, windowsHide: true }, (err, stdout) => {
      if (err) {
        resolve({ error: err.message });
        return;
      }
      const lines = stdout.trim().split('\n').slice(1);
      const devices = lines
        .filter((l) => l.includes('device'))
        .map((l) => {
          const parts = l.trim().split(/\s+/);
          const serial = parts[0];
          const modelMatch = l.match(/model:(\S+)/);
          const model = modelMatch ? modelMatch[1] : serial;
          return { serial, model };
        });
      resolve({ devices });
    });
  });
});

ipcMain.handle('start-scrcpy', async (_event, options) => {
  killScrcpy();
  lastScrcpyOptions = options;

  const exe = getScrcpyExe();
  const args = [];

  activeSerial = options.serial || null;
  if (options.serial) args.push('-s', options.serial);
  if (options.maxSize) args.push('--max-size', String(options.maxSize));
  if (options.bitRate) args.push('--video-bit-rate', String(options.bitRate));
  if (options.maxFps) args.push('--max-fps', String(options.maxFps));
  if (options.turnScreenOff) args.push('--turn-screen-off');
  if (options.stayAwake) args.push('--stay-awake');
  if (options.noAudio) args.push('--no-audio');
  if (options.record) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const recordPath = path.join(app.getPath('videos') || app.getPath('home'), `scrcc-${timestamp}.mp4`);
    args.push('--record', recordPath);
  }

  // Disguise scrcpy: use a benign window title and borderless to avoid Android icon
  args.push('--window-title=Desktop Window Manager');
  args.push('--window-borderless');

  // Position scrcpy off-screen; we capture its content via desktopCapturer
  args.push('--window-x=-32000');
  args.push('--window-y=-32000');

  return new Promise((resolve) => {
    try {
      const env = { ...process.env };
      const scrcpyDir = getScrcpyDir();
      if (scrcpyDir) {
        env.PATH = scrcpyDir + path.delimiter + (env.PATH || '');
      }

      scrcpyProcess = spawn(exe, args, {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true, // hide console window from taskbar/screen
      });

      let started = false;
      let earlyHideApplied = false;

      // Aggressive early hide: poll every 200ms to find and hide scrcpy window
      // BEFORE the normal onStarted flow, preventing the taskbar icon flash
      const earlyHideInterval = setInterval(async () => {
        if (earlyHideApplied || !scrcpyProcess) { clearInterval(earlyHideInterval); return; }
        try {
          const findResult = await helperCmd(`find ${scrcpyProcess.pid}`);
          if (findResult.startsWith('FOUND:')) {
            const hwnd = findResult.split(':')[1];
            // Immediately hide from taskbar + apply WDA
            await helperCmd(`style ${hwnd}`);
            await helperCmd(`wda ${hwnd} on`);
            earlyHideApplied = true;
            clearInterval(earlyHideInterval);
            sendLog('[STEALTH] Early hide applied to scrcpy window');
          }
        } catch (_) { /* ignore — will retry */ }
      }, 200);

      const onStarted = async () => {
        if (started) return;
        started = true;
        clearInterval(earlyHideInterval);
        sendLog('scrcpy started, setting up stealth capture...');

        try {
          // Ensure process still exists
          if (!scrcpyProcess) {
            sendLog('[STEALTH] scrcpy process not available after start');
            resolve({ error: 'scrcpy process not running' });
            return;
          }

          // Find the scrcpy window
          const findResult = await helperCmd(`find ${scrcpyProcess.pid}`);
          sendLog('[STEALTH] find result: ' + findResult);

          if (!findResult.startsWith('FOUND:')) {
            sendLog('[STEALTH] Could not find scrcpy window: ' + findResult);
            resolve({ success: true, pid: scrcpyProcess ? scrcpyProcess.pid : null, capture: false });
            return;
          }

          scrcpyHwnd = findResult.split(':')[1];
          sendLog('[STEALTH] scrcpy HWND: ' + scrcpyHwnd);
        } catch (err) {
          sendLog('[STEALTH] onStarted error: ' + (err && err.message ? err.message : String(err)));
          resolve({ error: err && err.message ? err.message : 'unknown error in onStarted' });
          return;
        }

        // Make it a toolwindow (no taskbar icon) — re-apply in case early hide missed it
        const styleResult = await helperCmd(`style ${scrcpyHwnd}`);
        sendLog('[STEALTH] style result: ' + styleResult);

        // Apply WDA_EXCLUDEFROMCAPTURE to scrcpy window — invisible in screen recordings
        const wdaResult = await helperCmd(`wda ${scrcpyHwnd} on`);
        sendLog('[STEALTH] scrcpy WDA: ' + wdaResult);

        // Also apply noactivate — scrcpy window won't steal focus
        const naResult = await helperCmd(`noactivate ${scrcpyHwnd} on`);
        sendLog('[STEALTH] scrcpy noactivate: ' + naResult);

        // Get device screen size for coordinate mapping
        deviceScreenSize = await getDeviceScreenSize(activeSerial);
        sendLog('[STEALTH] Device screen: ' + (deviceScreenSize ? deviceScreenSize.width + 'x' + deviceScreenSize.height : 'unknown'));

        // Get client rect for coordinate mapping
        const rectResult = await helperCmd(`rect ${scrcpyHwnd}`);
        sendLog('[STEALTH] rect result: ' + rectResult);
        let clientWidth = 0, clientHeight = 0;
        if (rectResult.startsWith('RECT:')) {
          const rParts = rectResult.split(':');
          clientWidth = parseInt(rParts[1]);
          clientHeight = parseInt(rParts[2]);
        }

        // Find capture source via desktopCapturer
        let sourceId = null;
        for (let attempt = 0; attempt < 5; attempt++) {
          const sources = await desktopCapturer.getSources({
            types: ['window'],
            thumbnailSize: { width: 1, height: 1 },
          });
          const match = sources.find(s => s.id === `window:${scrcpyHwnd}:0`);
          if (match) {
            sourceId = match.id;
            break;
          }
          sendLog('[STEALTH] Source not found yet, retrying... (' + (attempt + 1) + '/5)');
          await new Promise(r => setTimeout(r, 1000));
        }

        if (!sourceId) {
          sendLog('[STEALTH] Could not find capture source');
          resolve({ success: true, pid: scrcpyProcess.pid, capture: false });
          return;
        }

        sendLog('[STEALTH] Capture source found: ' + sourceId);

        // Tell renderer to start capturing
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('scrcpy-capture-ready', {
            sourceId,
            clientWidth,
            clientHeight,
            deviceWidth: deviceScreenSize ? deviceScreenSize.width : clientWidth,
            deviceHeight: deviceScreenSize ? deviceScreenSize.height : clientHeight,
          });
        }

        resolve({ success: true, pid: scrcpyProcess.pid, capture: true });
      };

      scrcpyProcess.stderr.on('data', (data) => {
        const text = data.toString();
        sendLog(text.trim());
        if (!started && text.includes('INFO')) {
          onStarted();
        }
      });

      scrcpyProcess.stdout.on('data', (data) => {
        sendLog(data.toString().trim());
      });

      scrcpyProcess.on('error', (err) => {
        if (!started) resolve({ error: `Failed to start scrcpy: ${err.message}` });
        scrcpyProcess = null;
      });

      scrcpyProcess.on('close', (code) => {
        sendLog('[STEALTH] scrcpy process closed, code: ' + String(code));
        if (!started) resolve({ error: `scrcpy exited with code ${code}` });
        scrcpyProcess = null;
        scrcpyHwnd = null;
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('scrcpy-stopped', code);
        }
        // Auto-reconnect if enabled and not intentionally stopped
        if (autoReconnect && lastScrcpyOptions && code !== 0) {
          sendLog('[AUTO-RECONNECT] scrcpy exited unexpectedly, reconnecting in 3s...');
          setTimeout(() => {
            if (autoReconnect && lastScrcpyOptions && !scrcpyProcess) {
              ipcMain.emit('auto-reconnect');
            }
          }, 3000);
        }
      });

      setTimeout(() => { onStarted(); }, 15000);
    } catch (err) {
      resolve({ error: err.message });
    }
  });
});

// Inject touch events via ADB
ipcMain.on('inject-tap', (_event, data) => {
  adbInput(['tap', String(data.x), String(data.y)]);
});

ipcMain.on('inject-swipe', (_event, data) => {
  adbInput(['swipe', String(data.x1), String(data.y1), String(data.x2), String(data.y2), String(data.duration || 300)]);
});

ipcMain.on('inject-key', (_event, data) => {
  adbInput(['keyevent', String(data.keycode)]);
});

// Keyboard text input via ADB
ipcMain.on('inject-text', (_event, text) => {
  if (!text) return;
  const adb = getAdbExe();
  const args = activeSerial ? ['-s', activeSerial] : [];
  const escaped = text.replace(/(["'`\\$!&|;()<> ])/g, '\\$1');
  args.push('shell', 'input', 'text', escaped);
  execFile(adb, args, { timeout: 5000, windowsHide: true }, () => {});
});

// Clipboard sync: phone → PC
ipcMain.handle('clipboard-pull', async () => {
  const adb = getAdbExe();
  const args = activeSerial ? ['-s', activeSerial] : [];
  args.push('shell', 'am', 'broadcast', '-a', 'clipper.get');
  // Try reading from logcat (fallback: use content provider)
  return new Promise((resolve) => {
    const args2 = activeSerial ? ['-s', activeSerial] : [];
    args2.push('shell', 'settings', 'get', 'system', 'clipboard_text');
    // Direct approach: use service call or dumpsys
    const args3 = activeSerial ? ['-s', activeSerial] : [];
    args3.push('shell', 'cmd', 'clipboard', 'get');
    execFile(adb, args3, { timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (!err && stdout && stdout.trim()) {
        const text = stdout.trim();
        clipboard.writeText(text);
        resolve({ text, success: true });
      } else {
        resolve({ success: false, error: 'Could not read phone clipboard' });
      }
    });
  });
});

// Clipboard sync: PC → phone
ipcMain.handle('clipboard-push', async () => {
  const text = clipboard.readText();
  if (!text) return { success: false, error: 'PC clipboard is empty' };
  const adb = getAdbExe();
  const args = activeSerial ? ['-s', activeSerial] : [];
  const escaped = text.replace(/(["'`\\$!&|;()<> ])/g, '\\$1');
  args.push('shell', 'input', 'text', escaped);
  return new Promise((resolve) => {
    execFile(adb, args, { timeout: 10000, windowsHide: true }, (err) => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true, text });
    });
  });
});

// Mini mode toggle
ipcMain.handle('toggle-mini-mode', async () => {
  if (!mainWindow || mainWindow.isDestroyed()) return { mini: false };
  miniMode = !miniMode;
  if (miniMode) {
    normalBounds = mainWindow.getBounds();
    const display = screen.getDisplayMatching(normalBounds);
    const wa = display.workArea;
    mainWindow.setBounds({
      x: wa.x + wa.width - 220,
      y: wa.y + wa.height - 400,
      width: 220,
      height: 400,
    });
  } else if (normalBounds) {
    mainWindow.setBounds(normalBounds);
  }
  return { mini: miniMode };
});

// Auto-reconnect toggle
ipcMain.handle('set-auto-reconnect', async (_event, enabled) => {
  autoReconnect = enabled;
  return { autoReconnect };
});

ipcMain.handle('toggle-passthrough', async () => {
  await togglePassthrough();
  return { passthrough: passThroughActive };
});

ipcMain.handle('set-always-on-top', async (_event, enabled) => {
  if (!mainWindow || mainWindow.isDestroyed()) return { alwaysOnTop: false };
  mainWindow.setAlwaysOnTop(enabled);
  return { alwaysOnTop: enabled };
});

ipcMain.handle('set-opacity', async (_event, value) => {
  if (!mainWindow || mainWindow.isDestroyed()) return { opacity: 1 };
  windowOpacity = Math.max(0.1, Math.min(1, value));
  mainWindow.setOpacity(windowOpacity);
  return { opacity: windowOpacity };
});

ipcMain.handle('toggle-focusguard', async () => {
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindowHwnd) return { focusGuard: false };
  focusGuardActive = !focusGuardActive;
  const result = await helperCmd(`noactivate ${mainWindowHwnd} ${focusGuardActive ? 'on' : 'off'}`);
  sendLog('[STEALTH] Focus guard ' + (focusGuardActive ? 'ON' : 'OFF') + ': ' + result);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('focusguard-changed', focusGuardActive);
  }
  return { focusGuard: focusGuardActive };
});

ipcMain.handle('stop-scrcpy', async () => {
  // Mark as intentional stop to avoid auto-reconnect
  lastScrcpyOptions = null;
  await stopScrcpyGraceful();
  return { success: true };
});

ipcMain.handle('scrcpy-status', async () => {
  return { running: scrcpyProcess !== null };
});

// Window controls
ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-maximize', () => {
  if (mainWindow?.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow?.maximize();
  }
});
ipcMain.on('window-close', () => mainWindow?.close());

ipcMain.handle('toggle-stealth', async (_event, enabled) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setContentProtection(enabled);
    // Apply/remove WDA_EXCLUDEFROMCAPTURE + Alt-Tab hiding
    await applyStealthToMainWindow(enabled);
  }
  return { stealth: enabled };
});

ipcMain.handle('browse-scrcpy-path', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select scrcpy folder (containing scrcpy.exe)',
    properties: ['openDirectory'],
  });
  if (result.canceled || !result.filePaths.length) return { path: null };
  const dir = result.filePaths[0];
  if (!fs.existsSync(path.join(dir, 'scrcpy.exe'))) {
    return { error: 'scrcpy.exe not found in selected folder' };
  }
  const cfg = loadConfig();
  cfg.scrcpyPath = dir;
  saveConfig(cfg);
  return { path: dir };
});

ipcMain.handle('get-scrcpy-path', async () => {
  const cfg = loadConfig();
  const dir = getScrcpyDir();
  // If not bundled/configured, check whether `scrcpy` is available on PATH
  if (!dir) {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    try {
      const out = await new Promise((resolve, reject) => {
        execFile(cmd, ['scrcpy'], { timeout: 3000, windowsHide: true }, (err, stdout) => {
          if (err) return reject(err);
          resolve((stdout || '').trim());
        });
      });
      if (out) {
        // Found an executable on PATH
        return { path: null, configured: cfg.scrcpyPath || null, inPath: true, exePath: out.split('\n')[0] };
      }
    } catch (_) {
      // not on PATH
    }
  }
  return { path: dir, configured: cfg.scrcpyPath || null, inPath: false };
});

// adb-connect: prefer USB if available; otherwise attempt wireless connect to provided IP
ipcMain.handle('adb-connect', async (_event, ip) => {
  const adb = getAdbExe();
  return new Promise((resolve) => {
    // List devices
    execFile(adb, ['devices', '-l'], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err) {
        resolve({ success: false, error: err.message });
        return;
      }
      const lines = (stdout || '').split('\n').slice(1).map(l => l.trim()).filter(Boolean);
      // Prefer first USB device (serial without colon)
      const usbLine = lines.find(l => {
        const parts = l.split(/\s+/);
        const serial = parts[0] || '';
        const state = parts.includes('device');
        return state && serial && !serial.includes(':');
      });
      if (usbLine) {
        const serial = usbLine.split(/\s+/)[0];
        activeSerial = serial;
        resolve({ success: true, method: 'usb', serial });
        return;
      }

      // No USB device found — require IP to connect
      if (!ip) {
        resolve({ success: false, error: 'No USB device found; provide IP to connect wirelessly' });
        return;
      }
      const target = ip.includes(':') ? ip : `${ip}:5555`;
      execFile(adb, ['connect', target], { timeout: 10000, windowsHide: true }, (err2, stdout2) => {
        if (err2) return resolve({ success: false, error: err2.message });
        const out = (stdout2 || '').toLowerCase();
        if (out.includes('connected') || out.includes('already connected')) {
          activeSerial = target;
          resolve({ success: true, method: 'wireless', serial: target });
        } else {
          resolve({ success: false, error: (stdout2 || 'adb connect failed').trim() });
        }
      });
    });
  });
});

app.whenReady().then(createWindow);

// Auto-reconnect: tell the renderer to trigger a restart
ipcMain.on('auto-reconnect', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('auto-reconnect');
  }
});

app.on('window-all-closed', () => {
  globalShortcut.unregisterAll();
  killScrcpy();
  killStealthHelper();
  // Clear clipboard on exit to leave no traces
  try { clipboard.clear(); } catch (_) { /* ignore */ }
  // Clean up Electron crash dumps and GPU cache if they exist
  cleanupTraces();
  app.quit();
});

// Remove forensic traces: crash dumps, GPU cache, recent docs
function cleanupTraces() {
  const dirsToClean = [
    path.join(app.getPath('userData'), 'Crashpad'),
    path.join(app.getPath('userData'), 'GPUCache'),
    path.join(app.getPath('userData'), 'blob_storage'),
    path.join(app.getPath('userData'), 'Session Storage'),
    path.join(app.getPath('userData'), 'Local Storage'),
  ];
  for (const dir of dirsToClean) {
    try {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    } catch (_) { /* ignore */ }
  }
  app.clearRecentDocuments();
}

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
