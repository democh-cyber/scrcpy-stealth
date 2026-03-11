// DOM Elements
const btnRefresh = document.getElementById('btnRefresh');
const btnWireless = document.getElementById('btnWireless');
const deviceList = document.getElementById('deviceList');
const btnStart = document.getElementById('btnStart');
const btnStop = document.getElementById('btnStop');
const logOutput = document.getElementById('logOutput');
const stealthToggle = document.getElementById('stealthToggle');
const stealthBadge = document.getElementById('stealthBadge');
const btnMinimize = document.getElementById('btnMinimize');
const btnMaximize = document.getElementById('btnMaximize');
const btnClose = document.getElementById('btnClose');
const btnBrowse = document.getElementById('btnBrowse');
const pathText = document.getElementById('pathText');
const pathSection = document.getElementById('pathSection');
const controlPanel = document.getElementById('controlPanel');
const mirrorView = document.getElementById('mirrorView');
const mirrorVideo = document.getElementById('mirrorVideo');
const btnStopMirror = document.getElementById('btnStopMirror');
const mirrorStatus = document.getElementById('mirrorStatus');
const btnBack = document.getElementById('btnBack');
const btnHome = document.getElementById('btnHome');
const btnRecent = document.getElementById('btnRecent');
const btnPassthrough = document.getElementById('btnPassthrough');
const btnAlwaysOnTop = document.getElementById('btnAlwaysOnTop');
const opacitySlider = document.getElementById('opacitySlider');
const opacityValue = document.getElementById('opacityValue');
const btnMiniMode = document.getElementById('btnMiniMode');
const btnClipPull = document.getElementById('btnClipPull');
const btnClipPush = document.getElementById('btnClipPush');
const keyboardInput = document.getElementById('keyboardInput');
const btnCopyLog = document.getElementById('btnCopyLog');
let selectedDevice = null;
let captureStream = null;
let captureInfo = null;

// Gesture tracking
let gesture = null; // { startX, startY, startTime, lastX, lastY }

// Window controls
btnMinimize.addEventListener('click', () => window.scrcc.windowMinimize());
btnMaximize.addEventListener('click', () => window.scrcc.windowMaximize());
btnClose.addEventListener('click', () => window.scrcc.windowClose());

// Stealth toggle
stealthToggle.addEventListener('change', async () => {
  const result = await window.scrcc.toggleStealth(stealthToggle.checked);
  stealthBadge.classList.toggle('hidden', !result.stealth);
  appendLog(result.stealth ? 'Stealth mode ENABLED' : 'Stealth mode DISABLED', 'info');
});

// Refresh devices
btnRefresh.addEventListener('click', refreshDevices);

// Wireless connect — auto-discover via mDNS, fall back to manual IP entry
if (btnWireless) {
  btnWireless.addEventListener('click', async () => {
    btnWireless.disabled = true;
    appendLog('Auto-detecting device via mDNS...', 'info');
    let result = await window.scrcc.adbAutoConnect();

    if (!result || !result.success) {
      // mDNS failed — prompt for manual IP:port
      const ip = prompt(
        (result && result.error ? result.error + '\n\n' : '') +
        'Enter phone IP:port (e.g. 192.168.0.14:39113 from Developer Options → Wireless debugging):'
      );
      if (ip && ip.trim()) {
        appendLog('Attempting manual connect to ' + ip.trim() + '...', 'info');
        result = await window.scrcc.adbConnect(ip.trim());
      } else {
        appendLog('Connect cancelled.', 'info');
        btnWireless.disabled = false;
        return;
      }
    }

    btnWireless.disabled = false;
    if (!result) {
      appendLog('adb-connect: no response', 'error');
      return;
    }
    if (result.success) {
      appendLog('Connected via ' + result.method + ' (' + result.serial + ')', 'info');
      await refreshDevices();
      selectedDevice = result.serial;
      document.querySelectorAll('.device-item').forEach((el) => {
        if (el.querySelector('.device-serial') && el.querySelector('.device-serial').textContent === result.serial) {
          el.classList.add('selected');
        }
      });
    } else if (result.needsPairing) {
      appendLog('Device found but not paired. Go to Developer Options → Wireless debugging → Pair device with pairing code, then retry.', 'error');
    } else {
      appendLog('Connect failed: ' + (result.error || 'unknown'), 'error');
    }
  });
}

