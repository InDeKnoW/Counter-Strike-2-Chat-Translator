using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace CS2ChatTranslator;

public static class NativeKeySender
{
    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr FindWindow(string? lpClassName, string? lpWindowName);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern bool BringWindowToTop(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    private static extern IntPtr SetFocus(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    [DllImport("user32.dll")]
    private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

    [DllImport("user32.dll")]
    private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll")]
    private static extern uint MapVirtualKey(uint uCode, uint uMapType);

    [DllImport("user32.dll")]
    private static extern short VkKeyScan(char ch);

    [DllImport("user32.dll")]
    private static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

    [DllImport("user32.dll")]
    private static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr OpenDesktop(string lpszDesktop, uint dwFlags, bool fInherit, uint dwDesiredAccess);

    [DllImport("user32.dll")]
    private static extern bool EnumDesktopWindows(IntPtr hDesktop, EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassNameW(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextW(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    private const int INPUT_KEYBOARD = 1;
    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const uint KEYEVENTF_SCANCODE = 0x0008;

    private const uint WM_KEYDOWN = 0x0100;
    private const uint WM_KEYUP = 0x0101;

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
            // 1. Direct FindWindow
            IntPtr hwnd = FindWindow("SDL_app", "Counter-Strike 2");
            if (hwnd != IntPtr.Zero) return hwnd;

            hwnd = FindWindow(null, "Counter-Strike 2");
            if (hwnd != IntPtr.Zero) return hwnd;

            // 2. Search by CS2 process ID
            var procs = Process.GetProcessesByName("cs2");
            if (procs.Length > 0)
            {
                uint cs2Pid = (uint)procs[0].Id;
                IntPtr found = IntPtr.Zero;

                EnumWindows((h, l) =>
                {
                    GetWindowThreadProcessId(h, out uint pid);
                    if (pid == cs2Pid)
                    {
                        StringBuilder cls = new StringBuilder(256);
                        GetClassNameW(h, cls, 256);
                        if (cls.ToString() == "SDL_app")
                        {
                            found = h;
                            return false;
                        }
                        if (found == IntPtr.Zero) found = h;
                    }
                    return true;
                }, IntPtr.Zero);

                if (found != IntPtr.Zero) return found;

                // 3. Search interactive Default desktop if on another desktop
                try
                {
                    IntPtr hDesk = OpenDesktop("Default", 0, false, 0x01FF);
                    if (hDesk != IntPtr.Zero)
                    {
                        EnumDesktopWindows(hDesk, (h, l) =>
                        {
                            GetWindowThreadProcessId(h, out uint pid);
                            if (pid == cs2Pid)
                            {
                                StringBuilder cls = new StringBuilder(256);
                                GetClassNameW(h, cls, 256);
                                if (cls.ToString() == "SDL_app")
                                {
                                    found = h;
                                    return false;
                                }
                                if (found == IntPtr.Zero) found = h;
                            }
                            return true;
                        }, IntPtr.Zero);
                    }
                }
                catch { }

                if (found != IntPtr.Zero) return found;
            }
        }
        catch { }

        return IntPtr.Zero;
    }

    public static void FocusWindow(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero) return;

        try
        {
            uint targetThread = GetWindowThreadProcessId(hwnd, out _);
            uint currentThread = GetCurrentThreadId();
            IntPtr foregroundHwnd = GetForegroundWindow();
            uint foregroundThread = (foregroundHwnd != IntPtr.Zero) ? GetWindowThreadProcessId(foregroundHwnd, out _) : 0;

            if (targetThread != 0 && targetThread != currentThread)
            {
                AttachThreadInput(currentThread, targetThread, true);
            }
            if (foregroundThread != 0 && targetThread != 0 && foregroundThread != targetThread)
            {
                AttachThreadInput(foregroundThread, targetThread, true);
            }

            // Pulse Alt to break focus stealing lock
            keybd_event(0x12, 0, 0, UIntPtr.Zero);
            keybd_event(0x12, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);

            ShowWindow(hwnd, 9 /* SW_RESTORE */);
            SetForegroundWindow(hwnd);
            BringWindowToTop(hwnd);
            SetFocus(hwnd);

            // Wait briefly for focus switch to complete
            for (int i = 0; i < 20; i++)
            {
                if (GetForegroundWindow() == hwnd) break;
                Thread.Sleep(10);
            }

            if (targetThread != 0 && targetThread != currentThread)
            {
                AttachThreadInput(currentThread, targetThread, false);
            }
            if (foregroundThread != 0 && targetThread != 0 && foregroundThread != targetThread)
            {
                AttachThreadInput(foregroundThread, targetThread, false);
            }
        }
        catch { }
    }

    public static void SendKeysToCs2(string[] keys)
    {
        try
        {
            IntPtr cs2Hwnd = FindCs2Window();
            if (cs2Hwnd != IntPtr.Zero)
            {
                FocusWindow(cs2Hwnd);
                Thread.Sleep(50);
            }

            foreach (var keyStr in keys)
            {
                if (string.IsNullOrWhiteSpace(keyStr)) continue;
                string cleanKey = keyStr.Trim().ToLowerInvariant();
                if (cleanKey.Length == 0) continue;

                char c = cleanKey[0];
                short vkCode = VkKeyScan(c);
                byte vk = (byte)(vkCode & 0xFF);
                byte scan = (byte)MapVirtualKey(vk, 0);

                if (c == 'o' && scan == 0) scan = 0x18;
                if (c == 'l' && scan == 0) scan = 0x26;

                INPUT[] downInput = new INPUT[1];
                downInput[0].type = INPUT_KEYBOARD;
                downInput[0].ki.wVk = vk;
                downInput[0].ki.wScan = scan;
                downInput[0].ki.dwFlags = KEYEVENTF_SCANCODE;

                INPUT[] upInput = new INPUT[1];
                upInput[0].type = INPUT_KEYBOARD;
                upInput[0].ki.wVk = vk;
                upInput[0].ki.wScan = scan;
                upInput[0].ki.dwFlags = KEYEVENTF_SCANCODE | KEYEVENTF_KEYUP;

                // Send via SendInput
                SendInput(1, downInput, Marshal.SizeOf(typeof(INPUT)));
                // Send via keybd_event
                keybd_event(vk, scan, 0, UIntPtr.Zero);
                // Also PostMessage fallback
                if (cs2Hwnd != IntPtr.Zero)
                {
                    IntPtr lParamDown = (IntPtr)(1 | (scan << 16));
                    PostMessage(cs2Hwnd, WM_KEYDOWN, (IntPtr)vk, lParamDown);
                }

                Thread.Sleep(45);

                SendInput(1, upInput, Marshal.SizeOf(typeof(INPUT)));
                keybd_event(vk, scan, KEYEVENTF_KEYUP, UIntPtr.Zero);
                if (cs2Hwnd != IntPtr.Zero)
                {
                    IntPtr lParamUp = (IntPtr)(1 | (scan << 16) | (1 << 30) | (1 << 31));
                    PostMessage(cs2Hwnd, WM_KEYUP, (IntPtr)vk, lParamUp);
                }

                Thread.Sleep(35);
            }
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"[NativeKeySender] Error: {ex.Message}");
        }
    }
}
