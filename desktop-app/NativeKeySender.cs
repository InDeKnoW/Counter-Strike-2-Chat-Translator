using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace CS2ChatTranslator;

public static class NativeKeySender
{
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool BringWindowToTop(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern IntPtr SetActiveWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr FindWindow(string? lpClassName, string? lpWindowName);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    [DllImport("user32.dll")]
    private static extern bool GetClientRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    private static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll")]
    private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    [DllImport("user32.dll")]
    private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll")]
    private static extern uint MapVirtualKey(uint uCode, uint uMapType);

    [DllImport("user32.dll")]
    private static extern short VkKeyScan(char ch);

    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int vKey);

    [DllImport("user32.dll")]
    private static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

    private const int SW_RESTORE = 9;
    private const int SW_SHOW = 5;
    private const int VK_RETURN = 0x0D;
    private const int INPUT_KEYBOARD = 1;
    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const uint KEYEVENTF_SCANCODE = 0x0008;
    private const uint WM_KEYDOWN = 0x0100;
    private const uint WM_KEYUP = 0x0101;

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT
    {
        public int type;
        public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
        public uint unused1;
        public uint unused2;
    }

    public static IntPtr FindCs2Window()
    {
        try
        {
            // 1. Direct lookup for SDL_app / Counter-Strike 2 main window
            IntPtr hSdl = FindWindow("SDL_app", "Counter-Strike 2");
            if (hSdl != IntPtr.Zero && IsWindowVisible(hSdl))
                return hSdl;

            IntPtr hTitle = FindWindow(null, "Counter-Strike 2");
            if (hTitle != IntPtr.Zero && IsWindowVisible(hTitle))
                return hTitle;

            // 2. Process MainWindowHandle check
            var processes = Process.GetProcessesByName("cs2");
            if (processes.Length == 0) return IntPtr.Zero;

            foreach (var p in processes)
            {
                try
                {
                    if (p.MainWindowHandle != IntPtr.Zero && IsWindowVisible(p.MainWindowHandle))
                        return p.MainWindowHandle;
                }
                catch { }
            }

            uint targetPid = (uint)processes[0].Id;
            IntPtr bestMatch = IntPtr.Zero;
            IntPtr fallbackVisible = IntPtr.Zero;

            // 3. EnumWindows filtering out hidden helper/IME windows
            EnumWindows((hWnd, lParam) =>
            {
                if (!IsWindowVisible(hWnd)) return true;

                GetWindowThreadProcessId(hWnd, out uint pid);
                if (pid != targetPid) return true;

                var sbTitle = new StringBuilder(256);
                GetWindowText(hWnd, sbTitle, 256);
                string title = sbTitle.ToString();

                var sbClass = new StringBuilder(256);
                GetClassName(hWnd, sbClass, 256);
                string cls = sbClass.ToString();

                if (cls.Equals("SDL_app", StringComparison.OrdinalIgnoreCase) ||
                    title.Contains("Counter-Strike", StringComparison.OrdinalIgnoreCase))
                {
                    bestMatch = hWnd;
                    return false;
                }

                if (GetClientRect(hWnd, out RECT rc))
                {
                    int w = rc.Right - rc.Left;
                    int h = rc.Bottom - rc.Top;
                    if (w >= 640 && h >= 480)
                    {
                        fallbackVisible = hWnd;
                    }
                }

                return true;
            }, IntPtr.Zero);

            return bestMatch != IntPtr.Zero ? bestMatch : fallbackVisible;
        }
        catch
        {
            return IntPtr.Zero;
        }
    }

