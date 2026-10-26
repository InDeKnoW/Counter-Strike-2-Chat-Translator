using System;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Interop;

namespace CS2ChatTranslator;

public partial class MainWindow : Window
{
    private readonly ServerManager _serverManager = new();
    private readonly System.Windows.Threading.DispatcherTimer _gameCheckTimer = new();
    private bool _isServerOnline = false;
    private bool _isHudMode = false;
    private bool? _lastGameRunning = null;
    private double _previousHeight = 600;

    private const int WM_GETMINMAXINFO = 0x0024;
    private const int WM_NCLBUTTONDOWN = 0x00A1;
    private const int HTCAPTION = 0x0002;

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT
    {
        public int x;
        public int y;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MINMAXINFO
    {
        public POINT ptReserved;
        public POINT ptMaxSize;
        public POINT ptMaxPosition;
        public POINT ptMinTrackSize;
        public POINT ptMaxTrackSize;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT
    {
        public int left;
        public int top;
        public int right;
        public int bottom;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
    public class MONITORINFO
    {
        public int cbSize = Marshal.SizeOf(typeof(MONITORINFO));
        public RECT rcMonitor;
        public RECT rcWork;
        public int dwFlags;
    }

    private static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
    private static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);
    private const uint SWP_NOMOVE = 0x0002;
    private const uint SWP_NOSIZE = 0x0001;
    private const uint SWP_SHOWWINDOW = 0x0040;

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

    [DllImport("user32.dll")]
    private static extern bool ReleaseCapture();

    [DllImport("user32.dll")]
    private static extern IntPtr SendMessage(IntPtr hWnd, int Msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromWindow(IntPtr handle, uint flags);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    private static extern bool GetMonitorInfo(IntPtr hMonitor, MONITORINFO lpmi);

    public MainWindow()
    {
        InitializeComponent();
        Loaded += MainWindow_Loaded;
        Closing += MainWindow_Closing;
    }

    protected override void OnSourceInitialized(EventArgs e)
    {
        base.OnSourceInitialized(e);
        try
        {
            var handle = new WindowInteropHelper(this).Handle;
            var source = HwndSource.FromHwnd(handle);
            source?.AddHook(WindowProc);
        }
        catch { }
    }

    private IntPtr WindowProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        if (msg == WM_GETMINMAXINFO)
        {
            WmGetMinMaxInfo(hwnd, lParam);
            handled = true;
        }
        return IntPtr.Zero;
    }

    private static void WmGetMinMaxInfo(IntPtr hwnd, IntPtr lParam)
    {
        try
        {
            MINMAXINFO mmi = (MINMAXINFO)Marshal.PtrToStructure(lParam, typeof(MINMAXINFO))!;
            IntPtr monitor = MonitorFromWindow(hwnd, 0x00000002 /* MONITOR_DEFAULTTONEAREST */);
            if (monitor != IntPtr.Zero)
            {
                MONITORINFO monitorInfo = new MONITORINFO();
                GetMonitorInfo(monitor, monitorInfo);
                RECT rcWork = monitorInfo.rcWork;
                RECT rcMonitor = monitorInfo.rcMonitor;

                mmi.ptMaxPosition.x = Math.Abs(rcWork.left - rcMonitor.left);
                mmi.ptMaxPosition.y = Math.Abs(rcWork.top - rcMonitor.top);
                mmi.ptMaxSize.x = Math.Abs(rcWork.right - rcWork.left);
                mmi.ptMaxSize.y = Math.Abs(rcWork.bottom - rcWork.top);
            }
            Marshal.StructureToPtr(mmi, lParam, true);
        }
        catch { }
    }

    private async void MainWindow_Loaded(object sender, RoutedEventArgs e)
    {
        ApplyTopmost(false);
        _gameCheckTimer.Interval = TimeSpan.FromSeconds(3);
        _gameCheckTimer.Tick += (s, ev) => CheckGameStatus(false);
        _gameCheckTimer.Start();
        await StartAndConnectAsync();
    }

    private async Task StartAndConnectAsync()
    {
        LoadingOverlay.Visibility = Visibility.Visible;
        LoadingBar.Visibility = Visibility.Visible;
        BtnRetry.Visibility = Visibility.Collapsed;

        bool running = await _serverManager.EnsureServerRunningAsync(msg =>
        {
            Dispatcher.Invoke(() => LoadingStatus.Text = msg);
        });

        if (!running)
        {
            LoadingStatus.Text = "Nem sikerült elindítani a háttérszervert.\nKérlek ellenőrizd, hogy a Node.js telepítve van-e.";
            LoadingBar.Visibility = Visibility.Collapsed;
            BtnRetry.Visibility = Visibility.Visible;
            _isServerOnline = false;
            return;
        }

        try
        {
            LoadingStatus.Text = "Böngésző motor előkészítése (WebView2)...";

            string userDataFolder = System.IO.Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "CS2ChatTranslator",
                "WebView2Data"
            );
            var envOptions = new Microsoft.Web.WebView2.Core.CoreWebView2EnvironmentOptions
            {
                AdditionalBrowserArguments = "--disable-features=SpeechRecognition,msSpeechRecognition --disable-speech-api"
            };
            var env = await Microsoft.Web.WebView2.Core.CoreWebView2Environment.CreateAsync(null, userDataFolder, envOptions);
            await ChatWebView.EnsureCoreWebView2Async(env);

            ChatWebView.DefaultBackgroundColor = System.Drawing.Color.FromArgb(255, 11, 11, 12);
            ChatWebView.CoreWebView2.Settings.IsStatusBarEnabled = false;
            ChatWebView.CoreWebView2.Settings.AreBrowserAcceleratorKeysEnabled = true;

            ChatWebView.WebMessageReceived += (s, e) =>
            {
                try
                {
                    using var doc = System.Text.Json.JsonDocument.Parse(e.WebMessageAsJson);
                    var root = doc.RootElement;
                    if (!root.TryGetProperty("type", out var typeProp)) return;
                    string? type = typeProp.GetString();

                    switch (type)
                    {
                        case "dragMove":
                            StartDrag();
                            break;

                        case "toggleMaximize":
                            WindowState = (WindowState == WindowState.Maximized) ? WindowState.Normal : WindowState.Maximized;
                            break;

                        case "minimize":
                            WindowState = WindowState.Minimized;
                            break;

                        case "maximize":
                            WindowState = (WindowState == WindowState.Maximized) ? WindowState.Normal : WindowState.Maximized;
                            break;

                        case "close":
                            Close();
                            break;

                        case "togglePin":
                            bool pin = root.TryGetProperty("isPinned", out var pinProp) ? pinProp.GetBoolean() : !Topmost;
                            ApplyTopmost(pin);
                            break;

                        case "toggleHud":
                            bool isHud = root.TryGetProperty("isHud", out var hudProp) ? hudProp.GetBoolean() : !_isHudMode;
                            _isHudMode = isHud;
                            ApplyHudHeight(isHud);
                            break;
                    }
                }
                catch { }
            };

            ChatWebView.NavigationCompleted += (s, e) =>
            {
                CheckGameStatus(true);
                if (_isHudMode && ChatWebView?.CoreWebView2 != null)
                {
                    _ = ChatWebView.CoreWebView2.ExecuteScriptAsync("if (window.setHudMode) window.setHudMode(true);");
                }
            };

            ChatWebView.Source = new Uri(_serverManager.ServerUrl);
            ChatWebView.Visibility = Visibility.Visible;
            LoadingOverlay.Visibility = Visibility.Collapsed;
            _isServerOnline = true;
            CheckGameStatus(true);
        }
        catch (Exception ex)
        {
            LoadingStatus.Text = $"WebView2 inicializálási hiba: {ex.Message}";
            LoadingBar.Visibility = Visibility.Collapsed;
            BtnRetry.Visibility = Visibility.Visible;
            _isServerOnline = false;
        }
    }

    private void StartDrag()
    {
        try
        {
            var handle = new WindowInteropHelper(this).Handle;
            if (handle != IntPtr.Zero)
            {
                ReleaseCapture();
                SendMessage(handle, WM_NCLBUTTONDOWN, (IntPtr)HTCAPTION, IntPtr.Zero);
            }
        }
        catch { }
    }

    private async void BtnRetry_Click(object sender, RoutedEventArgs e)
    {
        await StartAndConnectAsync();
    }

    private void ApplyTopmost(bool enable)
    {
        Topmost = enable;
        try
        {
            var handle = new WindowInteropHelper(this).Handle;
            if (handle != IntPtr.Zero)
            {
                SetWindowPos(handle, enable ? HWND_TOPMOST : HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
            }
        }
        catch { }
    }

    private void ApplyHudHeight(bool isHud)
    {
        if (isHud)
        {
            _previousHeight = ActualHeight > 270 ? ActualHeight : 600;
            Height = 260;
        }
        else
        {
            Height = _previousHeight >= 260 ? _previousHeight : 600;
        }
    }

    private void MainWindow_Closing(object? sender, System.ComponentModel.CancelEventArgs e)
    {
        try
        {
            _gameCheckTimer.Stop();
            _serverManager.Dispose();
        }
        catch { }
    }

    private void CheckGameStatus(bool forceUpdate)
    {
        try
        {
            if (!_isServerOnline) return;

            var procs = System.Diagnostics.Process.GetProcessesByName("cs2");
            bool isRunning = procs.Length > 0;
            foreach (var p in procs) p.Dispose();

            _lastGameRunning = isRunning;
            if (ChatWebView?.CoreWebView2 != null)
            {
                string js = $"if (window.setGameStatus) window.setGameStatus({(isRunning ? "true" : "false")});";
                _ = ChatWebView.CoreWebView2.ExecuteScriptAsync(js);
            }
        }
        catch { }
    }
}
