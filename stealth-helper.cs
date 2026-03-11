using System;
using System.Runtime.InteropServices;
using System.Threading;
using System.Text;

class StealthHelper
{
    [DllImport("user32.dll")]
    static extern bool SetWindowDisplayAffinity(IntPtr hWnd, uint dwAffinity);

    [DllImport("user32.dll")]
    static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll")]
    static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    static extern uint GetWindowLong(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll")]
    static extern int SetWindowLong(IntPtr hWnd, int nIndex, uint dwNewLong);

    [DllImport("user32.dll")]
    static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);

    [DllImport("user32.dll")]
    static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

    [DllImport("user32.dll")]
    static extern int GetWindowTextLength(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);

    [DllImport("user32.dll")]
    static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    static extern bool GetClientRect(IntPtr hWnd, out RECT lpRect);

    [StructLayout(LayoutKind.Sequential)]
    struct RECT { public int Left, Top, Right, Bottom; }

    delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    const int GWL_STYLE = -16;
    const int GWL_EXSTYLE = -20;
    const uint WS_CAPTION = 0x00C00000;
    const uint WS_THICKFRAME = 0x00040000;
    const uint WS_SYSMENU = 0x00080000;
    const uint WS_MAXIMIZEBOX = 0x00010000;
    const uint WS_MINIMIZEBOX = 0x00020000;
    const uint WS_EX_TOOLWINDOW = 0x00000080;
    const uint WS_EX_APPWINDOW = 0x00040000;
    const uint WS_EX_TRANSPARENT = 0x00000020;
    const uint WS_EX_LAYERED = 0x00080000;
    const uint WS_EX_NOACTIVATE = 0x08000000;
    const uint WDA_EXCLUDEFROMCAPTURE = 0x00000011;
    const uint WDA_MONITOR = 0x00000001;
    const uint WDA_NONE = 0x00000000;
    const int SW_SHOW = 5;
    const int SW_HIDE = 0;
    static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
    static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);
    const uint SWP_NOMOVE = 0x0002;
    const uint SWP_NOSIZE = 0x0001;
    const uint SWP_SHOWWINDOW = 0x0040;
    const uint SWP_NOACTIVATE = 0x0010;
    const uint WM_LBUTTONDOWN = 0x0201;
    const uint WM_LBUTTONUP = 0x0202;
    const uint WM_MOUSEMOVE = 0x0200;
    const uint WM_RBUTTONDOWN = 0x0204;
    const uint WM_RBUTTONUP = 0x0205;
    const uint WM_KEYDOWN = 0x0100;
    const uint WM_KEYUP = 0x0101;
    const uint MK_LBUTTON = 0x0001;
    const uint MK_RBUTTON = 0x0002;

    static IntPtr MAKELPARAM(int low, int high)
    {
        return new IntPtr((high << 16) | (low & 0xFFFF));
    }

    static void Log(string msg)
    {
        Console.Error.WriteLine("[DBG] " + msg);
        Console.Error.Flush();
    }

    // Find all visible windows by PID
    static void CmdFind(string[] parts)
    {
        if (parts.Length < 2)
        {
            Console.WriteLine("ERR:usage find <pid>");
            return;
        }
        uint pid = uint.Parse(parts[1]);
        int maxWait = parts.Length >= 3 ? int.Parse(parts[2]) : 15000;
        IntPtr found = IntPtr.Zero;
        int elapsed = 0;

        Log("Finding window for PID " + pid + " (timeout " + maxWait + "ms)");

        while (elapsed < maxWait)
        {
            EnumWindowsProc callback = delegate(IntPtr hWnd, IntPtr lParam)
            {
                uint windowPid;
                GetWindowThreadProcessId(hWnd, out windowPid);
                if (windowPid == pid && IsWindowVisible(hWnd))
                {
                    StringBuilder sb = new StringBuilder(256);
                    GetWindowText(hWnd, sb, 256);
                    string title = sb.ToString();
                    Log("  Found visible window: " + hWnd.ToInt64() + " title='" + title + "'");
                    if (found == IntPtr.Zero) found = hWnd;
                }
                return true;
            };
            EnumWindows(callback, IntPtr.Zero);
            GC.KeepAlive(callback);

            if (found != IntPtr.Zero)
            {
                Console.WriteLine("FOUND:" + found.ToInt64());
                Log("Window found: " + found.ToInt64());
                return;
            }

            Thread.Sleep(500);
            elapsed += 500;
            Log("  Waiting... " + elapsed + "ms");
        }
        Console.WriteLine("ERR:timeout");
        Log("Window not found after " + maxWait + "ms");
    }

    // Apply display affinity (WDA) for screen capture protection
    static void CmdWda(string[] parts)
    {
        if (parts.Length < 3)
        {
            Console.WriteLine("ERR:usage wda <hwnd> on|off");
            return;
        }
        IntPtr hwnd = new IntPtr(long.Parse(parts[1]));
        bool enable = parts[2] == "on";
        Log("Setting WDA on " + hwnd.ToInt64() + " enable=" + enable);

        if (enable)
        {
            // Try WDA_EXCLUDEFROMCAPTURE first (Win10 2004+)
            bool ok = SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);
            Log("  WDA_EXCLUDEFROMCAPTURE result=" + ok);
            if (!ok)
            {
                // Fallback to WDA_MONITOR (Win7+, shows black to user too in captures)
                ok = SetWindowDisplayAffinity(hwnd, WDA_MONITOR);
                Log("  WDA_MONITOR fallback result=" + ok);
                if (ok)
                {
                    Console.WriteLine("OK:monitor");
                    return;
                }
                int err = Marshal.GetLastWin32Error();
                Console.WriteLine("ERR:wda_failed:" + err);
                return;
            }
            Console.WriteLine("OK:exclude");
        }
        else
        {
            SetWindowDisplayAffinity(hwnd, WDA_NONE);
            Console.WriteLine("OK:none");
        }
    }

    // Make window borderless + toolwindow (no taskbar) + always on top
    static void CmdStyle(string[] parts)
    {
        if (parts.Length < 2)
        {
            Console.WriteLine("ERR:usage style <hwnd>");
            return;
        }
        IntPtr hwnd = new IntPtr(long.Parse(parts[1]));
        Log("Styling window " + hwnd.ToInt64());

        // Remove title bar and borders
        uint style = GetWindowLong(hwnd, GWL_STYLE);
        Log("  Old style: 0x" + style.ToString("X8"));
        style = style & ~WS_CAPTION & ~WS_THICKFRAME & ~WS_SYSMENU & ~WS_MAXIMIZEBOX & ~WS_MINIMIZEBOX;
        SetWindowLong(hwnd, GWL_STYLE, style);
        Log("  New style: 0x" + style.ToString("X8"));

        // Set toolwindow (no taskbar) and remove appwindow
        uint exStyle = GetWindowLong(hwnd, GWL_EXSTYLE);
        Log("  Old exStyle: 0x" + exStyle.ToString("X8"));
        exStyle = (exStyle | WS_EX_TOOLWINDOW) & ~WS_EX_APPWINDOW;
        SetWindowLong(hwnd, GWL_EXSTYLE, exStyle);
        Log("  New exStyle: 0x" + exStyle.ToString("X8"));

        // Force repaint with the new styles
        SetWindowPos(hwnd, IntPtr.Zero, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | 0x0020 /*SWP_FRAMECHANGED*/);
        Console.WriteLine("OK");
    }

    // Move/resize window
    static void CmdPos(string[] parts)
    {
        if (parts.Length < 6)
        {
            Console.WriteLine("ERR:usage pos <hwnd> <x> <y> <w> <h>");
            return;
        }
        IntPtr hwnd = new IntPtr(long.Parse(parts[1]));
        int x = int.Parse(parts[2]);
        int y = int.Parse(parts[3]);
        int w = int.Parse(parts[4]);
        int h = int.Parse(parts[5]);

        // Use SetWindowPos with TOPMOST to keep it above other windows
        SetWindowPos(hwnd, HWND_TOPMOST, x, y, w, h, SWP_SHOWWINDOW | SWP_NOACTIVATE);
        Console.WriteLine("OK");
    }

    // Show/hide window
    static void CmdShow(string[] parts)
    {
        if (parts.Length < 3)
        {
            Console.WriteLine("ERR:usage show <hwnd> on|off");
            return;
        }
        IntPtr hwnd = new IntPtr(long.Parse(parts[1]));
        bool show = parts[2] == "on";
        ShowWindow(hwnd, show ? SW_SHOW : SW_HIDE);
        Console.WriteLine("OK");
    }

    // Forward mouse events to a window
    static void CmdMouse(string[] parts)
    {
        if (parts.Length < 5)
        {
            Console.WriteLine("ERR:usage mouse <hwnd> <down|up|move|rdown|rup> <x> <y>");
            return;
        }
        IntPtr hwnd = new IntPtr(long.Parse(parts[1]));
        string type = parts[2];
        int x = int.Parse(parts[3]);
        int y = int.Parse(parts[4]);
        IntPtr lParam = MAKELPARAM(x, y);
        uint msg; IntPtr wParam;
        switch (type)
        {
            case "down":  msg = WM_LBUTTONDOWN; wParam = new IntPtr(MK_LBUTTON); break;
            case "up":    msg = WM_LBUTTONUP;   wParam = IntPtr.Zero; break;
            case "move":  msg = WM_MOUSEMOVE;   wParam = (parts.Length >= 6 && parts[5] == "1") ? new IntPtr(MK_LBUTTON) : IntPtr.Zero; break;
            case "rdown": msg = WM_RBUTTONDOWN; wParam = new IntPtr(MK_RBUTTON); break;
            case "rup":   msg = WM_RBUTTONUP;   wParam = IntPtr.Zero; break;
            default: Console.WriteLine("ERR:unknown_mouse_type"); return;
        }
        PostMessage(hwnd, msg, wParam, lParam);
        Console.WriteLine("OK");
    }

    // Get client rect dimensions
    static void CmdRect(string[] parts)
    {
        if (parts.Length < 2)
        {
            Console.WriteLine("ERR:usage rect <hwnd>");
            return;
        }
        IntPtr hwnd = new IntPtr(long.Parse(parts[1]));
        RECT rect;
        if (GetClientRect(hwnd, out rect))
            Console.WriteLine("RECT:" + rect.Right + ":" + rect.Bottom);
        else
            Console.WriteLine("ERR:getrect_failed");
    }

    // Forward keyboard events to a window
    static void CmdKey(string[] parts)
    {
        if (parts.Length < 4)
        {
            Console.WriteLine("ERR:usage key <hwnd> <down|up> <vk>");
            return;
        }
        IntPtr hwnd = new IntPtr(long.Parse(parts[1]));
        uint msg = parts[2] == "down" ? WM_KEYDOWN : WM_KEYUP;
        int vk = int.Parse(parts[3]);
        PostMessage(hwnd, msg, new IntPtr(vk), IntPtr.Zero);
        Console.WriteLine("OK");
    }

    // Toggle Alt-Tab visibility: on = hide from Alt-Tab, off = show in Alt-Tab
    static void CmdToolWindow(string[] parts)
    {
        if (parts.Length < 3)
        {
            Console.WriteLine("ERR:usage toolwindow <hwnd> on|off");
            return;
        }
        IntPtr hwnd = new IntPtr(long.Parse(parts[1]));
        bool hide = parts[2] == "on";
        uint exStyle = GetWindowLong(hwnd, GWL_EXSTYLE);
        Log("  ToolWindow old exStyle: 0x" + exStyle.ToString("X8"));
        if (hide)
        {
            exStyle = (exStyle | WS_EX_TOOLWINDOW) & ~WS_EX_APPWINDOW;
        }
        else
        {
            exStyle = (exStyle & ~WS_EX_TOOLWINDOW) | WS_EX_APPWINDOW;
        }
        SetWindowLong(hwnd, GWL_EXSTYLE, exStyle);
        SetWindowPos(hwnd, IntPtr.Zero, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | 0x0020 /*SWP_FRAMECHANGED*/);
        Log("  ToolWindow new exStyle: 0x" + exStyle.ToString("X8"));
        Console.WriteLine("OK");
    }

    // Toggle click-through: mouse events pass through window to whatever is behind
    static void CmdClickThrough(string[] parts)
    {
        if (parts.Length < 3)
        {
            Console.WriteLine("ERR:usage clickthrough <hwnd> on|off");
            return;
        }
        IntPtr hwnd = new IntPtr(long.Parse(parts[1]));
        bool enable = parts[2] == "on";
        uint exStyle = GetWindowLong(hwnd, GWL_EXSTYLE);
        Log("  ClickThrough old exStyle: 0x" + exStyle.ToString("X8"));
        if (enable)
        {
            exStyle = exStyle | WS_EX_TRANSPARENT | WS_EX_LAYERED;
        }
        else
        {
            exStyle = exStyle & ~WS_EX_TRANSPARENT;
        }
        SetWindowLong(hwnd, GWL_EXSTYLE, exStyle);
        SetWindowPos(hwnd, IntPtr.Zero, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | 0x0020 /*SWP_FRAMECHANGED*/);
        Log("  ClickThrough new exStyle: 0x" + exStyle.ToString("X8"));
        Console.WriteLine("OK");
    }

    // Toggle no-activate: window won't steal focus when clicked
    // This prevents other apps from detecting focus loss (blur/visibilitychange)
    static void CmdNoActivate(string[] parts)
    {
        if (parts.Length < 3)
        {
            Console.WriteLine("ERR:usage noactivate <hwnd> on|off");
            return;
        }
        IntPtr hwnd = new IntPtr(long.Parse(parts[1]));
        bool enable = parts[2] == "on";
        uint exStyle = GetWindowLong(hwnd, GWL_EXSTYLE);
        Log("  NoActivate old exStyle: 0x" + exStyle.ToString("X8"));
        if (enable)
        {
            exStyle = exStyle | WS_EX_NOACTIVATE;
        }
        else
        {
            exStyle = exStyle & ~WS_EX_NOACTIVATE;
        }
        SetWindowLong(hwnd, GWL_EXSTYLE, exStyle);
        SetWindowPos(hwnd, IntPtr.Zero, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | 0x0020 /*SWP_FRAMECHANGED*/);
        Log("  NoActivate new exStyle: 0x" + exStyle.ToString("X8"));
        Console.WriteLine("OK");
    }

    static int Main(string[] args)
    {
        Console.WriteLine("READY");
        Console.Out.Flush();
        Log("Stealth helper started");
        string line;
        while ((line = Console.ReadLine()) != null)
        {
            line = line.Trim();
            if (line.Length == 0) continue;
            if (line == "exit") break;
            string[] parts = line.Split(new char[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
            Log("CMD: " + line);
            try
            {
                switch (parts[0])
                {
                    case "find": CmdFind(parts); break;
                    case "wda": CmdWda(parts); break;
                    case "style": CmdStyle(parts); break;
                    case "pos": CmdPos(parts); break;
                    case "show": CmdShow(parts); break;
                    case "mouse": CmdMouse(parts); break;
                    case "rect": CmdRect(parts); break;
                    case "key": CmdKey(parts); break;
                    case "toolwindow": CmdToolWindow(parts); break;
                    case "clickthrough": CmdClickThrough(parts); break;
                    case "noactivate": CmdNoActivate(parts); break;
                    default:
                        Console.WriteLine("ERR:unknown_command");
                        break;
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine("ERR:" + ex.Message);
                Log("Exception: " + ex.ToString());
            }
            Console.Out.Flush();
        }
        Log("Stealth helper exiting");
        return 0;
    }
}