    public static bool FocusWindow(IntPtr cs2Hwnd)
    {
        if (cs2Hwnd == IntPtr.Zero) return false;
        if (GetForegroundWindow() == cs2Hwnd) return true;

        try
        {
            if (IsIconic(cs2Hwnd))
            {
                ShowWindow(cs2Hwnd, SW_RESTORE);
            }
            else
            {
                ShowWindow(cs2Hwnd, SW_SHOW);
            }

            IntPtr fgHwnd = GetForegroundWindow();
            uint curThread = GetCurrentThreadId();
            uint fgThread = fgHwnd != IntPtr.Zero ? GetWindowThreadProcessId(fgHwnd, out _) : 0;
            uint cs2Thread = GetWindowThreadProcessId(cs2Hwnd, out _);

            bool attachedFg = false;
            bool attachedCs2 = false;

            try
            {
                if (fgThread != 0 && fgThread != curThread)
                    attachedFg = AttachThreadInput(curThread, fgThread, true);
                if (cs2Thread != 0 && cs2Thread != curThread)
                    attachedCs2 = AttachThreadInput(curThread, cs2Thread, true);

                BringWindowToTop(cs2Hwnd);
                SetForegroundWindow(cs2Hwnd);
                SetActiveWindow(cs2Hwnd);
            }
            finally
            {
                if (attachedCs2) AttachThreadInput(curThread, cs2Thread, false);
                if (attachedFg) AttachThreadInput(curThread, fgThread, false);
            }

            // Fallback with Alt pulse only if SetForegroundWindow was blocked by Windows
            if (GetForegroundWindow() != cs2Hwnd)
            {
                keybd_event(0x12, 0, 0, UIntPtr.Zero);
                keybd_event(0x12, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
                SetForegroundWindow(cs2Hwnd);
            }

            // Wait up to 350ms for CS2 to actually become the foreground window
            var sw = Stopwatch.StartNew();
            while (GetForegroundWindow() != cs2Hwnd && sw.ElapsedMilliseconds < 350)
            {
                Thread.Sleep(15);
            }

            return GetForegroundWindow() == cs2Hwnd;
        }
        catch
        {
            return false;
        }
    }

    private static void WaitForEnterKeyRelease()
    {
        try
        {
            var sw = Stopwatch.StartNew();
            while ((GetAsyncKeyState(VK_RETURN) & 0x8000) != 0 && sw.ElapsedMilliseconds < 300)
            {
                Thread.Sleep(15);
            }
        }
        catch { }
    }

    private static void PulseKey(IntPtr cs2Hwnd, ushort vk, ushort scan)
    {
        int inputSize = Marshal.SizeOf<INPUT>();

        // 1. Hardware ScanCode + VirtualKey Down via SendInput
        INPUT[] down = new INPUT[1];
        down[0].type = INPUT_KEYBOARD;
        down[0].ki.wVk = vk;
        down[0].ki.wScan = scan;
        down[0].ki.dwFlags = KEYEVENTF_SCANCODE;
        SendInput(1, down, inputSize);

        // Also post WM_KEYDOWN to CS2 window message queue
        if (cs2Hwnd != IntPtr.Zero)
        {
            IntPtr lParamDown = (IntPtr)(1 | (scan << 16));
            PostMessage(cs2Hwnd, WM_KEYDOWN, (IntPtr)vk, lParamDown);
        }

        // Hold key for 75ms (>4 frames at 60Hz) so SDL3 raw input poll catches it reliably
        Thread.Sleep(75);

        // 2. Hardware ScanCode + VirtualKey Up via SendInput
        INPUT[] up = new INPUT[1];
        up[0].type = INPUT_KEYBOARD;
        up[0].ki.wVk = vk;
        up[0].ki.wScan = scan;
        up[0].ki.dwFlags = KEYEVENTF_SCANCODE | KEYEVENTF_KEYUP;
        SendInput(1, up, inputSize);

        // Also post WM_KEYUP to CS2 window message queue
        if (cs2Hwnd != IntPtr.Zero)
        {
            IntPtr lParamUp = (IntPtr)(1 | (scan << 16) | (1 << 30) | (1 << 31));
            PostMessage(cs2Hwnd, WM_KEYUP, (IntPtr)vk, lParamUp);
        }
    }

    public static void SendKeysToCs2(string[] keys, bool focusJustSwitched = false)
    {
        try
        {
            // 1. Wait until user releases physical Enter key from submitting the form
            WaitForEnterKeyRelease();

            // 2. Find and focus CS2 window
            IntPtr cs2Hwnd = FindCs2Window();
            bool hadFocusAlready = !focusJustSwitched && (cs2Hwnd != IntPtr.Zero && GetForegroundWindow() == cs2Hwnd);

            if (cs2Hwnd != IntPtr.Zero && !hadFocusAlready)
            {
                if (GetForegroundWindow() != cs2Hwnd)
                {
                    FocusWindow(cs2Hwnd);
                }
                // Crucial: CS2's SDL3 input system takes ~150-220ms after WM_ACTIVATE / focus switch
                // to finish "[InputSystem] Processing SDL events" and resume polling keyboard state.
                Thread.Sleep(220);
            }
            else
            {
                Thread.Sleep(60);
            }

            foreach (var keyStr in keys)
            {
                if (string.IsNullOrWhiteSpace(keyStr)) continue;
                string cleanKey = keyStr.Trim().ToLowerInvariant();
                if (cleanKey.Length == 0) continue;

                char c = cleanKey[0];
                short vkCode = VkKeyScan(c);
                ushort vk = vkCode != -1 ? (ushort)(vkCode & 0xFF) : (ushort)char.ToUpperInvariant(c);
                ushort scan = (ushort)MapVirtualKey(vk, 0);

                // Fallback explicit US scancodes for common bind keys ('o' = 0x18, 'l' = 0x26, 'p' = 0x19)
                if (scan == 0)
                {
                    scan = c switch
                    {
                        'o' => 0x18,
                        'l' => 0x26,
                        'p' => 0x19,
                        'k' => 0x25,
                        _ => 0x18
                    };
                }

                PulseKey(cs2Hwnd, vk, scan);
                Thread.Sleep(50);
            }
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"[NativeKeySender] Error: {ex.Message}");
        }
    }
}
