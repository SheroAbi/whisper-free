# =============================================================================
# Whisper Free - Win32 input helper
#
# A long-lived host process. It loads the Win32 P/Invoke interop ONCE (so the
# .NET / JIT cost is paid a single time at startup, not per keystroke) and then
# serves line-delimited commands on stdin, replying one line per command on
# stdout. This powers focus-restore + clipboard-paste + Unicode SendInput
# without any native module compilation.
#
# Protocol (UTF-8, one command per line, fields separated by '|'):
#   PING                      -> PONG
#   FG                        -> OK|<hwnd>|<pid>|<base64-utf16le title>
#   FOCUS|<hwnd>              -> OK|<focused?> | ERR|<msg>
#   PASTE                     -> OK            (sends Ctrl+V to active window)
#   ENTER                     -> OK
#   TYPE|<base64-utf16le>     -> OK            (Unicode SendInput)
#   INJECTPASTE|<hwnd>        -> OK|paste | ERR|<msg>   (focus then Ctrl+V)
#   INJECTTYPE|<hwnd>|<b64>   -> OK|type  | ERR|<msg>   (focus then Unicode type)
#   QUIT                      -> (exits)
# =============================================================================

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$cs = @"
using System;
using System.Runtime.InteropServices;
using System.Threading;

public static class Win32Input
{
    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }
    [StructLayout(LayoutKind.Explicit)]
    struct InputUnion {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct INPUT { public uint type; public InputUnion u; }

    const uint INPUT_KEYBOARD = 1;
    const uint KEYEVENTF_KEYUP = 0x0002;
    const uint KEYEVENTF_UNICODE = 0x0004;
    const ushort VK_CONTROL = 0x11;
    const ushort VK_V = 0x56;
    const ushort VK_RETURN = 0x0D;

    [DllImport("user32.dll", SetLastError = true)]
    static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("user32.dll")] static extern bool AllowSetForegroundWindow(uint dwProcessId);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")] static extern bool SystemParametersInfo(uint uiAction, uint uiParam, IntPtr pvParam, uint fWinIni);
    [DllImport("user32.dll")] static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, IntPtr dwExtraInfo);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hWnd);

    const int SW_RESTORE = 9;
    const int SW_SHOW = 5;
    const uint ASFW_ANY = 0xffffffff;
    const uint SPI_SETFOREGROUNDLOCKTIMEOUT = 0x2001;
    const uint SPIF_SENDCHANGE = 0x0002;
    const byte VK_MENU = 0x12;          // Alt
    const uint KEYEVENTF_KEYUP_B = 0x0002;

    public static IntPtr Foreground() { return GetForegroundWindow(); }

    public static int ForegroundPid(IntPtr h) { uint pid; GetWindowThreadProcessId(h, out pid); return (int)pid; }

    public static string Title(IntPtr h) {
        var sb = new System.Text.StringBuilder(512);
        GetWindowTextW(h, sb, sb.Capacity);
        return sb.ToString();
    }

    // Robust foreground activation. Windows refuses SetForegroundWindow for a
    // process that did not produce the most recent input, so we (1) zero the
    // foreground-lock timeout, (2) inject a stray Alt tap so our process counts
    // as the latest input source, (3) AttachThreadInput to the current
    // foreground thread, then (4) retry the activation a few times and VERIFY by
    // re-reading the foreground rather than trusting the return code.
    public static bool Focus(IntPtr hwnd) {
        if (hwnd == IntPtr.Zero || !IsWindow(hwnd)) return false;
        if (GetForegroundWindow() == hwnd) return true;
        if (IsIconic(hwnd)) ShowWindow(hwnd, SW_RESTORE);

        uint appThread = GetCurrentThreadId();
        IntPtr fore = GetForegroundWindow();
        uint foreThread = 0;
        if (fore != IntPtr.Zero) { uint pid; foreThread = GetWindowThreadProcessId(fore, out pid); }

        // (1)+(2): defuse the foreground lock. The Alt tap lands on the *current*
        // foreground (done before we switch), so the target receives a clean paste.
        SystemParametersInfo(SPI_SETFOREGROUNDLOCKTIMEOUT, 0, IntPtr.Zero, SPIF_SENDCHANGE);
        keybd_event(VK_MENU, 0, 0, IntPtr.Zero);
        keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP_B, IntPtr.Zero);

        bool attached = false;
        if (foreThread != 0 && foreThread != appThread) {
            attached = AttachThreadInput(appThread, foreThread, true);
        }
        AllowSetForegroundWindow(ASFW_ANY);

        bool ok = false;
        for (int i = 0; i < 6 && !ok; i++) {
            BringWindowToTop(hwnd);
            ShowWindow(hwnd, SW_SHOW);
            SetForegroundWindow(hwnd);
            Thread.Sleep(15);
            ok = (GetForegroundWindow() == hwnd);
        }
        if (attached) AttachThreadInput(appThread, foreThread, false);
        return ok || GetForegroundWindow() == hwnd;
    }

    static INPUT KeyVk(ushort vk, bool up) {
        var inp = new INPUT { type = INPUT_KEYBOARD };
        inp.u.ki = new KEYBDINPUT { wVk = vk, wScan = 0, dwFlags = up ? KEYEVENTF_KEYUP : 0, time = 0, dwExtraInfo = IntPtr.Zero };
        return inp;
    }
    static INPUT KeyUnicode(ushort ch, bool up) {
        var inp = new INPUT { type = INPUT_KEYBOARD };
        uint flags = KEYEVENTF_UNICODE | (up ? KEYEVENTF_KEYUP : 0);
        inp.u.ki = new KEYBDINPUT { wVk = 0, wScan = ch, dwFlags = flags, time = 0, dwExtraInfo = IntPtr.Zero };
        return inp;
    }

    public static uint SendCtrlV() {
        var inputs = new INPUT[] {
            KeyVk(VK_CONTROL, false),
            KeyVk(VK_V, false),
            KeyVk(VK_V, true),
            KeyVk(VK_CONTROL, true)
        };
        return SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    public static uint SendEnter() {
        var inputs = new INPUT[] { KeyVk(VK_RETURN, false), KeyVk(VK_RETURN, true) };
        return SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    public static uint SendText(string s) {
        if (string.IsNullOrEmpty(s)) return 0;
        var list = new System.Collections.Generic.List<INPUT>(s.Length * 2);
        foreach (char ch in s) {
            // \n -> Enter keystroke (most controls reject a raw \n via SendInput unicode).
            if (ch == '\n') { list.Add(KeyVk(VK_RETURN, false)); list.Add(KeyVk(VK_RETURN, true)); continue; }
            if (ch == '\r') continue;
            list.Add(KeyUnicode((ushort)ch, false));
            list.Add(KeyUnicode((ushort)ch, true));
        }
        if (list.Count == 0) return 0;
        var arr = list.ToArray();
        return SendInput((uint)arr.Length, arr, Marshal.SizeOf(typeof(INPUT)));
    }
}
"@

Add-Type -TypeDefinition $cs -Language CSharp | Out-Null

function Decode-B64Utf16([string]$b64) {
    if ([string]::IsNullOrEmpty($b64)) { return "" }
    $bytes = [Convert]::FromBase64String($b64)
    return [System.Text.Encoding]::Unicode.GetString($bytes)
}

function Reply([string]$line) {
    [Console]::Out.WriteLine($line)
    [Console]::Out.Flush()
}

# Signal readiness so the Node side knows the interop compiled successfully.
Reply "READY"

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }              # stdin closed -> parent gone
    $line = $line.Trim()
    if ($line -eq "") { continue }

    try {
        $parts = $line.Split('|')
        $cmd = $parts[0]
        switch ($cmd) {
            "PING" { Reply "PONG" }
            "QUIT" { break }
            "FG" {
                $h = [Win32Input]::Foreground()
                $pid = [Win32Input]::ForegroundPid($h)
                $title = [Win32Input]::Title($h)
                $tb64 = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($title))
                Reply ("OK|{0}|{1}|{2}" -f [int64]$h, $pid, $tb64)
            }
            "FOCUS" {
                $hwnd = [IntPtr]([int64]$parts[1])
                $ok = [Win32Input]::Focus($hwnd)
                Reply ("OK|{0}" -f $ok)
            }
            "PASTE" { [void][Win32Input]::SendCtrlV(); Reply "OK" }
            "ENTER" { [void][Win32Input]::SendEnter(); Reply "OK" }
            "TYPE" {
                $text = Decode-B64Utf16 $parts[1]
                [void][Win32Input]::SendText($text)
                Reply "OK"
            }
            "INJECTPASTE" {
                $hwnd = [IntPtr]([int64]$parts[1])
                $ok = [Win32Input]::Focus($hwnd)
                if (-not $ok) { Reply "ERR|focus-failed"; continue }
                Start-Sleep -Milliseconds 45
                [void][Win32Input]::SendCtrlV()
                Reply "OK|paste"
            }
            "INJECTTYPE" {
                $hwnd = [IntPtr]([int64]$parts[1])
                $ok = [Win32Input]::Focus($hwnd)
                if (-not $ok) { Reply "ERR|focus-failed"; continue }
                Start-Sleep -Milliseconds 45
                $text = Decode-B64Utf16 $parts[2]
                [void][Win32Input]::SendText($text)
                Reply "OK|type"
            }
            default { Reply "ERR|unknown-command" }
        }
    } catch {
        $msg = ($_.Exception.Message -replace "[\r\n|]", " ")
        Reply ("ERR|{0}" -f $msg)
    }
}
