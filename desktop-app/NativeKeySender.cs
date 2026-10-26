using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

namespace CS2ChatTranslator;

public static class NativeKeySender
{
    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

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

    public static void SendKeysToCs2(string[] keys)
    {
        try
        {
            var processes = Process.GetProcessesByName("cs2");
            if (processes.Length > 0)
            {
                IntPtr cs2Hwnd = processes[0].MainWindowHandle;
                if (cs2Hwnd != IntPtr.Zero)
                {
                    SetForegroundWindow(cs2Hwnd);
                    Thread.Sleep(30);
                }
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

                SendInput(1, downInput, Marshal.SizeOf(typeof(INPUT)));
                keybd_event(vk, scan, 0, UIntPtr.Zero);
                Thread.Sleep(25);
                SendInput(1, upInput, Marshal.SizeOf(typeof(INPUT)));
                keybd_event(vk, scan, KEYEVENTF_KEYUP, UIntPtr.Zero);
                Thread.Sleep(30);
            }
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"[NativeKeySender] Error: {ex.Message}");
        }
    }
}