async function refreshDevices() {
  deviceList.innerHTML = '<div class="placeholder">Scanning...</div>';
  const result = await window.scrcc.getDevices();

  if (result.error) {
    deviceList.innerHTML = '<div class="placeholder" style="color: var(--danger);">' + escapeHtml(result.error) + '</div>';
    appendLog('ADB error: ' + result.error, 'error');
    return;
  }

  if (!result.devices || result.devices.length === 0) {
    deviceList.innerHTML = '<div class="placeholder">No devices found</div>';
    // Attempt mDNS auto-connect in case a wireless debugging device is advertised
    // but not yet connected (auto-connect will be a no-op if nothing is found)
    const ac = await window.scrcc.adbAutoConnect();
    if (ac && ac.success) {
      appendLog('Auto-connected: ' + ac.serial, 'info');
      await refreshDevices();
    } else if (ac && ac.needsPairing) {
      appendLog('Device needs pairing. Click 📶 and pair from Developer Options.', 'error');
    }
    return;
  }

  deviceList.innerHTML = '';
  result.devices.forEach((dev) => {
    const item = document.createElement('div');
    item.className = 'device-item';
    item.innerHTML =
      '<div class="device-dot"></div>' +
      '<div class="device-info">' +
        '<div class="device-model">' + escapeHtml(dev.model) + '</div>' +
        '<div class="device-serial">' + escapeHtml(dev.serial) + '</div>' +
      '</div>';
    item.addEventListener('click', () => {
      document.querySelectorAll('.device-item').forEach((el) => el.classList.remove('selected'));
      item.classList.add('selected');
      selectedDevice = dev.serial;
      appendLog('Selected device: ' + dev.model + ' (' + dev.serial + ')', 'info');
    });
    deviceList.appendChild(item);
  });

  if (result.devices.length === 1) {
    deviceList.querySelector('.device-item').click();
  }
}

// Start scrcpy
btnStart.addEventListener('click', async () => {
  const options = {
    serial: selectedDevice || '',
    maxSize: document.getElementById('maxSize').value,
    bitRate: document.getElementById('bitRate').value,
    maxFps: document.getElementById('maxFps').value,
    turnScreenOff: document.getElementById('turnScreenOff').checked,
    stayAwake: document.getElementById('stayAwake').checked,
    noAudio: document.getElementById('noAudio').checked,
    record: document.getElementById('record').checked,
  };

  btnStart.disabled = true;
  btnStop.disabled = false;
  appendLog('Starting scrcpy...', 'info');

  const result = await window.scrcc.startScrcpy(options);

  if (result.error) {
    appendLog('Error: ' + result.error, 'error');
    btnStart.disabled = false;
    btnStop.disabled = true;
    return;
  }

  appendLog('scrcpy started (PID: ' + result.pid + ')', 'info');
});

// Stop scrcpy
btnStop.addEventListener('click', stopScrcpy);
btnStopMirror.addEventListener('click', stopScrcpy);

async function stopScrcpy() {
  stopCapture();
  await window.scrcc.stopScrcpy();
  switchToControlPanel();
  appendLog('scrcpy stopped', 'info');
}

// --- Video capture ---
async function startCapture(info) {
  captureInfo = info;
  try {
    captureStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: info.sourceId,
        }
      }
    });
    mirrorVideo.srcObject = captureStream;
    mirrorVideo.play();
    appendLog('Video capture started', 'info');
    mirrorStatus.textContent = 'Connected (stealth capture)';
  } catch (err) {
    appendLog('Capture error: ' + err.message, 'error');
  }
}

function stopCapture() {
  if (captureStream) {
    captureStream.getTracks().forEach(t => t.stop());
    captureStream = null;
  }
  mirrorVideo.srcObject = null;
  captureInfo = null;
}

// --- Coordinate mapping: video element → Android device screen ---
function getDeviceCoords(e) {
  if (!captureInfo) return null;
  const dw = captureInfo.deviceWidth;
  const dh = captureInfo.deviceHeight;
  if (!dw || !dh) return null;

  const rect = mirrorVideo.getBoundingClientRect();
  const vw = mirrorVideo.videoWidth || captureInfo.clientWidth;
  const vh = mirrorVideo.videoHeight || captureInfo.clientHeight;
  if (!vw || !vh) return null;

  // Account for object-fit: contain
  const videoRatio = vw / vh;
  const elemRatio = rect.width / rect.height;
  let displayWidth, displayHeight, offsetX, offsetY;
  if (videoRatio > elemRatio) {
    displayWidth = rect.width;
    displayHeight = rect.width / videoRatio;
    offsetX = 0;
    offsetY = (rect.height - displayHeight) / 2;
  } else {
    displayHeight = rect.height;
    displayWidth = rect.height * videoRatio;
    offsetX = (rect.width - displayWidth) / 2;
    offsetY = 0;
  }

  const relX = (e.clientX - rect.left - offsetX) / displayWidth;
  const relY = (e.clientY - rect.top - offsetY) / displayHeight;

  if (relX < 0 || relX > 1 || relY < 0 || relY > 1) return null;

  return {
    x: Math.round(relX * dw),
    y: Math.round(relY * dh),
  };
}

