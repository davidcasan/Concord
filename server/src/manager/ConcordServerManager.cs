using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

[assembly: AssemblyTitle("Concord Server")]
[assembly: AssemblyProduct("Concord Server")]
[assembly: AssemblyCompany("Concord")]
[assembly: AssemblyDescription("Painel de controle do servidor Concord")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

internal sealed class ConcordServerManager : Form
{
    private const uint JobObjectExtendedLimitInformation = 9;
    private const uint JobObjectLimitKillOnJobClose = 0x2000;

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimitInformation
    {
        public BasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        uint informationClass,
        ref ExtendedLimitInformation information,
        uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    private readonly string _dataDirectory;
    private readonly string _corePath;
    private readonly Label _status;
    private readonly TextBox _inviteCode;
    private readonly RichTextBox _logView;
    private readonly Button _startButton;
    private readonly Button _stopButton;
    private readonly System.Windows.Forms.Timer _timer;
    private Process _server;
    private IntPtr _job;
    private StreamWriter _logFile;
    private readonly object _logLock = new object();

    private ConcordServerManager()
    {
        string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        _dataDirectory = Path.Combine(localAppData, "Concord Server");
        _corePath = Path.Combine(_dataDirectory, "runtime", "Concord Server Core.exe");

        Text = "Concord Server";
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(700, 610);
        MinimumSize = new Size(700, 610);
        MaximumSize = new Size(700, 610);
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;
        BackColor = Color.FromArgb(16, 24, 38);
        ForeColor = Color.FromArgb(230, 238, 246);
        Font = new Font("Segoe UI", 10F);

        string iconPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "concord.ico");
        if (File.Exists(iconPath)) Icon = new Icon(iconPath);

        Panel header = new Panel();
        header.Dock = DockStyle.Top;
        header.Height = 118;
        header.BackColor = Color.FromArgb(10, 17, 29);
        Controls.Add(header);

        Panel logo = new Panel();
        logo.Location = new Point(28, 27);
        logo.Size = new Size(54, 54);
        logo.BackColor = Color.FromArgb(13, 25, 43);
        logo.Paint += delegate(object sender, PaintEventArgs e)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using (GraphicsPath aircraft = new GraphicsPath())
            using (LinearGradientBrush paint = new LinearGradientBrush(
                new Rectangle(0, 0, 54, 54),
                Color.FromArgb(245, 253, 255),
                Color.FromArgb(110, 208, 231),
                LinearGradientMode.Vertical))
            {
                aircraft.AddPolygon(new Point[] {
                    new Point(27, 3), new Point(30, 17), new Point(48, 30), new Point(50, 33),
                    new Point(31, 29), new Point(30, 43), new Point(35, 51), new Point(27, 49),
                    new Point(19, 51), new Point(24, 43), new Point(23, 29), new Point(4, 33),
                    new Point(6, 30), new Point(24, 17)
                });
                e.Graphics.FillPath(paint, aircraft);
            }
        };
        header.Controls.Add(logo);

        Label title = new Label();
        title.Text = "Concord Server";
        title.Font = new Font("Segoe UI Semibold", 25F, FontStyle.Bold);
        title.ForeColor = Color.White;
        title.Location = new Point(100, 22);
        title.AutoSize = true;
        header.Controls.Add(title);

        Label subtitle = new Label();
        subtitle.Text = "Painel do servidor de voz, texto e video";
        subtitle.Font = new Font("Segoe UI", 10F);
        subtitle.ForeColor = Color.FromArgb(151, 169, 188);
        subtitle.Location = new Point(104, 72);
        subtitle.AutoSize = true;
        header.Controls.Add(subtitle);

        Label sectionTitle = new Label();
        sectionTitle.Text = "SERVIDOR";
        sectionTitle.Font = new Font("Segoe UI Semibold", 9F, FontStyle.Bold);
        sectionTitle.ForeColor = Color.FromArgb(121, 143, 166);
        sectionTitle.Location = new Point(30, 137);
        sectionTitle.AutoSize = true;
        Controls.Add(sectionTitle);

        Panel statusDot = new Panel();
        statusDot.Name = "statusDot";
        statusDot.Size = new Size(12, 12);
        statusDot.Location = new Point(32, 170);
        statusDot.BackColor = Color.FromArgb(115, 128, 145);
        statusDot.Paint += delegate(object sender, PaintEventArgs e)
        {
            e.Graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            using (SolidBrush brush = new SolidBrush(statusDot.BackColor))
                e.Graphics.FillEllipse(brush, 0, 0, 11, 11);
        };
        Controls.Add(statusDot);

        _status = new Label();
        _status.Text = "DESLIGADO";
        _status.Font = new Font("Segoe UI Semibold", 11F, FontStyle.Bold);
        _status.ForeColor = Color.FromArgb(161, 174, 190);
        _status.Location = new Point(53, 164);
        _status.AutoSize = true;
        Controls.Add(_status);

        _startButton = new Button();
        _startButton.Text = "Iniciar servidor";
        _startButton.Location = new Point(30, 202);
        _startButton.Size = new Size(190, 42);
        _startButton.FlatStyle = FlatStyle.Flat;
        _startButton.FlatAppearance.BorderSize = 0;
        _startButton.BackColor = Color.FromArgb(30, 156, 126);
        _startButton.ForeColor = Color.White;
        _startButton.Font = new Font("Segoe UI Semibold", 10F, FontStyle.Bold);
        _startButton.Click += delegate { StartServer(); };
        Controls.Add(_startButton);

        _stopButton = new Button();
        _stopButton.Text = "Desligar servidor";
        _stopButton.Location = new Point(231, 202);
        _stopButton.Size = new Size(190, 42);
        _stopButton.FlatStyle = FlatStyle.Flat;
        _stopButton.FlatAppearance.BorderSize = 0;
        _stopButton.BackColor = Color.FromArgb(56, 67, 83);
        _stopButton.ForeColor = Color.White;
        _stopButton.Font = new Font("Segoe UI Semibold", 10F, FontStyle.Bold);
        _stopButton.Enabled = false;
        _stopButton.Click += delegate { StopServer(); };
        Controls.Add(_stopButton);

        Button openSite = new Button();
        openSite.Text = "Abrir Concord";
        openSite.Location = new Point(432, 202);
        openSite.Size = new Size(230, 42);
        openSite.FlatStyle = FlatStyle.Flat;
        openSite.FlatAppearance.BorderColor = Color.FromArgb(60, 77, 97);
        openSite.BackColor = Color.FromArgb(27, 39, 56);
        openSite.ForeColor = Color.FromArgb(216, 237, 246);
        openSite.Click += delegate
        {
            try
            {
                Process.Start(new ProcessStartInfo("http://localhost:666") { UseShellExecute = true });
            }
            catch (Win32Exception error)
            {
                MessageBox.Show(this, error.Message, "Nao foi possivel abrir o Concord", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            catch (InvalidOperationException error)
            {
                MessageBox.Show(this, error.Message, "Nao foi possivel abrir o Concord", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        };
        Controls.Add(openSite);

        Label localAddress = new Label();
        localAddress.Text = "Rede local:  " + ServerAddress("fallbackServerUrl", "http://IP-LOCAL-DO-SERVIDOR:666");
        localAddress.Location = new Point(32, 260);
        localAddress.AutoSize = true;
        localAddress.ForeColor = Color.FromArgb(164, 187, 205);
        Controls.Add(localAddress);

        Label publicAddress = new Label();
        publicAddress.Text = "Internet:       " + ServerAddress("serverUrl", "http://IP-PUBLICO:666");
        publicAddress.Location = new Point(32, 284);
        publicAddress.AutoSize = true;
        publicAddress.ForeColor = Color.FromArgb(164, 187, 205);
        Controls.Add(publicAddress);

        Label inviteLabel = new Label();
        inviteLabel.Text = "Codigo de convite";
        inviteLabel.Location = new Point(32, 320);
        inviteLabel.AutoSize = true;
        inviteLabel.ForeColor = Color.FromArgb(121, 143, 166);
        Controls.Add(inviteLabel);

        _inviteCode = new TextBox();
        _inviteCode.Location = new Point(32, 344);
        _inviteCode.Size = new Size(400, 29);
        _inviteCode.ReadOnly = true;
        _inviteCode.BackColor = Color.FromArgb(23, 34, 50);
        _inviteCode.ForeColor = Color.FromArgb(227, 240, 248);
        _inviteCode.BorderStyle = BorderStyle.FixedSingle;
        _inviteCode.Text = ReadInviteCode();
        Controls.Add(_inviteCode);

        Button copyInvite = new Button();
        copyInvite.Text = "Copiar";
        copyInvite.Location = new Point(442, 342);
        copyInvite.Size = new Size(91, 32);
        copyInvite.FlatStyle = FlatStyle.Flat;
        copyInvite.FlatAppearance.BorderColor = Color.FromArgb(60, 77, 97);
        copyInvite.BackColor = Color.FromArgb(27, 39, 56);
        copyInvite.ForeColor = Color.White;
        copyInvite.Click += delegate
        {
            if (!String.IsNullOrEmpty(_inviteCode.Text))
            {
                Clipboard.SetText(_inviteCode.Text);
                AppendLog("Codigo de convite copiado.");
            }
        };
        Controls.Add(copyInvite);

        Label logTitle = new Label();
        logTitle.Text = "ATIVIDADE";
        logTitle.Font = new Font("Segoe UI Semibold", 9F, FontStyle.Bold);
        logTitle.ForeColor = Color.FromArgb(121, 143, 166);
        logTitle.Location = new Point(32, 394);
        logTitle.AutoSize = true;
        Controls.Add(logTitle);

        _logView = new RichTextBox();
        _logView.Location = new Point(30, 420);
        _logView.Size = new Size(632, 156);
        _logView.ReadOnly = true;
        _logView.BackColor = Color.FromArgb(9, 15, 25);
        _logView.ForeColor = Color.FromArgb(182, 202, 218);
        _logView.BorderStyle = BorderStyle.FixedSingle;
        _logView.Font = new Font("Consolas", 9F);
        Controls.Add(_logView);

        _timer = new System.Windows.Forms.Timer();
        _timer.Interval = 1000;
        _timer.Tick += delegate { RefreshStatus(); };
        _timer.Start();
        Load += delegate { AppendLog("Painel Concord Server pronto."); };
        FormClosing += delegate { StopServer(); };
    }

    private string ReadInviteCode()
    {
        string[] candidates = new string[] {
            Path.Combine(_dataDirectory, ".env"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Minicord Server", ".env")
        };
        foreach (string file in candidates)
        {
            if (!File.Exists(file)) continue;
            foreach (string line in File.ReadAllLines(file))
                if (line.StartsWith("INVITE_CODE=", StringComparison.Ordinal))
                    return line.Substring("INVITE_CODE=".Length).Trim();
        }
        return "Aparece aqui na primeira inicializacao";
    }

    private static string ServerAddress(string key, string fallback)
    {
        Stream resource = Assembly.GetExecutingAssembly().GetManifestResourceStream("ConcordServerAddresses");
        if (resource == null) return fallback;
        using (resource)
        using (StreamReader reader = new StreamReader(resource))
        {
            Match match = Regex.Match(reader.ReadToEnd(), "\"" + Regex.Escape(key) + "\"\\s*:\\s*\"([^\"]+)\"");
            Uri address;
            return match.Success && Uri.TryCreate(match.Groups[1].Value, UriKind.Absolute, out address)
                ? address.ToString()
                : fallback;
        }
    }

    private void StartServer()
    {
        RefreshStatus();
        if (_server != null && !_server.HasExited) return;
        try
        {
            Directory.CreateDirectory(_dataDirectory);
            EnsureCoreExecutable();
            _logFile = new StreamWriter(Path.Combine(_dataDirectory, "server.log"), true, Encoding.UTF8);
            _job = CreateJobObject(IntPtr.Zero, null);
            if (_job == IntPtr.Zero) throw new InvalidOperationException("Nao foi possivel criar o grupo de processos do servidor.");

            ExtendedLimitInformation limits = new ExtendedLimitInformation();
            limits.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
            if (!SetInformationJobObject(_job, JobObjectExtendedLimitInformation, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimitInformation))))
                throw new InvalidOperationException("Nao foi possivel preparar o desligamento do servidor.");

            ProcessStartInfo startInfo = new ProcessStartInfo(_corePath);
            startInfo.WorkingDirectory = AppDomain.CurrentDomain.BaseDirectory;
            startInfo.UseShellExecute = false;
            startInfo.CreateNoWindow = true;
            startInfo.RedirectStandardOutput = true;
            startInfo.RedirectStandardError = true;

            _server = new Process();
            _server.StartInfo = startInfo;
            _server.EnableRaisingEvents = true;
            _server.OutputDataReceived += delegate(object sender, DataReceivedEventArgs args)
            {
                if (args.Data != null) AppendLog(args.Data);
            };
            _server.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs args)
            {
                if (args.Data != null) AppendLog(args.Data);
            };
            _server.Exited += delegate
            {
                if (IsDisposed) return;
                try
                {
                    BeginInvoke((MethodInvoker)delegate
                    {
                        if (_server != null && _server.HasExited)
                        {
                            AppendLog("O processo principal do servidor foi encerrado.");
                            ReleaseJob();
                            RefreshStatus();
                        }
                    });
                }
                catch (InvalidOperationException) { }
            };

            if (!_server.Start()) throw new InvalidOperationException("O processo do servidor nao iniciou.");
            if (!AssignProcessToJobObject(_job, _server.Handle))
            {
                _server.Kill();
                throw new InvalidOperationException("O Windows nao permitiu controlar os processos do servidor.");
            }
            _server.BeginOutputReadLine();
            _server.BeginErrorReadLine();
            AppendLog("Iniciando o Concord na porta 666...");
            RefreshStatus();
        }
        catch (Win32Exception error)
        {
            HandleStartError(error);
        }
        catch (IOException error)
        {
            HandleStartError(error);
        }
        catch (UnauthorizedAccessException error)
        {
            HandleStartError(error);
        }
        catch (InvalidOperationException error)
        {
            HandleStartError(error);
        }
    }

    private void EnsureCoreExecutable()
    {
        string version;
        using (Stream versionStream = Assembly.GetExecutingAssembly().GetManifestResourceStream("ConcordServerCoreVersion"))
        {
            if (versionStream == null) throw new InvalidOperationException("A versao do servidor nao foi empacotada.");
            using (StreamReader reader = new StreamReader(versionStream))
                version = reader.ReadToEnd().Trim();
        }

        string versionPath = _corePath + ".version";
        if (File.Exists(_corePath) && File.Exists(versionPath) && File.ReadAllText(versionPath).Trim() == version) return;

        Directory.CreateDirectory(Path.GetDirectoryName(_corePath));
        string temporaryPath = _corePath + ".new";
        using (Stream core = Assembly.GetExecutingAssembly().GetManifestResourceStream("ConcordServerCore"))
        {
            if (core == null) throw new InvalidOperationException("O nucleo do servidor nao foi empacotado.");
            using (FileStream destination = new FileStream(temporaryPath, FileMode.Create, FileAccess.Write, FileShare.None))
                core.CopyTo(destination);
        }

        if (File.Exists(_corePath)) File.Delete(_corePath);
        File.Move(temporaryPath, _corePath);
        File.WriteAllText(versionPath, version, Encoding.UTF8);
    }

    private void HandleStartError(Exception error)
    {
        ReleaseJob();
        if (_server != null)
        {
            try { if (!_server.HasExited) _server.Kill(); }
            catch (InvalidOperationException) { }
            _server.Dispose();
            _server = null;
        }
        CloseLogFile();
        AppendLog("Falha ao iniciar: " + error.Message);
        MessageBox.Show(this, error.Message, "Falha ao iniciar o servidor", MessageBoxButtons.OK, MessageBoxIcon.Error);
        RefreshStatus();
    }

    private void StopServer()
    {
        if (_job != IntPtr.Zero)
        {
            TerminateJobObject(_job, 0);
            ReleaseJob();
            AppendLog("Servidor e servico de voz desligados.");
        }
        else if (_server != null)
        {
            try { if (!_server.HasExited) _server.Kill(); }
            catch (InvalidOperationException) { }
        }
        if (_server != null)
        {
            _server.Dispose();
            _server = null;
        }
        CloseLogFile();
        RefreshStatus();
    }

    private void ReleaseJob()
    {
        if (_job == IntPtr.Zero) return;
        CloseHandle(_job);
        _job = IntPtr.Zero;
    }

    private void RefreshStatus()
    {
        bool running = _server != null && !_server.HasExited;
        Panel dot = Controls["statusDot"] as Panel;
        if (dot != null)
        {
            dot.BackColor = running ? Color.FromArgb(55, 208, 146) : Color.FromArgb(115, 128, 145);
            dot.Invalidate();
        }
        _status.Text = running ? "LIGADO" : "DESLIGADO";
        _status.ForeColor = running ? Color.FromArgb(93, 225, 172) : Color.FromArgb(161, 174, 190);
        _startButton.Enabled = !running;
        _stopButton.Enabled = running;
        if (!running && _server != null && _server.HasExited)
        {
            _server.Dispose();
            _server = null;
            ReleaseJob();
            CloseLogFile();
        }
    }

    private void CloseLogFile()
    {
        lock (_logLock)
        {
            if (_logFile == null) return;
            StreamWriter log = _logFile;
            _logFile = null;
            log.Dispose();
        }
    }

    private void AppendLog(string message)
    {
        lock (_logLock)
        {
            if (_logFile != null)
            {
                _logFile.WriteLine(DateTime.Now.ToString("HH:mm:ss") + " " + message);
                _logFile.Flush();
            }
        }
        if (IsDisposed || !IsHandleCreated) return;
        if (InvokeRequired)
        {
            try { BeginInvoke((MethodInvoker)delegate { AppendLogToView(message); }); }
            catch (InvalidOperationException) { }
        }
        else AppendLogToView(message);
    }

    private void AppendLogToView(string message)
    {
        _logView.AppendText(DateTime.Now.ToString("HH:mm:ss") + "  " + message + Environment.NewLine);
        _logView.SelectionStart = _logView.TextLength;
        _logView.ScrollToCaret();
    }

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
        StopServer();
        _timer.Stop();
        CloseLogFile();
        base.OnFormClosed(e);
    }

    [STAThread]
    private static void Main()
    {
        bool created;
        using (Mutex mutex = new Mutex(true, "Local\\ConcordServerManager", out created))
        {
            if (!created)
            {
                MessageBox.Show("O Concord Server ja esta aberto.", "Concord Server", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new ConcordServerManager());
            GC.KeepAlive(mutex);
        }
    }
}
