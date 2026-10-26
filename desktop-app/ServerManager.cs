using System;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Threading.Tasks;

namespace CS2ChatTranslator;

public class ServerManager : IDisposable
{
    private Process? _serverProcess;
    private bool _weStartedServer;
    private readonly HttpClient _http = new(new SocketsHttpHandler
    {
        PooledConnectionLifetime = TimeSpan.FromMinutes(5),
        MaxConnectionsPerServer = 4
    })
    {
        Timeout = TimeSpan.FromMilliseconds(900)
    };

    public string ServerUrl { get; } = "http://127.0.0.1:7420";
    public string ProjectDir { get; private set; } = string.Empty;

    public ServerManager()
    {
        ProjectDir = FindProjectDirectory();
    }

    public async Task<bool> EnsureServerRunningAsync(Action<string>? statusCallback = null)
    {
        statusCallback?.Invoke("Szerver ellenőrzése...");

        // If our own managed process is already running and alive, reuse it
        if (_weStartedServer && _serverProcess != null && !_serverProcess.HasExited && await IsServerAliveAsync())
        {
            statusCallback?.Invoke("Szerver aktív.");
            return true;
        }

        // If an old orphan server is holding port 7420, shut it down cleanly so we run the latest code
        if (await IsServerAliveAsync())
        {
            statusCallback?.Invoke("Korábbi háttérfolyamat frissítése...");
            try
            {
                await _http.PostAsync($"{ServerUrl}/api/shutdown", null);
                await Task.Delay(400);
            }
            catch { }
        }

        if (string.IsNullOrEmpty(ProjectDir))
        {
            statusCallback?.Invoke("Nem található a cs2-chat-translator könyvtára!");
            return false;
        }

        statusCallback?.Invoke("Háttérfolyamat indítása (Node.js)...");
        try
        {
            var nodePath = FindNodeExecutable();
            var scriptPath = Path.Combine(ProjectDir, "bin", "cs2-chat-translator.js");

            if (!File.Exists(scriptPath))
            {
                statusCallback?.Invoke($"A szkript nem található: {scriptPath}");
                return false;
            }

            int parentPid = Environment.ProcessId;
            var psi = new ProcessStartInfo
            {
                FileName = nodePath,
                Arguments = $"\"{scriptPath}\" --no-browser --parent-pid {parentPid}",
                WorkingDirectory = ProjectDir,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                WindowStyle = ProcessWindowStyle.Hidden
            };

            _serverProcess = new Process { StartInfo = psi };
            _serverProcess.OutputDataReceived += (_, e) =>
            {
                if (!string.IsNullOrWhiteSpace(e.Data))
                    Debug.WriteLine($"[Node STDOUT] {e.Data}");
            };
            _serverProcess.ErrorDataReceived += (_, e) =>
            {
                if (!string.IsNullOrWhiteSpace(e.Data))
                    Debug.WriteLine($"[Node STDERR] {e.Data}");
            };

            _serverProcess.Start();
            _serverProcess.BeginOutputReadLine();
            _serverProcess.BeginErrorReadLine();
            _weStartedServer = true;

            for (int i = 0; i < 20; i++)
            {
                await Task.Delay(400);
                if (await IsServerAliveAsync())
                {
                    statusCallback?.Invoke("Szerver sikeresen elindult.");
                    return true;
                }

                if (_serverProcess.HasExited)
                {
                    // If port was still held by another instance, check if server is alive anyway
                    if (await IsServerAliveAsync())
                    {
                        return true;
                    }
                    statusCallback?.Invoke($"A Node folyamat váratlanul leállt (kód: {_serverProcess.ExitCode}).");
                    return false;
                }
            }

            statusCallback?.Invoke("Időtúllépés a szerver indításakor.");
            return false;
        }
        catch (Exception ex)
        {
            statusCallback?.Invoke($"Hiba a szerver indításakor: {ex.Message}");
            return false;
        }
    }

    public async Task<bool> IsServerAliveAsync()
    {
        try
        {
            using var resp = await _http.GetAsync($"{ServerUrl}/api/status");
            return resp.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    private string FindNodeExecutable()
    {
        string baseDir = AppDomain.CurrentDomain.BaseDirectory;
        string[] localCandidates = [
            Path.Combine(baseDir, "runtime", "node.exe"),
            Path.Combine(baseDir, "bin", "node.exe"),
            Path.Combine(ProjectDir, "runtime", "node.exe"),
            Path.Combine(ProjectDir, "bin", "node.exe")
        ];

        foreach (var p in localCandidates)
        {
            if (!string.IsNullOrEmpty(p) && File.Exists(p)) return p;
        }

        string[] commonPaths = [
            @"C:\Program Files\nodejs\node.exe",
            @"C:\Program Files (x86)\nodejs\node.exe",
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "AppData", "Roaming", "nvm")
        ];

        foreach (var p in commonPaths)
        {
            if (File.Exists(p)) return p;
        }

        return "node";
    }

    private string FindProjectDirectory()
    {
        var current = AppDomain.CurrentDomain.BaseDirectory;
        while (!string.IsNullOrEmpty(current))
        {
            if (File.Exists(Path.Combine(current, "bin", "cs2-chat-translator.js")) &&
                Directory.Exists(Path.Combine(current, "node_modules")))
            {
                return current;
            }
            var parent = Directory.GetParent(current);
            if (parent == null) break;
            current = parent.FullName;
        }

        var defaultDocPath = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
            "cs2-chat-translator"
        );
        if (Directory.Exists(defaultDocPath)) return defaultDocPath;

        return AppDomain.CurrentDomain.BaseDirectory;
    }

    public void Stop()
    {
        try
        {
            _ = _http.PostAsync($"{ServerUrl}/api/shutdown", null).Wait(300);
        }
        catch { }

        if (_serverProcess != null && !_serverProcess.HasExited)
        {
            try
            {
                _serverProcess.Kill(entireProcessTree: true);
                _serverProcess.Dispose();
            }
            catch { }
            finally
            {
                _serverProcess = null;
                _weStartedServer = false;
            }
        }
    }

    public void Dispose()
    {
        Stop();
        _http.Dispose();
        GC.SuppressFinalize(this);
    }
}
