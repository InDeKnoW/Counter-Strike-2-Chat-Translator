using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public class KeySender
{
    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr FindWindow(string lpClassName, string lpWindowName);

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
        // 1. Direct FindWindow
        IntPtr hwnd = FindWindow("SDL_app", "Counter-Strike 2");
        if (hwnd != IntPtr.Zero) return hwnd;

        hwnd = FindWindow(null, "Counter-Strike 2");
        if (hwnd != IntPtr.Zero) return hwnd;

        // 2. Search by CS2 process ID
        Process[] procs = Process.GetProcessesByName("cs2");
        if (procs.Length > 0)
        {
            uint cs2Pid = (uint)procs[0].Id;
            IntPtr found = IntPtr.Zero;

            EnumWindows(delegate(IntPtr h, IntPtr l)
            {
                uint pid;
                GetWindowThreadProcessId(h, out pid);
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
                    EnumDesktopWindows(hDesk, delegate(IntPtr h, IntPtr l)
                    {
                        uint pid;
                        GetWindowThreadProcessId(h, out pid);
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

        return IntPtr.Zero;
    }

    public static void FocusWindow(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero) return;

        try
        {
            uint dummyPid;
            uint targetThread = GetWindowThreadProcessId(hwnd, out dummyPid);
            uint currentThread = GetCurrentThreadId();
            IntPtr foregroundHwnd = GetForegroundWindow();
            uint foregroundThread = 0;
            if (foregroundHwnd != IntPtr.Zero)
            {
                uint dummyFgPid;
                foregroundThread = GetWindowThreadProcessId(foregroundHwnd, out dummyFgPid);
            }

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

    public static void SendKey(IntPtr hwnd, char key)
    {
        short vkScan = VkKeyScan(key);
        byte vk = (byte)(vkScan & 0xFF);
        byte scan = (byte)MapVirtualKey(vk, 0);

        // Hardware scan code for 'o' is 0x18
        if (char.ToLowerInvariant(key) == 'o' && scan == 0) scan = 0x18;
        if (char.ToLowerInvariant(key) == 'l' && scan == 0) scan = 0x26;

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

        // Method 1: SendInput (scancode)
        SendInput(1, downInput, Marshal.SizeOf(typeof(INPUT)));
        // Method 2: keybd_event (scancode & vk)
        keybd_event(vk, scan, 0, UIntPtr.Zero);
        // Method 3: PostMessage directly to window
        if (hwnd != IntPtr.Zero)
        {
            IntPtr lParamDown = (IntPtr)(1 | (scan << 16));
            PostMessage(hwnd, WM_KEYDOWN, (IntPtr)vk, lParamDown);
        }

        Thread.Sleep(45);

        SendInput(1, upInput, Marshal.SizeOf(typeof(INPUT)));
        keybd_event(vk, scan, KEYEVENTF_KEYUP, UIntPtr.Zero);
        if (hwnd != IntPtr.Zero)
        {
            IntPtr lParamUp = (IntPtr)(1 | (scan << 16) | (1 << 30) | (1 << 31));
            PostMessage(hwnd, WM_KEYUP, (IntPtr)vk, lParamUp);
        }

        Thread.Sleep(30);
    }

    public static int Main(string[] args)
    {
        try
        {
            IntPtr cs2Hwnd = FindCs2Window();
            Console.WriteLine("[KeySender] Target CS2 HWND: 0x" + cs2Hwnd.ToString("X"));

            if (cs2Hwnd != IntPtr.Zero)
            {
                FocusWindow(cs2Hwnd);
                Thread.Sleep(60);
            }

            char[] keysToSend;
            if (args != null && args.Length > 0)
            {
                var list = new System.Collections.Generic.List<char>();
                foreach (string arg in args)
                {
                    string clean = arg.Trim();
                    if (clean.StartsWith("-")) continue;
                    foreach (char c in clean)
                    {
                        if (char.IsLetterOrDigit(c)) list.Add(c);
                    }
                }
                keysToSend = list.Count > 0 ? list.ToArray() : new char[] { 'o' };
            }
            else
            {
                keysToSend = new char[] { 'o' };
            }

            foreach (char k in keysToSend)
            {
                Console.WriteLine("[KeySender] Sending key: " + k);
                SendKey(cs2Hwnd, k);
            }

            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("[KeySender] Error: " + ex.Message);
            return 1;
        }
    }
}