// Check scrcpy installation and hide path section if scrcpy is available
async function checkScrcpyPath() {
  try {
    const res = await window.scrcc.getScrcpyPath();
    if (res && (res.path || res.configured || res.inPath)) {
      // scrcpy configured or available on PATH — hide the path configuration section
      pathSection.classList.add('hidden');
    } else {
      pathSection.classList.remove('hidden');
      pathText.textContent = 'Not configured — click folder icon to set scrcpy...';
    }
  } catch (err) {
    // leave the section visible on error
    pathSection.classList.remove('hidden');
  }
}

// Initialization: check scrcpy path and auto-refresh devices
(async function init() {
  await checkScrcpyPath();
  await refreshDevices();
})();

// --- Touch gesture handling ---
const TAP_THRESHOLD = 15; // max pixels movement for a tap

mirrorVideo.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  const coords = getDeviceCoords(e);
  if (!coords) return;
  gesture = {
    startX: coords.x,
    startY: coords.y,
    startTime: Date.now(),
    lastX: coords.x,
    lastY: coords.y,
  };
});

mirrorVideo.addEventListener('mousemove', (e) => {
  if (!gesture) return;
  const coords = getDeviceCoords(e);
  if (coords) {
    gesture.lastX = coords.x;
    gesture.lastY = coords.y;
  }
});

mirrorVideo.addEventListener('mouseup', (e) => {
  if (!gesture) return;
  const coords = getDeviceCoords(e);
  if (coords) {
    gesture.lastX = coords.x;
    gesture.lastY = coords.y;
  }

  const dx = gesture.lastX - gesture.startX;
  const dy = gesture.lastY - gesture.startY;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const duration = Date.now() - gesture.startTime;

  if (dist < TAP_THRESHOLD) {
    // Tap
    window.scrcc.injectTap({ x: gesture.startX, y: gesture.startY });
  } else {
    // Swipe
    window.scrcc.injectSwipe({
      x1: gesture.startX,
      y1: gesture.startY,
      x2: gesture.lastX,
      y2: gesture.lastY,
      duration: Math.max(100, Math.min(duration, 2000)),
    });
  }

  gesture = null;
});

mirrorVideo.addEventListener('mouseleave', () => {
  gesture = null;
});

// Right-click = Back
mirrorVideo.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.scrcc.injectKey({ keycode: 4 });
});

// --- Navigation buttons ---
btnBack.addEventListener('click', () => window.scrcc.injectKey({ keycode: 4 }));
btnHome.addEventListener('click', () => window.scrcc.injectKey({ keycode: 3 }));
btnRecent.addEventListener('click', () => window.scrcc.injectKey({ keycode: 187 }));

// --- Pass-through toggle button ---
btnPassthrough.addEventListener('click', () => window.scrcc.togglePassthrough());

// --- Always on Top toggle ---
btnAlwaysOnTop.addEventListener('click', async () => {
  const isActive = btnAlwaysOnTop.classList.contains('active');
  const result = await window.scrcc.setAlwaysOnTop(!isActive);
  btnAlwaysOnTop.classList.toggle('active', result.alwaysOnTop);
  appendLog('Always on top: ' + (result.alwaysOnTop ? 'ON' : 'OFF'), 'info');
});

// --- Opacity slider ---
opacitySlider.addEventListener('input', async () => {
  const val = parseInt(opacitySlider.value) / 100;
  opacityValue.textContent = opacitySlider.value + '%';
  await window.scrcc.setOpacity(val);
});

// --- Keyboard forwarding (always active in mirror view) ---
keyboardInput.addEventListener('input', (e) => {
  const text = e.target.value;
  if (text) {
    window.scrcc.injectText(text);
    e.target.value = '';
  }
});

keyboardInput.addEventListener('keydown', (e) => {
  const keyMap = {
    'Enter': 66, 'Backspace': 67, 'Delete': 112,
    'ArrowUp': 19, 'ArrowDown': 20, 'ArrowLeft': 21, 'ArrowRight': 22,
    'Escape': 111, 'Tab': 61,
  };
  if (keyMap[e.key]) {
    e.preventDefault();
    window.scrcc.injectKey({ keycode: keyMap[e.key] });
  }
});

keyboardInput.addEventListener('blur', () => {
  // Auto-refocus removed to avoid forcing the hidden input to reappear.
});

// --- Mini mode ---
btnMiniMode.addEventListener('click', async () => {
  const result = await window.scrcc.toggleMiniMode();
  btnMiniMode.classList.toggle('active', result.mini);
  document.body.classList.toggle('mini-mode', result.mini);
  appendLog('Mini mode: ' + (result.mini ? 'ON' : 'OFF'), 'info');
});

