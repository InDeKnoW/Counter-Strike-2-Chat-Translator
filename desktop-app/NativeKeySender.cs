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
    private static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

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
            var processes = Process.GetProcessesByName("cs2");
            if (processes.Length == 0) return IntPtr.Zero;

            uint targetPid = (uint)processes[0].Id;
            IntPtr found = IntPtr.Zero;

            EnumWindows((hWnd, lParam) =>
            {
                GetWindowThreadProcessId(hWnd, out uint pid);
                if (pid == targetPid)
                {
                    found = hWnd;
                    return false;
                }
                return true;
            }, IntPtr.Zero);

            return found;
        }
        catch
        {
            return IntPtr.Zero;
        }
    }

    public static void FocusWindow(IntPtr cs2Hwnd)
    {
        if (cs2Hwnd == IntPtr.Zero) return;
        if (GetForegroundWindow() == cs2Hwnd) return;

        try
        {
            keybd_event(18, 0, 0, UIntPtr.Zero);
            keybd_event(18, 0, 2, UIntPtr.Zero);
            SetForegroundWindow(cs2Hwnd);
            Thread.Sleep(60);
        }
        catch { }
    }

    public static void SendKeysToCs2(string[] keys)
    {
        try
        {
            IntPtr cs2Hwnd = FindCs2Window();
            FocusWindow(cs2Hwnd);

            foreach (var keyStr in keys)
            {
                if (string.IsNullOrWhiteSpace(keyStr)) continue;
                string cleanKey = keyStr.Trim().ToLowerInvariant();
                if (cleanKey.Length == 0) continue;

                char c = cleanKey[0];
                short vkCode = VkKeyScan(c);
                if (vkCode == -1) continue;

                ushort vk = (ushort)(vkCode & 0xFF);
                ushort scan = (ushort)MapVirtualKey(vk, 0);

                // 1. DirectInput ScanCode Down via SendInput
                INPUT[] downInput = new INPUT[1];
                downInput[0].type = INPUT_KEYBOARD;
                downInput[0].ki.wVk = 0;
                downInput[0].ki.wScan = scan;
                downInput[0].ki.dwFlags = KEYEVENTF_SCANCODE;
                SendInput(1, downInput, Marshal.SizeOf(typeof(INPUT)));

                // 2. Direct Window Message Queue KeyDown via PostMessage to CS2
                if (cs2Hwnd != IntPtr.Zero)
                {
                    IntPtr lParamDown = (IntPtr)(1 | (scan << 16));
                    PostMessage(cs2Hwnd, WM_KEYDOWN, (IntPtr)vk, lParamDown);
                }

                Thread.Sleep(60);

                // 3. DirectInput ScanCode Up via SendInput
                INPUT[] upInput = new INPUT[1];
                upInput[0].type = INPUT_KEYBOARD;
                upInput[0].ki.wVk = 0;
                upInput[0].ki.wScan = scan;
                upInput[0].ki.dwFlags = KEYEVENTF_SCANCODE | KEYEVENTF_KEYUP;
                SendInput(1, upInput, Marshal.SizeOf(typeof(INPUT)));

                // 4. Direct Window Message Queue KeyUp via PostMessage to CS2
                if (cs2Hwnd != IntPtr.Zero)
                {
                    IntPtr lParamUp = (IntPtr)(1 | (scan << 16) | (1 << 30) | (1 << 31));
                    PostMessage(cs2Hwnd, WM_KEYUP, (IntPtr)vk, lParamUp);
                }

                Thread.Sleep(40);
            }
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"[NativeKeySender] Error: {ex.Message}");
        }
    }
}
