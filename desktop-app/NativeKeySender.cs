using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
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
    private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    [DllImport("user32.dll")]
    private static extern bool AllowSetForegroundWindow(int dwProcessId);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    private static extern IntPtr FindWindow(string? lpClassName, string? lpWindowName);

    [DllImport("user32.dll")]
    private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll")]
    private static extern uint MapVirtualKey(uint uCode, uint uMapType);

    [DllImport("user32.dll")]
    private static extern short VkKeyScan(char ch);

    [DllImport("user32.dll")]
    private static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

    private const int INPUT_KEYBOARD = 1;
    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const uint KEYEVENTF_SCANCODE = 0x0008;
    private const int SW_RESTORE = 9;
    private const byte VK_MENU = 0x12;

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

    private static IntPtr FindCs2Window()
    {
        try
        {
            var processes = Process.GetProcessesByName("cs2");
            foreach (var p in processes)
            {
                if (p.MainWindowHandle != IntPtr.Zero)
                    return p.MainWindowHandle;
            }
        }
        catch { }

        IntPtr hwnd = FindWindow("SDL_app", "Counter-Strike 2");
        if (hwnd != IntPtr.Zero) return hwnd;

        return FindWindow(null, "Counter-Strike 2");
    }

    private static bool FocusCs2Window(IntPtr cs2Hwnd)
    {
        if (cs2Hwnd == IntPtr.Zero) return false;
        if (GetForegroundWindow() == cs2Hwnd) return true;

        try
        {
            AllowSetForegroundWindow(-1);
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

                if (IsIconic(cs2Hwnd))
                    ShowWindow(cs2Hwnd, SW_RESTORE);

                BringWindowToTop(cs2Hwnd);
                if (!SetForegroundWindow(cs2Hwnd))
                {
                    // Bypass Windows foreground lock via synthetic Alt key state
                    keybd_event(VK_MENU, 0, 0, UIntPtr.Zero);
                    SetForegroundWindow(cs2Hwnd);
                    BringWindowToTop(cs2Hwnd);
                    keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
                }
            }
            finally
            {
                if (attachedCs2) AttachThreadInput(curThread, cs2Thread, false);
                if (attachedFg) AttachThreadInput(curThread, fgThread, false);
            }

            for (int i = 0; i < 16; i++)
            {
                if (GetForegroundWindow() == cs2Hwnd)
                {
                    // Give CS2 SDL3/RawInput loop time to activate after regaining focus
                    Thread.Sleep(120);
                    return true;
                }
                Thread.Sleep(15);
            }
        }
        catch { }

        return GetForegroundWindow() == cs2Hwnd;
    }

    public static void SendKeysToCs2(string[] keys)
    {
        try
        {
            IntPtr cs2Hwnd = FindCs2Window();
            if (cs2Hwnd == IntPtr.Zero)
                return;

            FocusCs2Window(cs2Hwnd);

            foreach (var keyStr in keys)
            {
                if (string.IsNullOrWhiteSpace(keyStr)) continue;
                string cleanKey = keyStr.Trim().ToLowerInvariant();
                if (cleanKey.Length == 0) continue;

                char c = cleanKey[0];
                short vkCode = VkKeyScan(c);
                byte vk = (byte)(vkCode & 0xFF);
                if (c >= 'a' && c <= 'z')
                {
                    vk = (byte)char.ToUpperInvariant(c);
                }
                ushort scan = (ushort)MapVirtualKey(vk, 0);

                INPUT[] downInput = new INPUT[1];
                downInput[0].type = INPUT_KEYBOARD;
                downInput[0].ki.wVk = 0;
                downInput[0].ki.wScan = scan;
                downInput[0].ki.dwFlags = KEYEVENTF_SCANCODE;

                INPUT[] upInput = new INPUT[1];
                upInput[0].type = INPUT_KEYBOARD;
                upInput[0].ki.wVk = 0;
                upInput[0].ki.wScan = scan;
                upInput[0].ki.dwFlags = KEYEVENTF_SCANCODE | KEYEVENTF_KEYUP;

                SendInput(1, downInput, Marshal.SizeOf(typeof(INPUT)));
                Thread.Sleep(55);
                SendInput(1, upInput, Marshal.SizeOf(typeof(INPUT)));
                Thread.Sleep(35);
            }
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"[NativeKeySender] Error: {ex.Message}");
        }
    }
}