// --- Clipboard sync ---
btnClipPull.addEventListener('click', async () => {
  const result = await window.scrcc.clipboardPull();
  if (result.success) {
    appendLog('Phone clipboard → PC: ' + result.text.substring(0, 50) + (result.text.length > 50 ? '...' : ''), 'info');
  } else {
    appendLog('Clipboard pull failed: ' + (result.error || 'unknown'), 'error');
  }
});

btnClipPush.addEventListener('click', async () => {
  const result = await window.scrcc.clipboardPush();
  if (result.success) {
    appendLog('PC clipboard → Phone: sent', 'info');
  } else {
    appendLog('Clipboard push failed: ' + (result.error || 'unknown'), 'error');
  }
});

// --- View switching ---
function switchToMirrorView() {
  controlPanel.classList.add('hidden');
  mirrorView.classList.remove('hidden');
  // Keyboard input intentionally hidden by default; do not show or focus it here.
}

function switchToControlPanel() {
  mirrorView.classList.add('hidden');
  controlPanel.classList.remove('hidden');
  btnStart.disabled = false;
  btnStop.disabled = true;
}

// --- Events ---
window.scrcc.onLog((msg) => {
  const isError = msg.toLowerCase().includes('error') || msg.toLowerCase().includes('fail');
  appendLog(msg.trim(), isError ? 'error' : '');
});

window.scrcc.onStopped((code) => {
  stopCapture();
  switchToControlPanel();
  appendLog('scrcpy process exited (code: ' + code + ')', code === 0 ? 'info' : 'error');
});

window.scrcc.onCaptureReady((info) => {
  appendLog('[STEALTH] Capture ready — device ' + info.deviceWidth + 'x' + info.deviceHeight, 'info');
  switchToMirrorView();
  startCapture(info);
});

window.scrcc.onPassthroughChanged((active) => {
  document.body.classList.toggle('passthrough', active);
  btnPassthrough.classList.toggle('active', active);
  appendLog('Mouse pass-through: ' + (active ? 'ON (Ctrl+Shift+D to interact)' : 'OFF'), 'info');
});

// Panic event — reset UI immediately
window.scrcc.onPanic(() => {
  stopCapture();
  switchToControlPanel();
  appendLog('[PANIC] Emergency exit — everything stopped', 'error');
});

// Auto-reconnect event
window.scrcc.onAutoReconnect(async () => {
  appendLog('[AUTO-RECONNECT] Reconnecting...', 'info');
  // Re-click start with the same options that were last used
  btnStart.click();
});

// --- Helpers ---
function appendLog(text, type) {
  const line = document.createElement('div');
  line.className = 'log-line';
  if (type === 'error') line.classList.add('log-error');
  if (type === 'info') line.classList.add('log-info');
  line.textContent = text;
  logOutput.appendChild(line);
  logOutput.scrollTop = logOutput.scrollHeight;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// scrcpy path browsing
btnBrowse.addEventListener('click', async () => {
  const result = await window.scrcc.browseScrcpyPath();
  if (result.error) {
    appendLog('Path error: ' + result.error, 'error');
    pathText.textContent = 'Invalid folder';
    pathSection.classList.add('path-error');
    pathSection.classList.remove('path-ok');
  } else if (result.path) {
    pathText.textContent = result.path;
    pathSection.classList.add('path-ok');
    pathSection.classList.remove('path-error');
    appendLog('scrcpy path set: ' + result.path, 'info');
  }
});

async function loadScrcpyPath() {
  const result = await window.scrcc.getScrcpyPath();
  if (result.path) {
    pathText.textContent = result.path;
    pathSection.classList.add('path-ok');
    pathSection.classList.remove('path-error');
  } else {
    pathText.textContent = 'Not configured \u2014 click folder icon to set scrcpy path';
    pathSection.classList.add('path-error');
    pathSection.classList.remove('path-ok');
  }
}

appendLog('SCRCC ready. Stealth mode active.', 'info');

// Copy log button
if (btnCopyLog) {
  btnCopyLog.addEventListener('click', async () => {
    try {
      // Gather log text
      const lines = Array.from(logOutput.querySelectorAll('.log-line'))
        .map(el => el.textContent || '')
        .join('\n');
      const textToCopy = lines || logOutput.textContent || '';

      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(textToCopy);
      } else {
        // Fallback using textarea
        const ta = document.createElement('textarea');
        ta.value = textToCopy;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      appendLog('Logs copied to clipboard', 'info');
    } catch (err) {
      appendLog('Failed to copy logs: ' + (err && err.message ? err.message : String(err)), 'error');
    }
  });
}
