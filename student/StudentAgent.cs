// 학습 모니터 - 학생용 Windows 에이전트
// Windows에 기본 내장된 .NET Framework 4 컴파일러(C# 5)로 빌드되도록 작성했습니다. build.bat 참고.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace StudyMonitor
{
    static class Native
    {
        [DllImport("user32.dll")]
        public static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
        [DllImport("user32.dll")]
        public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

        [StructLayout(LayoutKind.Sequential)]
        public struct LASTINPUTINFO
        {
            public uint cbSize;
            public uint dwTime;
        }
        [DllImport("user32.dll")]
        public static extern bool GetLastInputInfo(ref LASTINPUTINFO info);

        public delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll", SetLastError = true)]
        public static extern IntPtr SetWindowsHookEx(int idHook, HookProc proc, IntPtr hMod, uint threadId);
        [DllImport("user32.dll")]
        public static extern bool UnhookWindowsHookEx(IntPtr hook);
        [DllImport("user32.dll")]
        public static extern IntPtr CallNextHookEx(IntPtr hook, int nCode, IntPtr wParam, IntPtr lParam);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        public static extern IntPtr GetModuleHandle(string name);
    }

    static class Program
    {
        [STAThread]
        static void Main()
        {
            bool created;
            using (Mutex mutex = new Mutex(true, "StudyMonitorStudentAgent", out created))
            {
                if (!created) return; // 이미 실행 중
                try { Native.SetProcessDPIAware(); } catch { }
                ServicePointManager.Expect100Continue = false;
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new Agent());
            }
        }
    }

    // 화면 잠금: 모든 모니터를 덮는 창 + 키보드 입력 차단
    class LockScreen
    {
        readonly List<Form> forms = new List<Form>();
        readonly List<Label> labels = new List<Label>();
        readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
        readonly Native.HookProc hookProc; // GC 방지를 위해 필드로 보관
        IntPtr hook = IntPtr.Zero;
        bool closing;

        public LockScreen(string text)
        {
            foreach (Screen s in Screen.AllScreens)
            {
                Form f = new Form();
                f.FormBorderStyle = FormBorderStyle.None;
                f.StartPosition = FormStartPosition.Manual;
                f.Bounds = s.Bounds;
                f.TopMost = true;
                f.ShowInTaskbar = false;
                f.BackColor = Color.FromArgb(0, 137, 207); // ITC 영어 파랑
                f.Cursor = Cursors.No;
                Label l = new Label();
                l.Dock = DockStyle.Fill;
                l.TextAlign = ContentAlignment.MiddleCenter;
                l.ForeColor = Color.White;
                l.Font = new Font("Malgun Gothic", 28f, FontStyle.Bold);
                l.Text = text;
                f.Controls.Add(l);
                f.FormClosing += delegate(object sender, FormClosingEventArgs e) { if (!closing) e.Cancel = true; };
                forms.Add(f);
                labels.Add(l);
                f.Show();
            }
            hookProc = new Native.HookProc(OnKey);
            hook = Native.SetWindowsHookEx(13 /* WH_KEYBOARD_LL */, hookProc, Native.GetModuleHandle(null), 0);
            timer.Interval = 700;
            timer.Tick += delegate { KeepOnTop(); };
            timer.Start();
            KeepOnTop();
        }

        IntPtr OnKey(int nCode, IntPtr wParam, IntPtr lParam)
        {
            if (nCode >= 0) return (IntPtr)1; // 잠긴 동안 모든 키 입력 무시
            return Native.CallNextHookEx(hook, nCode, wParam, lParam);
        }

        void KeepOnTop()
        {
            foreach (Form f in forms)
            {
                f.TopMost = true;
                f.BringToFront();
            }
            if (forms.Count > 0) forms[0].Activate();
        }

        public void SetText(string text)
        {
            foreach (Label l in labels) l.Text = text;
        }

        public void Close()
        {
            closing = true;
            timer.Stop();
            timer.Dispose();
            if (hook != IntPtr.Zero)
            {
                Native.UnhookWindowsHookEx(hook);
                hook = IntPtr.Zero;
            }
            foreach (Form f in forms)
            {
                f.Close();
                f.Dispose();
            }
            forms.Clear();
            labels.Clear();
        }
    }

    class Agent : ApplicationContext
    {
        const int DiscoveryPort = 47801;
        const int DefaultPort = 47800;
        const string DefaultLockText = "화면이 잠겼습니다. 선생님을 봐 주세요.";

        readonly Control ui = new Control();
        readonly NotifyIcon tray = new NotifyIcon();
        readonly ToolStripMenuItem statusItem = new ToolStripMenuItem("시작하는 중...");
        readonly float scale = 1f;

        string code = "";
        string fixedServer = null;
        string displayName;
        string machineId;

        string baseUrl = null;       // 작업 스레드 전용
        int intervalSec = 3;         // 작업 스레드 전용
        int maxW = 1280;
        long quality = 60;
        long lastMsgId = 0;
        DateTime lastOk = DateTime.UtcNow;
        volatile bool locked;
        LockScreen lockScreen;       // UI 스레드 전용

        public Agent()
        {
            IntPtr handle = ui.Handle; // UI 스레드에서 핸들 생성 (BeginInvoke 용)
            try
            {
                using (Graphics g = ui.CreateGraphics()) scale = g.DpiX / 96f;
            }
            catch { }

            machineId = Environment.MachineName;
            displayName = machineId;
            LoadConfig();

            ContextMenuStrip menu = new ContextMenuStrip();
            ToolStripMenuItem head = new ToolStripMenuItem("ITC 영어 학습 모니터 - 화면이 선생님에게 공유됩니다");
            head.Enabled = false;
            statusItem.Enabled = false;
            menu.Items.Add(head);
            menu.Items.Add(statusItem);
            tray.Icon = SystemIcons.Information;
            tray.Text = "ITC 영어 학습 모니터 실행 중";
            tray.ContextMenuStrip = menu;
            tray.Visible = true;
            tray.ShowBalloonTip(8000, "ITC 영어 학습 모니터", "수업 중 이 PC의 화면이 선생님에게 공유됩니다.", ToolTipIcon.Info);

            Thread worker = new Thread(WorkLoop);
            worker.IsBackground = true;
            worker.Start();
        }

        void LoadConfig()
        {
            try
            {
                string path = Path.Combine(Application.StartupPath, "config.txt");
                foreach (string raw in File.ReadAllLines(path, Encoding.UTF8))
                {
                    string line = raw.Trim();
                    if (line.Length == 0 || line.StartsWith("#")) continue;
                    int eq = line.IndexOf('=');
                    if (eq <= 0) continue;
                    string key = line.Substring(0, eq).Trim().ToLowerInvariant();
                    string val = line.Substring(eq + 1).Trim();
                    if (key == "code") code = val;
                    else if (key == "server" && val.Length > 0) fixedServer = val;
                    else if (key == "name" && val.Length > 0) displayName = val;
                }
            }
            catch { }
        }

        void SetStatus(string text)
        {
            try
            {
                ui.BeginInvoke(new MethodInvoker(delegate
                {
                    statusItem.Text = text;
                    string tip = "ITC 영어 - " + text;
                    tray.Text = tip.Length > 60 ? tip.Substring(0, 60) : tip;
                }));
            }
            catch { }
        }

        // ---------- 작업 스레드 ----------
        void WorkLoop()
        {
            int fails = 0;
            while (true)
            {
                int sleepMs = 3000;
                try
                {
                    if (code.Length == 0)
                    {
                        SetStatus("config.txt 에 연결 키(code)가 없습니다");
                    }
                    else
                    {
                        if (baseUrl == null)
                        {
                            if (fixedServer != null)
                                baseUrl = "http://" + (fixedServer.IndexOf(':') >= 0 ? fixedServer : fixedServer + ":" + DefaultPort);
                            else
                                baseUrl = Discover();
                        }
                        if (baseUrl == null)
                        {
                            SetStatus("선생님 컴퓨터를 찾는 중...");
                        }
                        else
                        {
                            Report();
                            fails = 0;
                            lastOk = DateTime.UtcNow;
                            SetStatus("선생님 컴퓨터와 연결됨");
                            sleepMs = intervalSec * 1000;
                        }
                    }
                }
                catch (WebException ex)
                {
                    HttpWebResponse r = ex.Response as HttpWebResponse;
                    if (r != null && r.StatusCode == HttpStatusCode.Forbidden)
                        SetStatus("연결 키가 맞지 않습니다 (config.txt 확인)");
                    else
                        SetStatus("연결이 끊겼습니다. 다시 시도하는 중...");
                    if (r != null) r.Close();
                    fails++;
                    if (fails >= 3 && fixedServer == null) baseUrl = null; // 서버 IP가 바뀌었을 수 있으니 다시 검색
                }
                catch (Exception)
                {
                    fails++;
                }

                // 안전장치: 잠긴 상태에서 선생님 컴퓨터와 1분 이상 연결이 안 되면 자동으로 풉니다.
                if (locked && (DateTime.UtcNow - lastOk).TotalSeconds > 60)
                {
                    try { ui.BeginInvoke(new MethodInvoker(delegate { ApplyLock(false, ""); })); } catch { }
                }
                Thread.Sleep(sleepMs);
            }
        }

        static string Sha256Hex(string s)
        {
            using (SHA256 sha = SHA256.Create())
            {
                byte[] hash = sha.ComputeHash(Encoding.UTF8.GetBytes(s));
                StringBuilder sb = new StringBuilder();
                foreach (byte b in hash) sb.Append(b.ToString("x2"));
                return sb.ToString();
            }
        }

        // 같은 와이파이에 방송을 보내 선생님 컴퓨터를 찾습니다. 연결 키를 아는 서버의 응답만 받아들입니다.
        string Discover()
        {
            string nonce = Guid.NewGuid().ToString("N");
            string expected = Sha256Hex(nonce + ":" + code);
            byte[] data = Encoding.UTF8.GetBytes("SM_DISCOVER " + nonce);
            using (UdpClient udp = new UdpClient(new IPEndPoint(IPAddress.Any, 0)))
            {
                udp.EnableBroadcast = true;
                udp.Client.ReceiveTimeout = 700;

                List<IPAddress> targets = new List<IPAddress>();
                targets.Add(IPAddress.Broadcast);
                try
                {
                    foreach (NetworkInterface nic in NetworkInterface.GetAllNetworkInterfaces())
                    {
                        if (nic.OperationalStatus != OperationalStatus.Up) continue;
                        foreach (UnicastIPAddressInformation ua in nic.GetIPProperties().UnicastAddresses)
                        {
                            if (ua.Address.AddressFamily != AddressFamily.InterNetwork || ua.IPv4Mask == null) continue;
                            if (IPAddress.IsLoopback(ua.Address)) continue;
                            byte[] ip = ua.Address.GetAddressBytes();
                            byte[] mask = ua.IPv4Mask.GetAddressBytes();
                            byte[] bc = new byte[4];
                            for (int i = 0; i < 4; i++) bc[i] = (byte)(ip[i] | (byte)~mask[i]);
                            targets.Add(new IPAddress(bc));
                        }
                    }
                }
                catch { }
                foreach (IPAddress t in targets)
                {
                    try { udp.Send(data, data.Length, new IPEndPoint(t, DiscoveryPort)); } catch { }
                }

                DateTime end = DateTime.UtcNow.AddSeconds(2);
                while (DateTime.UtcNow < end)
                {
                    try
                    {
                        IPEndPoint from = new IPEndPoint(IPAddress.Any, 0);
                        string reply = Encoding.UTF8.GetString(udp.Receive(ref from));
                        string[] parts = reply.Trim().Split(' ');
                        int port;
                        if (parts.Length == 3 && parts[0] == "SM_HERE" && parts[2] == expected
                            && int.TryParse(parts[1], out port) && port > 0 && port < 65536)
                        {
                            return "http://" + from.Address + ":" + port;
                        }
                    }
                    catch (SocketException) { }
                }
            }
            return null;
        }

        static string Esc(string s)
        {
            if (s == null) return "";
            if (s.Length > 200) s = s.Substring(0, 200);
            if (s.Length > 0 && char.IsHighSurrogate(s[s.Length - 1])) s = s.Substring(0, s.Length - 1);
            try { return Uri.EscapeDataString(s); } catch { return ""; }
        }

        void Report()
        {
            byte[] jpg;
            try { jpg = Capture(maxW, quality); }
            catch { jpg = new byte[0]; } // Windows 잠금 화면 등에서는 캡처가 안 될 수 있음

            string title = "", proc = "";
            try
            {
                IntPtr hwnd = Native.GetForegroundWindow();
                StringBuilder sb = new StringBuilder(512);
                Native.GetWindowText(hwnd, sb, sb.Capacity);
                title = sb.ToString();
                uint pid;
                Native.GetWindowThreadProcessId(hwnd, out pid);
                if (pid != 0)
                {
                    using (Process p = Process.GetProcessById((int)pid)) proc = p.ProcessName;
                }
            }
            catch { }

            long idleSec = 0;
            try
            {
                Native.LASTINPUTINFO lii = new Native.LASTINPUTINFO();
                lii.cbSize = (uint)Marshal.SizeOf(typeof(Native.LASTINPUTINFO));
                if (Native.GetLastInputInfo(ref lii))
                    idleSec = unchecked((uint)Environment.TickCount - lii.dwTime) / 1000;
            }
            catch { }

            string url = baseUrl + "/api/client/report"
                + "?id=" + Esc(machineId)
                + "&name=" + Esc(displayName)
                + "&title=" + Esc(title)
                + "&proc=" + Esc(proc)
                + "&idle=" + idleSec
                + "&locked=" + (locked ? "1" : "0")
                + "&ack=" + lastMsgId;

            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
            req.Method = "POST";
            req.Proxy = null;
            req.Timeout = 8000;
            req.ReadWriteTimeout = 8000;
            req.ContentType = "image/jpeg";
            req.Headers["X-Class-Code"] = code;
            req.ContentLength = jpg.Length;
            using (Stream s = req.GetRequestStream()) s.Write(jpg, 0, jpg.Length);

            string body;
            using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
            using (StreamReader reader = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
            {
                body = reader.ReadToEnd();
            }
            ApplyResponse(body);
        }

        void ApplyResponse(string body)
        {
            bool wantLock = false;
            string lockText = "";
            List<string> messages = new List<string>();
            foreach (string raw in body.Split('\n'))
            {
                string line = raw.Trim();
                int eq = line.IndexOf('=');
                if (eq <= 0) continue;
                string key = line.Substring(0, eq);
                string val = line.Substring(eq + 1);
                int n;
                if (key == "interval" && int.TryParse(val, out n)) intervalSec = Math.Max(1, Math.Min(60, n));
                else if (key == "maxw" && int.TryParse(val, out n)) maxW = Math.Max(320, Math.Min(3840, n));
                else if (key == "quality" && int.TryParse(val, out n)) quality = Math.Max(10, Math.Min(95, n));
                else if (key == "locked") wantLock = val == "1";
                else if (key == "locktext") lockText = Unesc(val);
                else if (key == "msg")
                {
                    int bar = val.IndexOf('|');
                    long id;
                    if (bar > 0 && long.TryParse(val.Substring(0, bar), out id) && id > lastMsgId)
                    {
                        lastMsgId = id;
                        messages.Add(Unesc(val.Substring(bar + 1)));
                    }
                }
            }
            ui.BeginInvoke(new MethodInvoker(delegate
            {
                ApplyLock(wantLock, lockText);
                foreach (string m in messages) ShowMessage(m);
            }));
        }

        static string Unesc(string s)
        {
            try { return Uri.UnescapeDataString(s); } catch { return s; }
        }

        static byte[] Capture(int maxWidth, long jpegQuality)
        {
            Rectangle b = SystemInformation.VirtualScreen; // 모니터가 여러 대면 전부 포함
            using (Bitmap full = new Bitmap(b.Width, b.Height, PixelFormat.Format24bppRgb))
            {
                using (Graphics g = Graphics.FromImage(full))
                    g.CopyFromScreen(b.Left, b.Top, 0, 0, b.Size, CopyPixelOperation.SourceCopy);

                int w = b.Width, h = b.Height;
                if (w > maxWidth)
                {
                    h = (int)((long)h * maxWidth / w);
                    w = maxWidth;
                }
                using (Bitmap small = new Bitmap(w, h, PixelFormat.Format24bppRgb))
                {
                    using (Graphics g2 = Graphics.FromImage(small))
                    {
                        g2.InterpolationMode = InterpolationMode.HighQualityBilinear;
                        g2.DrawImage(full, 0, 0, w, h);
                    }
                    ImageCodecInfo jpeg = null;
                    foreach (ImageCodecInfo c in ImageCodecInfo.GetImageEncoders())
                    {
                        if (c.FormatID == ImageFormat.Jpeg.Guid) jpeg = c;
                    }
                    using (MemoryStream ms = new MemoryStream())
                    {
                        if (jpeg == null)
                        {
                            small.Save(ms, ImageFormat.Jpeg);
                        }
                        else
                        {
                            using (EncoderParameters ep = new EncoderParameters(1))
                            {
                                ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, jpegQuality);
                                small.Save(ms, jpeg, ep);
                            }
                        }
                        return ms.ToArray();
                    }
                }
            }
        }

        // ---------- UI 스레드 ----------
        void ApplyLock(bool want, string text)
        {
            if (text == null || text.Length == 0) text = DefaultLockText;
            if (want)
            {
                if (lockScreen == null) lockScreen = new LockScreen(text);
                else lockScreen.SetText(text);
                locked = true;
            }
            else if (lockScreen != null)
            {
                lockScreen.Close();
                lockScreen = null;
                locked = false;
            }
        }

        void ShowMessage(string text)
        {
            if (lockScreen != null)
            {
                lockScreen.SetText(text); // 잠긴 동안에는 잠금 화면에 표시
                return;
            }
            Form f = new Form();
            f.Text = "ITC 영어 - 선생님 메시지";
            f.TopMost = true;
            f.StartPosition = FormStartPosition.CenterScreen;
            f.FormBorderStyle = FormBorderStyle.FixedDialog;
            f.MaximizeBox = false;
            f.MinimizeBox = false;
            f.ShowInTaskbar = false;
            f.ClientSize = new Size((int)(560 * scale), (int)(260 * scale));
            f.BackColor = Color.White;

            Label l = new Label();
            l.Dock = DockStyle.Fill;
            l.TextAlign = ContentAlignment.MiddleCenter;
            l.Font = new Font("Malgun Gothic", 16f, FontStyle.Bold);
            l.Padding = new Padding((int)(16 * scale));
            l.Text = text;

            Button ok = new Button();
            ok.Dock = DockStyle.Bottom;
            ok.Height = (int)(52 * scale);
            ok.Font = new Font("Malgun Gothic", 12f);
            ok.Text = "확인";
            ok.FlatStyle = FlatStyle.Flat;
            ok.FlatAppearance.BorderSize = 0;
            ok.BackColor = Color.FromArgb(0, 137, 207);
            ok.ForeColor = Color.White;
            ok.Click += delegate { f.Close(); };
            f.FormClosed += delegate { f.Dispose(); };

            f.Controls.Add(l);
            f.Controls.Add(ok);
            f.AcceptButton = ok;
            f.Show();
            f.Activate();
        }
    }
}
