using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public class KeySender
{
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] private static extern bool AllowSetForegroundWindow(int dwProcessId);
    [DllImport("user32.dll", CharSet = CharSet.Auto)] private static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
    [DllImport("user32.dll")] private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
    [DllImport("user32.dll")] private static extern uint MapVirtualKey(uint uCode, uint uMapType);
    [DllImport("user32.dll")] private static extern short VkKeyScan(char ch);
    [DllImport("user32.dll")] private static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr OpenDesktop(string lpszDesktop, uint dwFlags, bool fInherit, uint dwDesiredAccess);
    [DllImport("user32.dll")] private static extern bool EnumDesktopWindows(IntPtr hDesktop, EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassNameW(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

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

    public static IntPtr FindCs2Window()
    {
        IntPtr hwnd = FindWindow("SDL_app", "Counter-Strike 2");
        if (hwnd != IntPtr.Zero) return hwnd;

        hwnd = FindWindow(null, "Counter-Strike 2");
        if (hwnd != IntPtr.Zero) return hwnd;

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

    public static bool FocusCs2Window(IntPtr cs2Hwnd)
    {
        if (cs2Hwnd == IntPtr.Zero) return false;
        if (GetForegroundWindow() == cs2Hwnd) return true;

        try
        {
            AllowSetForegroundWindow(-1);
            IntPtr fgHwnd = GetForegroundWindow();
            uint curThread = GetCurrentThreadId();
            uint dummy;
            uint fgThread = fgHwnd != IntPtr.Zero ? GetWindowThreadProcessId(fgHwnd, out dummy) : 0;
            uint cs2Thread = GetWindowThreadProcessId(cs2Hwnd, out dummy);

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

            for (int i = 0; i < 20; i++)
            {
                if (GetForegroundWindow() == cs2Hwnd)
                {
                    Thread.Sleep(140);
                    return true;
                }
                Thread.Sleep(15);
            }
        }
        catch { }

        return GetForegroundWindow() == cs2Hwnd;
    }

    public static void SendKey(char c)
    {
        short vkCode = VkKeyScan(c);
        byte vk = (byte)(vkCode & 0xFF);
        if (c >= 'a' && c <= 'z')
        {
            vk = (byte)char.ToUpperInvariant(c);
        }
        ushort scan = (ushort)MapVirtualKey(vk, 0);
        if (char.ToLowerInvariant(c) == 'o' && scan == 0) scan = 0x18;

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
        Thread.Sleep(65);
        SendInput(1, upInput, Marshal.SizeOf(typeof(INPUT)));
        Thread.Sleep(40);
    }

    public static int Main(string[] args)
    {
        try
        {
            IntPtr cs2Hwnd = FindCs2Window();
            Console.WriteLine("[KeySender] Target CS2 HWND: 0x" + cs2Hwnd.ToString("X"));

            if (cs2Hwnd != IntPtr.Zero)
            {
                FocusCs2Window(cs2Hwnd);
            }

            char key = 'o';
            if (args != null && args.Length > 0)
            {
                foreach (string arg in args)
                {
                    string clean = arg.Trim().ToLowerInvariant();
                    if (clean.StartsWith("-")) continue;
                    if (clean.Length > 0) { key = clean[0]; break; }
                }
            }

            Console.WriteLine("[KeySender] Sending key: " + key);
            SendKey(key);

            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("[KeySender] Error: " + ex.Message);
            return 1;
        }
    }
}
