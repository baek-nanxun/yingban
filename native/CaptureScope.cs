using System;
using System.Diagnostics;
using System.Text;
using System.Runtime.InteropServices;

public static class CaptureScope {
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int command);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
    delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int maxCount);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] static extern uint GetWindowLong(IntPtr hwnd, int index);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    public static uint ResolveWindow(string handle, uint selfPid) {
        IntPtr hwnd = new IntPtr(long.Parse(handle, System.Globalization.CultureInfo.InvariantCulture));
        uint owner;
        if (!IsWindow(hwnd) || GetWindowThreadProcessId(hwnd, out owner) == 0 || owner == 0) throw new InvalidOperationException("Selected window is no longer available.");
        var ownTree = NativeDucker.ProcessTree(selfPid);
        if (ownTree.Contains(owner)) throw new InvalidOperationException("The call application cannot share its own audio.");
        Process process = Process.GetProcessById((int)owner);
        if (string.Equals(process.ProcessName, "ApplicationFrameHost", StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("This hosted window does not expose a distinct application audio scope.");
        // Chromium-family audio runs in utility child processes. Ascend only to
        // a live parent with the identical executable, never Explorer/the shell.
        string path = process.MainModule.FileName;
        var parents = NativeDucker.Parents();
        uint root = owner, parent;
        while (parents.TryGetValue(root, out parent) && parent != root && parent != 0 && !ownTree.Contains(parent)) {
            try {
                Process candidate = Process.GetProcessById((int)parent);
                if (!string.Equals(candidate.MainModule.FileName, path, StringComparison.OrdinalIgnoreCase) || candidate.StartTime > process.StartTime) break;
                root = parent; process = candidate;
            } catch { break; }
        }
        return root;
    }
    public static void RestoreWindow(string handle) {
        IntPtr hwnd = new IntPtr(long.Parse(handle, System.Globalization.CultureInfo.InvariantCulture));
        if (!IsWindow(hwnd)) throw new InvalidOperationException("Selected window is no longer available.");
        ShowWindow(hwnd, 9);
        SetForegroundWindow(hwnd);
    }
    public static void PrintWindows(uint selfPid) {
        EnumWindows((hwnd, unused) => {
            uint owner; GetWindowThreadProcessId(hwnd, out owner);
            if (owner == 0 || owner == selfPid || (!IsWindowVisible(hwnd) && !IsIconic(hwnd))) return true;
            StringBuilder title = new StringBuilder(512); GetWindowText(hwnd, title, title.Capacity);
            string text = title.ToString().Trim();
            if (text.Length > 0) Console.WriteLine(hwnd.ToInt64().ToString(System.Globalization.CultureInfo.InvariantCulture) + "|" + (IsIconic(hwnd) ? "1" : "0") + "|" + text.Replace("|", " "));
            return true;
        }, IntPtr.Zero);
    }
}
