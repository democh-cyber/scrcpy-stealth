# scrcc — Stealth scrcpy Client

An Electron desktop app that runs [scrcpy](https://github.com/Genymobile/scrcpy) off-screen and mirrors your Android device inside a **fully capture-proof window** — invisible to screen recording software, screen-sharing tools (Teams, Zoom, OBS), and proctoring systems.

---

## Screenshots

<p align="center">
  <img src="https://github.com/user-attachments/assets/ac40558f-aab0-49b3-8271-82750336f92b" width="45%" />
  <img src="https://github.com/user-attachments/assets/bb07088f-7f9d-4c91-a456-83ad44d823ec" width="45%" />
</p>

<p align="center">
  <img src="https://github.com/user-attachments/assets/3181bfde-f060-46c7-8b18-d6ce2f4eec1b" width="45%" />
  <img src="https://github.com/user-attachments/assets/f10f5dfe-c29d-45a5-8d34-1448ce4f1930" width="45%" />
</p>


## Features

### Stealth & Privacy
- **WDA_EXCLUDEFROMCAPTURE** — Windows Display Affinity API makes both the app window and the off-screen scrcpy window completely invisible to any screen capture (Teams, Zoom, OBS, Windows Snip, etc.)
- **Alt-Tab hidden** — app does not appear in the Alt-Tab switcher (`WS_EX_TOOLWINDOW`)
- **Focus guard** — clicking the window does not trigger a tab-switch detection event (`WS_EX_NOACTIVATE`)
- **Mouse pass-through** — toggle `WS_EX_LAYERED | WS_EX_TRANSPARENT` so clicks go through the window (`Ctrl+Shift+D`)
- **Always on top** — stays above all other windows
- **Adjustable opacity** — slider from 10 % to 100 %
- **Panic key** (`Ctrl+Shift+Q`) — instantly kills scrcpy + ADB, clears clipboard, hides window
- **Show/hide hotkey** (`Ctrl+Shift+S`) — toggle visibility without touching the taskbar

### Mirroring
- **Off-screen capture** — scrcpy runs at −32000, −32000 (invisible to the user) and its window is captured via Electron's `desktopCapturer` API and rendered in a `<video>` element inside the app
- **Touch injection** — tap and swipe gestures on the mirror are forwarded to the phone via `adb shell input`
- **Keyboard forwarding** — type into the mirror view; keystrokes sent via `adb shell input text`
- **Android nav buttons** — Back, Home, Recents injected as ADB keycodes
- **Clipboard sync** — push PC clipboard to phone or pull phone clipboard to PC

### Device Management
- **Auto-detect** — scans for ADB devices on startup
- **Wireless ADB** — connect to a device by IP address (`adb connect`)
- **Auto-reconnect** — if scrcpy exits unexpectedly, it reconnects automatically (configurable)
- **Device selector** — pick from multiple connected devices

### Configuration
- **scrcpy path auto-detect** — finds scrcpy on `PATH`, in a bundled `scrcpy/` folder, or via manual browse; path section hidden when scrcpy is found automatically
- **Per-session options** — max resolution (up to 2560), bitrate (1 M–16 M), FPS cap (15–60), turn screen off, stay awake, no audio, record to video
- **Window bounds persistence** — remembers size and position across restarts
- **Mini mode** — compact overlay view for minimal screen real estate

---

## Requirements

| Dependency | Notes |
|---|---|
| [scrcpy](https://github.com/Genymobile/scrcpy) | v2.x recommended; must be on `PATH` or in a `scrcpy/` folder next to the app |
| [ADB](https://developer.android.com/tools/adb) | Bundled with scrcpy; also accepted on `PATH` |
| Windows 10 / 11 | Required for `WDA_EXCLUDEFROMCAPTURE` (Windows Display Affinity API) |
| Android device | USB debugging enabled, or wireless ADB (Android 11+) |

---

## Setup

### Development

```bash
git clone https://github.com/democh-cyber/scrcpy-stealth.git
cd scrcc
npm install
```

Place `scrcpy.exe`, `adb.exe`, and their DLLs in a `scrcpy/` folder inside the project, **or** ensure `scrcpy` is on your `PATH`.

```bash
npm start
```

### Build (portable .exe)

Compile the native helper first (requires .NET SDK or `csc`):

```bash
csc -out:stealth-helper.exe stealth-helper.cs
```

Then build the portable executable:

```bash
npx electron-builder --win portable
# Output: dist/RuntimeBroker.exe
```

The build bundles `stealth-helper.exe` and the `scrcpy/` folder automatically (if present).

---

## Hotkeys

| Hotkey | Action |
|---|---|
| `Ctrl+Shift+S` | Show / hide the app window |
| `Ctrl+Shift+D` | Toggle mouse pass-through (clicks go through the window) |
| `Ctrl+Shift+Q` | **Panic** — kill scrcpy + ADB, clear clipboard, hide window |

---

## Architecture

```
scrcc/
├── main.js              # Electron main process — scrcpy lifecycle, IPC, stealth
├── preload.js           # Context bridge — exposes window.scrcc API to renderer
├── stealth-helper.cs    # C# native helper — Win32 WDA / window style commands
├── stealth-helper.exe   # Compiled helper (communicates via stdin/stdout)
└── renderer/
    ├── index.html       # UI shell
    ├── renderer.js      # UI logic — device list, mirror, input forwarding
    └── style.css        # Dark theme
```

### Stealth helper protocol

`stealth-helper.exe` is a persistent child process, controlled by line-delimited commands over stdin:

| Command | Description |
|---|---|
| `find <pid>` | Find the top-level window for process PID → `FOUND:<hwnd>` |
| `wda <hwnd> on\|off` | Set / clear `WDA_EXCLUDEFROMCAPTURE` |
| `style <hwnd>` | Apply `WS_EX_TOOLWINDOW` (hide from taskbar + Alt-Tab) |
| `toolwindow <hwnd> on\|off` | Toggle `WS_EX_TOOLWINDOW` |
| `noactivate <hwnd> on\|off` | Toggle `WS_EX_NOACTIVATE` (focus guard) |
| `clickthrough <hwnd> on\|off` | Toggle `WS_EX_LAYERED \| WS_EX_TRANSPARENT` (mouse pass-through) |
| `rect <hwnd>` | Get client area → `RECT:<w>:<h>` |
| `exit` | Shut down the helper |

---

## Privacy note

This tool is intended for **personal device management and privacy** — e.g. using your phone during a video call without participants seeing your screen. It does not intercept, exfiltrate, or modify any data beyond mirroring your own device. All communication is local (ADB over USB or local Wi-Fi).

---

## License

MIT
- **Custom Frameless UI** — Dark-themed, modern interface

## Prerequisites

1. **scrcpy** — Download from [github.com/Genymobile/scrcpy](https://github.com/Genymobile/scrcpy/releases) and either:
   - Place the extracted `scrcpy` folder inside this project directory, **OR**
   - Add scrcpy to your system `PATH`
2. **ADB** — Included with scrcpy, or install via Android SDK
3. **Node.js** ≥ 18

## Setup

```bash
npm install
```

## Run

```bash
npm start
```

## Build

```bash
npm run dist
```

## Project Structure

```
scrcc/
├── main.js           # Electron main process
├── preload.js        # Secure bridge (contextIsolation)
├── renderer/
│   ├── index.html    # UI layout
│   ├── style.css     # Dark theme styles
│   └── renderer.js   # UI logic
├── scrcpy/           # (optional) bundled scrcpy binaries
└── package.json
```

## How Stealth Works

`mainWindow.setContentProtection(true)` uses the OS-level DRM flag (`SetWindowDisplayAffinity` on Windows) to make the window appear blank in any screen capture, OBS, Discord screen share, etc. You can toggle it on/off from the app UI.
