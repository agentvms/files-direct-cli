// Files Direct: the tray and launcher program of the Windows app (files-direct-34).
// Written in the plain C# that the compiler in every Windows (.NET Framework 4) understands.
//
// It has no console window. It does two things and holds no rule of its own:
//   1. "Files Direct.exe verb <path>" and "Files Direct.exe sendto <paths...>" (what the right-click entry and Send to start): it hands the chosen paths to the program's
//      engine (files-direct.mjs, run by the Node in this folder) on the engine's standard input, one after another, each ended by a NUL byte (a path cannot hold one).
//      The paths are NEVER put into a command line, so a name made of quotes, spaces, "&", "%" or "^" is only ever a name.
//   2. "Files Direct.exe paths-stdin": the same, for the Store package's menu handler (files-direct-37), which is given everything that was selected at once and writes the paths to this
//      program's standard input itself (NUL-separated, nothing in a command line), so the whole selection is one room and no waiting for the others is needed.
//   3. With no arguments it is the tray icon and its menu. Every menu item starts the engine with fixed words; the files the person picks go in on the standard input.
// Since files-direct-60 the page the engine serves is shown in a window of this program (WebView2: the Microsoft Edge engine that comes with Windows 10 and 11), not in a browser. The engine
// is started with --shell-window: it serves the page on 127.0.0.1 as before and prints one line with its address, and this program opens that address and nothing else. With no WebView2 on
// the computer, every entry starts the engine as before (the browser). Every rule of the page stays in the engine.
// Built with FD_NAIVE defined it does the careless thing instead (the paths pasted into the command line, unquoted): the checks use that build to show that a hostile name
// breaks it, so that the real build passing means something.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.IO;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using System.Runtime.CompilerServices;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace FilesDirect
{
    static class Program
    {
        static readonly string Here = AppDomain.CurrentDomain.BaseDirectory;
        static string Node { get { return Path.Combine(Here, "node.exe"); } }
        static string Engine { get { return Path.Combine(Here, "files-direct.mjs"); } }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        static extern int GetCurrentPackageFullName(ref int length, StringBuilder name);

        static bool? packaged;
        /// <summary>True when this runs as the Microsoft Store package: the package is installed, updated and removed by the Store, and its menu entry is in its manifest.</summary>
        public static bool Packaged
        {
            get
            {
                if (packaged == null)
                {
                    try
                    {
                        int length = 0;
                        packaged = GetCurrentPackageFullName(ref length, null) != 15700; // APPMODEL_ERROR_NO_PACKAGE: a program that is not packaged has no package name
                    }
                    catch (Exception) { packaged = false; } // an older Windows has no such call: it is not packaged
                }
                return packaged.Value;
            }
        }

        [STAThread]
        static int Main(string[] args)
        {
            if (args.Length >= 1 && (args[0] == "verb" || args[0] == "sendto"))
            {
                return args.Length < 2 ? 2 : HandOver(args[0], new List<string>(args).GetRange(1, args.Length - 1));
            }
            if (args.Length == 1 && args[0] == "paths-stdin")
            {
                return FromStdin();
            }
            if (args.Length >= 1 && args[0] == "quit")
            {
                // what the installer and the uninstaller run first: ask the running tray program to end (it has no window an installer could close)
                try { EventWaitHandle.OpenExisting("Local\\FilesDirectTrayQuit").Set(); } catch (Exception) { }
                return 0;
            }
            bool first;
            using (Mutex one = new Mutex(true, "Local\\FilesDirectTray", out first))
            {
                if (!first) return 0;
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                bool now = Array.IndexOf(args, "--update-now") >= 0;
                using (Tray tray = new Tray(now))
                {
                    Application.Run(tray);
                }
            }
            return 0;
        }

        /// <summary>The menu handler of the Store package writes the chosen paths here, each ended by a NUL byte (a path cannot hold one). They go on to the engine the same way.</summary>
        static int FromStdin()
        {
            List<string> paths = new List<string>();
            byte[] all;
            using (Stream input = Console.OpenStandardInput())
            using (MemoryStream copy = new MemoryStream())
            {
                input.CopyTo(copy);
                all = copy.ToArray();
            }
            int start = 0;
            for (int i = 0; i < all.Length; i++)
            {
                if (all[i] == 0)
                {
                    if (i > start) paths.Add(new UTF8Encoding(false).GetString(all, start, i - start));
                    start = i + 1;
                }
            }
            return paths.Count == 0 ? 2 : HandOver("send", paths);
        }

        internal static ProcessStartInfo Engine_(string words)
        {
            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = Node;
            psi.Arguments = "\"" + Engine + "\" " + words; // the words are ours and fixed: never a name the person chose
            psi.WorkingDirectory = Here;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.WindowStyle = ProcessWindowStyle.Hidden;
            return psi;
        }

        /// <summary>Starts the engine for the chosen paths. The paths go in on its standard input, NUL-separated; nothing is pasted into a command line.</summary>
        public static int HandOver(string mode, List<string> paths)
        {
            List<string> full = new List<string>();
            foreach (string p in paths) full.Add(Path.GetFullPath(p));
            string gather = mode == "verb" ? "--gather " : "";
#if FD_NAIVE
            ProcessStartInfo psi = Engine_("open --app " + gather + "-- " + string.Join(" ", full.ToArray()));
            Process.Start(psi);
            return 0;
#else
            // the app's own window, when this computer has WebView2; otherwise the engine opens the browser, as before
            if (Shell.Available) return Shell.RunVerb(mode, full);
            ProcessStartInfo psi = Engine_("open --app " + gather + "--paths-stdin");
            psi.RedirectStandardInput = true;
            Process child = Process.Start(psi);
            using (Stream s = child.StandardInput.BaseStream)
            {
                UTF8Encoding utf8 = new UTF8Encoding(false);
                foreach (string p in full)
                {
                    byte[] b = utf8.GetBytes(p);
                    s.Write(b, 0, b.Length);
                    s.WriteByte(0);
                }
            }
            return 0;
#endif
        }

        public static void Start(string words)
        {
            try { Process.Start(Engine_(words)); } catch (Exception) { }
        }

        /// <summary>Starts the engine and gives the process back, so the tray can end it when it quits (the listener of files-direct-40). Null when it did not start.</summary>
        public static Process StartKept(string words)
        {
            try { return Process.Start(Engine_(words)); } catch (Exception) { return null; }
        }

        /// <summary>Runs the engine and waits; returns what it printed. The words are fixed.</summary>
        public static string Run(string words, out int status)
        {
            ProcessStartInfo psi = Engine_(words);
            psi.RedirectStandardOutput = true;
            try
            {
                using (Process p = Process.Start(psi))
                {
                    string output = p.StandardOutput.ReadToEnd();
                    p.WaitForExit();
                    status = p.ExitCode;
                    return output;
                }
            }
            catch (Exception e)
            {
                status = 127;
                return e.Message;
            }
        }

        public static Dictionary<string, object> LastJson(string output)
        {
            string[] lines = output.Split('\n');
            JavaScriptSerializer json = new JavaScriptSerializer();
            for (int i = lines.Length - 1; i >= 0; i--)
            {
                string line = lines[i].Trim();
                if (line.StartsWith("{"))
                {
                    try { return json.DeserializeObject(line) as Dictionary<string, object>; } catch (Exception) { }
                }
            }
            return null;
        }

        public static string Text(Dictionary<string, object> j, string key)
        {
            object v;
            return j != null && j.TryGetValue(key, out v) && v != null ? v.ToString() : null;
        }
    }

    sealed class Tray : ApplicationContext
    {
        readonly NotifyIcon icon = new NotifyIcon();
        readonly ContextMenuStrip menu = new ContextMenuStrip();
        readonly SynchronizationContext ui;
        readonly string version;
        readonly EventWaitHandle quitSignal = new EventWaitHandle(false, EventResetMode.AutoReset, "Local\\FilesDirectTrayQuit");
        /// <summary>The engine's listener (files-direct-40): it holds the connection to every device this computer remembers while the app runs, and opens the window when one asks to send. It also ends by itself within seconds of this program going away.</summary>
        Process listener;
        /// <summary>The same listener when the app shows its own window: its pages are shown in windows of this program.</summary>
        ShellRun listenerRun;
        /// <summary>The run of the menu's Send, Ask and Receive while its window is open or opening: a second choice brings that window forward and starts no second run.</summary>
        ShellRun userRun;

        public Tray(bool updateNow)
        {
            ui = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();
            version = FileVersionInfo.GetVersionInfo(Application.ExecutablePath).ProductVersion;
            ToolStripMenuItem head = new ToolStripMenuItem("Files Direct " + version);
            head.Enabled = false;
            menu.Items.Add(head);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Send files…", null, delegate { SendFiles(); });
            menu.Items.Add("Send a folder…", null, delegate { SendFolder(); });
            menu.Items.Add("Ask for files", null, delegate { OpenWindow(null); });
            menu.Items.Add("Receive by link or code", null, delegate { OpenWindow(null); });
            menu.Items.Add(new ToolStripSeparator());
            // the Store package is updated and removed by the Store (Settings, Apps), not by this program
            if (!Program.Packaged)
            {
                menu.Items.Add("Check for updates…", null, delegate { CheckForUpdates(); });
                menu.Items.Add("Remove Files Direct…", null, delegate { RemoveApp(); });
                menu.Items.Add(new ToolStripSeparator());
            }
            menu.Items.Add("Quit Files Direct", null, delegate { Quit(); });
            icon.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            icon.Text = "Files Direct";
            icon.ContextMenuStrip = menu;
            icon.MouseClick += delegate (object s, MouseEventArgs e)
            {
                if (e.Button == MouseButtons.Left) menu.Show(Cursor.Position);
            };
            icon.Visible = true;
            ThreadPool.RegisterWaitForSingleObject(quitSignal, delegate (object state, bool timedOut) { ui.Post(delegate { Quit(); }, null); }, null, -1, true);
            // the right-click entry is written, or written again, each time the app starts: it points at the launcher in this folder.
            // The Store package does not: its entry is in its manifest, and the manifest alone adds it and removes it.
            if (!Program.Packaged)
            {
                ThreadPool.QueueUserWorkItem(delegate
                {
                    int status;
                    Program.Run("menu install --app --launcher \"" + Application.ExecutablePath + "\"", out status);
                });
            }
            if (Shell.Available)
            {
                listenerRun = new ShellRun("listen --app --shell-window", null, false, null);
                if (!listenerRun.Start()) listenerRun = null;
            }
            else listener = Program.StartKept("listen --app");
            if (updateNow && !Program.Packaged) ThreadPool.QueueUserWorkItem(delegate { Install(); });
        }

        void SendFiles()
        {
            if (FocusOpenWindow()) return;
            using (OpenFileDialog d = new OpenFileDialog())
            {
                d.Title = "Choose the files to send";
                d.Multiselect = true;
                d.CheckFileExists = true;
                if (d.ShowDialog() == DialogResult.OK && d.FileNames.Length > 0) OpenWindow(new List<string>(d.FileNames));
            }
        }

        void SendFolder()
        {
            if (FocusOpenWindow()) return;
            using (FolderBrowserDialog d = new FolderBrowserDialog())
            {
                d.Description = "Choose the folder to send";
                if (d.ShowDialog() == DialogResult.OK && d.SelectedPath.Length > 0) OpenWindow(new List<string> { d.SelectedPath });
            }
        }

        /// <summary>A window is open (or opening): it is brought forward and true is returned, so the menu shows no file picker and starts nothing. Without WebView2 there is no window of ours, and false.</summary>
        bool FocusOpenWindow()
        {
            if (!Shell.Available) return false;
            if (userRun == null && Shell.SlotFree()) return false;
            Shell.SignalFocus();
            return true;
        }

        /// <summary>Send, Ask and Receive from the menu: one window at a time. With a window open (or opening), that window is brought forward and nothing new is started. With no WebView2 the engine opens the browser, as before.</summary>
        void OpenWindow(List<string> paths)
        {
            if (!Shell.Available)
            {
                if (paths == null) Program.Start("open --app");
                else Program.HandOver("send", paths);
                return;
            }
            if (FocusOpenWindow()) return;
            List<string> full = null;
            if (paths != null)
            {
                full = new List<string>();
                foreach (string p in paths) full.Add(Path.GetFullPath(p));
            }
            ShellRun run = null;
            run = new ShellRun("open --app --shell-window" + (full == null ? "" : " --paths-stdin"), full, true, delegate { if (userRun == run) userRun = null; });
            userRun = run;
            if (!run.Start()) userRun = null;
        }

        void Say(string title, string text)
        {
            MessageBox.Show(text, title, MessageBoxButtons.OK, MessageBoxIcon.Information);
        }

        void CheckForUpdates()
        {
            ThreadPool.QueueUserWorkItem(delegate
            {
                int status;
                Dictionary<string, object> j = Program.LastJson(Program.Run("update check --json", out status));
                string state = Program.Text(j, "state");
                ui.Post(delegate
                {
                    if (state == "available")
                    {
                        string v = Program.Text(j, "version");
                        if (MessageBox.Show("Files Direct " + v + " is ready. Install it now? Files Direct closes and opens again.", "Files Direct", MessageBoxButtons.YesNo, MessageBoxIcon.Question) == DialogResult.Yes)
                            ThreadPool.QueueUserWorkItem(delegate { Install(); });
                    }
                    else if (state == "current") Say("Files Direct is up to date", "You have the newest version (" + version + ").");
                    else Say("No update", Program.Text(j, "message") ?? "Files Direct could not look for an update.");
                }, null);
            });
        }

        void Install()
        {
            int status;
            Dictionary<string, object> j = Program.LastJson(Program.Run("update install --json", out status));
            ui.Post(delegate
            {
                if (status == 0) Quit(); // the installer is running: it closes this program anyway
                else Say("The update was not installed", Program.Text(j, "message") ?? "Something went wrong. Nothing was changed.");
            }, null);
        }

        void RemoveApp()
        {
            if (MessageBox.Show("Remove Files Direct? This takes \"Send with Files Direct\" out of the right-click menu and Send to, and removes the app. Files you sent or received stay where they are.", "Files Direct", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;
            string uninstaller = Path.Combine(Path.GetDirectoryName(Application.ExecutablePath), "unins000.exe");
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo(uninstaller, "/SILENT");
                psi.UseShellExecute = false;
                Process.Start(psi);
            }
            catch (Exception)
            {
                Say("Remove Files Direct", "Open Settings, then Apps, find Files Direct and choose Uninstall.");
                return;
            }
            Quit();
        }

        void Quit()
        {
            try { if (listener != null && !listener.HasExited) listener.Kill(); } catch (Exception) { }
            if (listenerRun != null) listenerRun.Stop();
            if (userRun != null) userRun.Stop();
            icon.Visible = false;
            ExitThread();
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing) { icon.Dispose(); menu.Dispose(); quitSignal.Close(); }
            base.Dispose(disposing);
        }
    }

    /// <summary>
    /// The app's own window (files-direct-60). The engine serves the page on 127.0.0.1 and prints its address; the window shows that address and nothing else.
    /// One window at a time for the menu and the right-click entry: the program that has it open holds a named slot, and a second Send finds the slot taken and brings that window forward.
    /// </summary>
    static class Shell
    {
        const string SlotName = "Local\\FilesDirectWindow";
        const string FocusName = "Local\\FilesDirectFocus";
        static bool? available;
        static Mutex slot;
        static EventWaitHandle focus;
        static RegisteredWaitHandle focusWait;

        /// <summary>True when this computer has WebView2 (the runtime that comes with Windows 10 and 11 and with Microsoft Edge). When it has not, or when it cannot be asked, the browser is used, as before.</summary>
        public static bool Available
        {
            get
            {
                if (available == null)
                {
                    try
                    {
                        string off = Environment.GetEnvironmentVariable("FILES_DIRECT_NO_WEBVIEW");
                        available = string.IsNullOrEmpty(off) && !string.IsNullOrEmpty(RuntimeVersion());
                    }
                    catch (Exception) { available = false; } // no runtime, or its files are not here: the browser
                }
                return available.Value;
            }
        }

        // the one place that touches WebView2 before there is a window: kept apart so that a missing file is caught by the caller, not by the first use of this class
        [MethodImpl(MethodImplOptions.NoInlining)]
        static string RuntimeVersion()
        {
            return CoreWebView2Environment.GetAvailableBrowserVersionString();
        }

        /// <summary>True when the page's own address, and nothing else, is what a window may show: http, 127.0.0.1, under /w/.</summary>
        public static bool IsPageAddress(string address)
        {
            Uri u;
            return Uri.TryCreate(address, UriKind.Absolute, out u) && u.Scheme == "http" && u.Host == "127.0.0.1" && u.UserInfo.Length == 0 && u.AbsolutePath.StartsWith("/w/", StringComparison.Ordinal);
        }

        /// <summary>Anything else the page links to goes to the person's own browser. Only web addresses: nothing else is opened from here.</summary>
        public static void OpenOutside(string address)
        {
            Uri u;
            if (!Uri.TryCreate(address, UriKind.Absolute, out u) || (u.Scheme != "https" && u.Scheme != "http")) return;
            try { Process.Start(new ProcessStartInfo(u.AbsoluteUri) { UseShellExecute = true }); } catch (Exception) { }
        }

        /// <summary>True when a window of this app is open (here or in another program of this app): the slot is taken.</summary>
        public static bool SlotFree()
        {
            if (slot != null) return false;
            using (Mutex m = new Mutex(false, SlotName))
            {
                try
                {
                    if (m.WaitOne(0))
                    {
                        m.ReleaseMutex();
                        return true;
                    }
                    return false;
                }
                catch (AbandonedMutexException)
                {
                    try { m.ReleaseMutex(); } catch (Exception) { }
                    return true; // the program that held it is gone
                }
            }
        }

        /// <summary>Takes the slot for this program's window and listens for a second Send. False when somebody else has it.</summary>
        public static bool TakeSlot(Action bringForward)
        {
            if (slot != null) return false;
            Mutex m = new Mutex(false, SlotName);
            bool got;
            try { got = m.WaitOne(0); }
            catch (AbandonedMutexException) { got = true; }
            if (!got)
            {
                m.Close();
                return false;
            }
            slot = m;
            focus = new EventWaitHandle(false, EventResetMode.AutoReset, FocusName);
            SynchronizationContext ui = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();
            focusWait = ThreadPool.RegisterWaitForSingleObject(focus, delegate (object state, bool timedOut) { ui.Post(delegate { bringForward(); }, null); }, null, -1, false);
            return true;
        }

        public static void ReleaseSlot()
        {
            if (focusWait != null) { focusWait.Unregister(null); focusWait = null; }
            if (focus != null) { focus.Close(); focus = null; }
            if (slot != null)
            {
                try { slot.ReleaseMutex(); } catch (Exception) { }
                slot.Close();
                slot = null;
            }
        }

        /// <summary>A second Send: the program that has the window open brings it forward, and nothing new is started.</summary>
        public static void SignalFocus()
        {
            try { using (EventWaitHandle e = new EventWaitHandle(false, EventResetMode.AutoReset, FocusName)) e.Set(); } catch (Exception) { }
        }

        /// <summary>What the right-click entry and Send to run (a program of its own, started for the chosen paths): with a window already open it brings that one forward and ends; otherwise it starts the engine and shows its window.</summary>
        public static int RunVerb(string mode, List<string> paths)
        {
            if (!SlotFree())
            {
                SignalFocus();
                return 0;
            }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new VerbContext(mode, paths));
            return 0;
        }
    }

    /// <summary>The program started for one right-click or Send to: it ends with its window (and with the engine, which ends when the window is closed).</summary>
    sealed class VerbContext : ApplicationContext
    {
        readonly string mode;
        readonly List<string> paths;
        ShellRun run;

        public VerbContext(string mode, List<string> paths)
        {
            this.mode = mode;
            this.paths = paths;
            Application.Idle += Begin;
        }

        void Begin(object sender, EventArgs e)
        {
            Application.Idle -= Begin;
            // the paths go in on the engine's standard input, never in a command line; "verb" asks the engine to gather the other programs of the same right-click
            run = new ShellRun("open --app --shell-window " + (mode == "verb" ? "--gather " : "") + "--paths-stdin", paths, true, delegate { ExitThread(); });
            if (!run.Start()) ExitThread();
        }
    }

    /// <summary>One run of the engine whose page this program shows. It prints {"event":"window","url":...} when its page is ready and {"event":"closed",...} when the person's meeting is over.</summary>
    sealed class ShellRun
    {
        readonly string words;
        readonly List<string> paths;
        readonly bool user;
        readonly Action done;
        readonly SynchronizationContext ui;
        readonly Dictionary<string, AppForm> forms = new Dictionary<string, AppForm>();
        Process process;
        bool exited;
        bool slotHeld;
        bool finished;
        int cleaning;

        /// <param name="user">A run of the menu or the right-click entry (one window at a time, the slot); false for the listener, whose windows are its own.</param>
        public ShellRun(string words, List<string> paths, bool user, Action done)
        {
            this.words = words;
            this.paths = paths;
            this.user = user;
            this.done = done;
            ui = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();
        }

        public bool Start()
        {
            ProcessStartInfo psi = Program.Engine_(words);
            psi.RedirectStandardOutput = true;
            psi.StandardOutputEncoding = new UTF8Encoding(false);
            psi.RedirectStandardInput = paths != null;
            try
            {
                process = new Process();
                process.StartInfo = psi;
                process.EnableRaisingEvents = true;
                process.OutputDataReceived += delegate (object s, DataReceivedEventArgs e)
                {
                    if (e.Data != null)
                    {
                        string line = e.Data;
                        ui.Post(delegate { Heard(line); }, null);
                    }
                };
                process.Exited += delegate
                {
                    try { process.WaitForExit(); } catch (Exception) { } // everything it printed is read first
                    ui.Post(delegate { Ended(); }, null);
                };
                process.Start();
                process.BeginOutputReadLine();
            }
            catch (Exception) { return false; }
            if (paths != null) WritePaths();
            return true;
        }

        /// <summary>The paths go in on the standard input, NUL-separated; nothing is pasted into a command line.</summary>
        void WritePaths()
        {
            try
            {
                using (Stream s = process.StandardInput.BaseStream)
                {
                    UTF8Encoding utf8 = new UTF8Encoding(false);
                    foreach (string p in paths)
                    {
                        byte[] b = utf8.GetBytes(p);
                        s.Write(b, 0, b.Length);
                        s.WriteByte(0);
                    }
                }
            }
            catch (Exception) { }
        }

        void Heard(string line)
        {
            Dictionary<string, object> j = Program.LastJson(line);
            string address = Program.Text(j, "url");
            if (address == null) return;
            string kind = Program.Text(j, "event");
            if (kind == "window") Show(address);
            else if (kind == "closed")
            {
                AppForm f;
                if (forms.TryGetValue(address, out f)) f.EndedByEngine();
            }
        }

        void Show(string address)
        {
            if (forms.ContainsKey(address) || !Shell.IsPageAddress(address)) return;
            if (user && !slotHeld)
            {
                // somebody else opened a window while this engine was starting: that one is brought forward and this run ends
                if (!Shell.TakeSlot(BringForward))
                {
                    Shell.SignalFocus();
                    Stop();
                    return;
                }
                slotHeld = true;
            }
            AppForm form = new AppForm(address);
            forms[address] = form;
            form.PersonClosed += delegate { if (user) StopSoon(); };
            form.FormClosed += delegate
            {
                forms.Remove(address);
                if (user && !exited && !form.BrowserFallback) StopSoon(); // a window that went without being asked leaves no engine behind; one that handed its page to the browser leaves it, the browser is showing it
                cleaning++; // the window's profile is still to be deleted: the run is not over until it is
                if (forms.Count == 0) Idle();
            };
            form.Cleaned += delegate
            {
                cleaning--;
                if (forms.Count == 0) Idle();
            };
            form.Show();
        }

        void BringForward()
        {
            foreach (AppForm f in forms.Values) { f.BringForward(); break; }
        }

        void Ended()
        {
            exited = true;
            foreach (AppForm f in new List<AppForm>(forms.Values)) f.EndedByEngine();
            if (forms.Count == 0) Idle();
        }

        void Idle()
        {
            if (slotHeld)
            {
                Shell.ReleaseSlot();
                slotHeld = false;
            }
            if (exited && !finished && cleaning == 0)
            {
                finished = true;
                if (done != null) done();
            }
        }

        /// <summary>The window was closed and the page was told to close (which ends the engine's run): if the engine is still there three seconds later, it is ended.</summary>
        void StopSoon()
        {
            System.Windows.Forms.Timer t = new System.Windows.Forms.Timer();
            t.Interval = 3000;
            t.Tick += delegate
            {
                t.Stop();
                t.Dispose();
                Kill();
            };
            t.Start();
        }

        void Kill()
        {
            try { if (process != null && !process.HasExited) process.Kill(); } catch (Exception) { }
        }

        public void Stop()
        {
            Kill();
            foreach (AppForm f in new List<AppForm>(forms.Values)) f.EndedByEngine();
        }
    }

    /// <summary>The Files Direct window: a form with a WebView2 that shows one address, the one the engine printed, and nothing the page links to. It keeps nothing: its profile is a temporary folder that is deleted when the window closes.</summary>
    sealed class AppForm : Form
    {
        readonly WebView2 web = new WebView2();
        readonly string address;
        readonly string dataFolder;
        bool finished;
        bool closing;

        /// <summary>The window could not start and its page went to the browser: its closing is no end of the run, the engine goes on serving the page.</summary>
        public bool BrowserFallback;

        /// <summary>The person closed the window: what runs behind it is to end.</summary>
        public event EventHandler PersonClosed;

        /// <summary>The window is closed and its temporary profile is gone (or could not be removed within ten seconds). The program that shows the window ends only after this.</summary>
        public event EventHandler Cleaned;

        public AppForm(string address)
        {
            this.address = address;
            Text = "Files Direct";
            ClientSize = new Size(480, 760);
            StartPosition = FormStartPosition.CenterScreen;
            ShowInTaskbar = true;
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch (Exception) { }
            dataFolder = Path.Combine(Path.GetTempPath(), "files-direct-window-" + Guid.NewGuid().ToString("N"));
            web.Dock = DockStyle.Fill;
            web.CreationProperties = new CoreWebView2CreationProperties();
            web.CreationProperties.UserDataFolder = dataFolder;
            Controls.Add(web);
            Shown += delegate { Begin(); };
        }

        async void Begin()
        {
            try
            {
                await web.EnsureCoreWebView2Async(null);
                CoreWebView2 core = web.CoreWebView2;
                core.Settings.AreDevToolsEnabled = false;
                core.Settings.IsStatusBarEnabled = false;
                core.NavigationStarting += OnNavigationStarting;
                core.NewWindowRequested += OnNewWindowRequested;
                core.Navigate(address);
            }
            catch (Exception)
            {
                // WebView2 would not start here after all: the page is shown in the browser, as it was before this window existed
                Shell.OpenOutside(address);
                finished = true;
                BrowserFallback = true;
                Close();
            }
        }

        /// <summary>The only addresses the window itself shows: the page's own address and what is below it. The check is on the whole text, so another port, another host or another word cannot pass.</summary>
        bool Inside(string target)
        {
            return target != null && target.StartsWith(address, StringComparison.Ordinal);
        }

        void OnNavigationStarting(object sender, CoreWebView2NavigationStartingEventArgs e)
        {
            if (Inside(e.Uri)) return;
            e.Cancel = true;
            Shell.OpenOutside(e.Uri);
        }

        /// <summary>A link that asks for a window of its own: never a second window of ours; the person's browser opens it.</summary>
        void OnNewWindowRequested(object sender, CoreWebView2NewWindowRequestedEventArgs e)
        {
            e.Handled = true;
            Shell.OpenOutside(e.Uri);
        }

        public void BringForward()
        {
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
            Activate();
            TopMost = true;
            TopMost = false;
        }

        /// <summary>The engine says the meeting is over (the page's Close was pressed, or the engine ended): the window closes with it.</summary>
        public void EndedByEngine()
        {
            Finish(false);
        }

        void Finish(bool person)
        {
            if (finished) return;
            finished = true;
            if (person && PersonClosed != null) PersonClosed(this, EventArgs.Empty);
            Close();
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            // any way a window is closed from outside (the red button, Alt+F4, the taskbar, a program that posts a close, an installer that closes the app) asks the page first; only the end of Windows or of this program does not
            if (!finished && e.CloseReason != CloseReason.WindowsShutDown && e.CloseReason != CloseReason.ApplicationExitCall)
            {
                e.Cancel = true;
                AskToClose();
                return;
            }
            base.OnFormClosing(e);
        }

        /// <summary>The person closed the window: the page's own Close is pressed (what its Close button does), which cancels what is running and ends the engine's run, and the engine says so ("closed") and the window goes. If that does not happen within two seconds, the window closes anyway and the engine's own watch on the page ends the run.</summary>
        void AskToClose()
        {
            if (closing) return;
            closing = true;
            try
            {
                if (web.CoreWebView2 != null) web.CoreWebView2.ExecuteScriptAsync("fetch('act', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ do: 'close' }) })");
                else { Finish(true); return; }
            }
            catch (Exception) { Finish(true); return; }
            System.Windows.Forms.Timer t = new System.Windows.Forms.Timer();
            t.Interval = 2000;
            t.Tick += delegate
            {
                t.Stop();
                t.Dispose();
                Finish(true);
            };
            t.Start();
        }

        protected override void OnFormClosed(FormClosedEventArgs e)
        {
            base.OnFormClosed(e);
            DeleteProfile();
        }

        /// <summary>The browser engine lets go of its folder a moment after the window, so the delete is tried again for up to ten seconds. It runs on the window's own thread, which the program keeps until Cleaned is raised.</summary>
        async void DeleteProfile()
        {
            try { web.Dispose(); } catch (Exception) { }
            for (int i = 0; i < 10; i++)
            {
                try
                {
                    if (Directory.Exists(dataFolder)) Directory.Delete(dataFolder, true);
                    break;
                }
                catch (Exception) { }
                await System.Threading.Tasks.Task.Delay(1000);
            }
            if (Cleaned != null) Cleaned(this, EventArgs.Empty);
        }
    }
}
