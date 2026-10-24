using System;
using System.Drawing;
using System.IO;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace CheesyBeez
{
    /// <summary>
    /// The counter's window onto the shop server on this PC (http://localhost:8080): full screen,
    /// its own icon, no browser around it, no browser pop-ups. If the server is still starting (or
    /// restarting after an update), it shows a calm "Starting CheesyBeez" page and keeps trying.
    /// Always full screen (a counter has no use for a small window); Alt+F4 closes the app.
    /// </summary>
    internal static class Program
    {
        private const string Pos = "http://localhost:8080/";

        [STAThread]
        private static void Main()
        {
            // One window is enough: a second start just brings the first one forward.
            using (var single = new Mutex(true, "CheesyBeezPOS.Counter", out var first))
            {
                if (!first) { NativeFocus.Existing("CheesyBeez POS"); return; }
                NativeFocus.SharpOnScaledScreens();
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new PosWindow(Pos));
            }
        }
    }

    internal sealed class PosWindow : Form
    {
        private readonly WebView2 web = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = Color.FromArgb(0xF2, 0xF1, 0xEF) };
        private readonly string url;
        private readonly HttpClient http = new HttpClient { Timeout = TimeSpan.FromSeconds(3) };
        private bool waiting;

        public PosWindow(string url)
        {
            this.url = url;
            Text = "CheesyBeez POS";
            Icon = new Icon(typeof(Program).Assembly.GetManifestResourceStream("CheesyBeez.app.ico"));
            BackColor = Color.FromArgb(0xF2, 0xF1, 0xEF);
            FormBorderStyle = FormBorderStyle.None;     // full screen: no title bar, no edges
            WindowState = FormWindowState.Maximized;    // borderless + maximised covers the taskbar too
            Controls.Add(web);
            Load += async (s, e) => await StartAsync();
        }

        private async Task StartAsync()
        {
            // The app's own storage (the counter's pairing, its settings), apart from any browser.
            var data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CheesyBeez", "pos-app");
            // Keep the page running at full speed when the window is minimised or covered: the update
            // notice, the kitchen chime and the sync sign must not freeze until someone restores it.
            var options = new CoreWebView2EnvironmentOptions("--disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows");
            var env = await CoreWebView2Environment.CreateAsync(null, data, options);
            await web.EnsureCoreWebView2Async(env);
            var core = web.CoreWebView2;
            core.Settings.AreDefaultContextMenusEnabled = false;   // no "Inspect", "Back", "Print"…
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.IsZoomControlEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.AreBrowserAcceleratorKeysEnabled = false; // no Ctrl+P, Ctrl+F, F5 and friends
            core.Settings.IsPasswordAutosaveEnabled = false;
            core.Settings.IsGeneralAutofillEnabled = false;
            core.DocumentTitleChanged += (s, e) => Text = "CheesyBeez POS";
            // Links to anywhere else (GitHub, the cloud) open in the normal browser, never inside the POS.
            core.NewWindowRequested += (s, e) => { e.Handled = true; OpenOutside(e.Uri); };
            core.NavigationStarting += (s, e) => { if (!IsPos(e.Uri) && !e.Uri.StartsWith("data:")) { e.Cancel = true; OpenOutside(e.Uri); } };
            core.NavigationCompleted += async (s, e) => { if (!e.IsSuccess && !waiting) await WaitForServerAsync(); };
            await WaitForServerAsync();
        }

        private bool IsPos(string uri) => uri.StartsWith(url, StringComparison.OrdinalIgnoreCase);

        private static void OpenOutside(string uri)
        {
            try { System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(uri) { UseShellExecute = true }); } catch { }
        }

        /// <summary>Starting with Windows, or restarting after an update: wait calmly, then open the POS.</summary>
        private async Task WaitForServerAsync()
        {
            waiting = true;
            web.CoreWebView2.NavigateToString(StartingPage);
            for (;;)
            {
                try
                {
                    var r = await http.GetAsync(url + "api/v1/health");
                    if (r.IsSuccessStatusCode) break;
                }
                catch { }
                await Task.Delay(1000);
            }
            waiting = false;
            web.CoreWebView2.Navigate(url);
        }

        private const string StartingPage = @"<!doctype html><html><head><meta charset='utf-8'><style>
html,body{margin:0;height:100%;background:#F2F1EF;color:#1C1C1E;font-family:'DM Sans','Segoe UI',sans-serif}
main{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px}
h1{margin:0;font-size:26px;font-weight:500;letter-spacing:-.5px}p{margin:0;color:#6E6D72;font-size:16px}
i{width:36px;height:36px;border-radius:50%;border:3px solid #E3E1DE;border-top-color:#E8A94B;animation:s 900ms linear infinite}
@keyframes s{to{transform:rotate(360deg)}}</style></head><body><main><i></i><h1>Starting CheesyBeez</h1>
<p>This takes a few seconds, or a minute or two after an update. Sales already taken are safe.</p></main></body></html>";
    }

    /// <summary>Brings an already running counter window to the front.</summary>
    internal static class NativeFocus
    {
        [System.Runtime.InteropServices.DllImport("user32.dll")] private static extern IntPtr FindWindow(string cls, string title);
        [System.Runtime.InteropServices.DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hwnd);
        [System.Runtime.InteropServices.DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr hwnd, int cmd);
        [System.Runtime.InteropServices.DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr value);

        /// <summary>Crisp text on laptops that scale the screen (125%, 150%): this app draws at the real resolution.</summary>
        public static void SharpOnScaledScreens()
        {
            try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { } // per-monitor v2 (Windows 10 1703 and later)
        }

        public static void Existing(string title)
        {
            var h = FindWindow(null, title);
            if (h == IntPtr.Zero) return;
            ShowWindow(h, 9); // restore
            SetForegroundWindow(h);
        }
    }
}
