using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

// Attenuate other applications, never the call. Restore original session volumes.
public sealed class NativeDucker : IDisposable {
    sealed class Saved { public ISimpleAudioVolume Volume; public float Original, Applied; }
    readonly Dictionary<string, Saved> saved = new Dictionary<string, Saved>();
    readonly uint excludedPid;
    readonly uint includedPid;
    DateTime refresh = DateTime.MinValue;
    float lastGain = 1;
    public NativeDucker(uint pid, uint include = 0) { excludedPid = pid; includedPid = include; }
    static void Check(int result) { if (result < 0) Marshal.ThrowExceptionForHR(result); }
    static readonly Guid context = new Guid("D1A254E3-730D-4281-A695-E67DABED5C46");
    public void Apply(float gain) {
        if (gain >= 0.999f) { if (saved.Count > 0) Restore(); lastGain = 1; return; }
        if (Math.Abs(gain - lastGain) < 0.001 && DateTime.UtcNow < refresh) return;
        lastGain = gain; refresh = DateTime.UtcNow.AddMilliseconds(250);
        HashSet<uint> excluded = ProcessTree(excludedPid);
        HashSet<uint> included = includedPid == 0 ? null : ProcessTree(includedPid);
        IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)new DeviceEnumerator();
        IMMDeviceCollection devices = null;
        try {
            Check(enumerator.EnumAudioEndpoints(0, 1, out devices));
            uint count; Check(devices.GetCount(out count));
            for (uint d = 0; d < count; d++) {
                IMMDevice device = null; object managerObject = null; IAudioSessionEnumerator sessions = null;
                try {
                    Check(devices.Item(d, out device));
                    Guid managerId = typeof(IAudioSessionManager2).GUID;
                    Check(device.Activate(ref managerId, 23, IntPtr.Zero, out managerObject));
                    Check(((IAudioSessionManager2)managerObject).GetSessionEnumerator(out sessions));
                    int sessionCount; Check(sessions.GetCount(out sessionCount));
                    for (int i = 0; i < sessionCount; i++) {
                        object sessionObject = null;
                        try {
                            Check(sessions.GetSession(i, out sessionObject));
                            IAudioSessionControl2 control = (IAudioSessionControl2)sessionObject;
                            uint pid; Check(control.GetProcessId(out pid));
                            if (excluded.Contains(pid) || (included != null && !included.Contains(pid))) continue;
                            string id; Check(control.GetSessionInstanceIdentifier(out id));
                            Saved entry;
                            if (!saved.TryGetValue(id, out entry)) {
                                ISimpleAudioVolume volume = (ISimpleAudioVolume)sessionObject;
                                float original; Check(volume.GetMasterVolume(out original));
                                IntPtr unknown = Marshal.GetIUnknownForObject(volume);
                                object held;
                                try { held = Marshal.GetUniqueObjectForIUnknown(unknown); }
                                finally { Marshal.Release(unknown); }
                                entry = new Saved { Volume = (ISimpleAudioVolume)held, Original = original, Applied = original };
                                saved.Add(id, entry);
                            }
                            float current; Check(entry.Volume.GetMasterVolume(out current));
                            if (Math.Abs(current - entry.Applied) > 0.015f) entry.Original = Math.Min(1, current / Math.Max(0.05f, lastGain));
                            Guid change = context; entry.Applied = entry.Original * gain;
                            Check(entry.Volume.SetMasterVolume(entry.Applied, ref change));
                        } catch (COMException) { }
                        finally { if (sessionObject != null) Marshal.ReleaseComObject(sessionObject); }
                    }
                } catch (COMException) { }
                finally {
                    if (sessions != null) Marshal.ReleaseComObject(sessions);
                    if (managerObject != null) Marshal.ReleaseComObject(managerObject);
                    if (device != null) Marshal.ReleaseComObject(device);
                }
            }
        } finally { if (devices != null) Marshal.ReleaseComObject(devices); Marshal.ReleaseComObject(enumerator); }
    }
    public void Restore() {
        foreach (Saved entry in saved.Values) {
            try { Guid change = context; entry.Volume.SetMasterVolume(entry.Original, ref change); } catch { }
            finally { Marshal.ReleaseComObject(entry.Volume); }
        }
        saved.Clear();
    }
    public void Dispose() { Restore(); }
    public static Dictionary<uint,uint> Parents() {
        Dictionary<uint, uint> parents = new Dictionary<uint, uint>();
        IntPtr snapshot = CreateToolhelp32Snapshot(2, 0);
        if (snapshot == new IntPtr(-1)) throw new InvalidOperationException("Cannot enumerate audio process tree.");
        try {
            ProcessEntry entry = new ProcessEntry(); entry.Size = (uint)Marshal.SizeOf(typeof(ProcessEntry));
            if (Process32First(snapshot, ref entry)) do { parents[entry.Pid] = entry.Parent; } while (Process32Next(snapshot, ref entry));
        } finally { CloseHandle(snapshot); }
        return parents;
    }
    public static HashSet<uint> ProcessTree(uint root) {
        var parents = Parents();
        HashSet<uint> result = new HashSet<uint>(); result.Add(root);
        bool changed;
        do { changed = false; foreach (KeyValuePair<uint,uint> pair in parents) if (result.Contains(pair.Value) && result.Add(pair.Key)) changed = true; } while (changed);
        return result;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct ProcessEntry { public uint Size, Usage, Pid; public IntPtr Heap; public uint Module, Threads, Parent; public int Priority; public uint Flags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string Exe; }
    [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", EntryPoint = "Process32FirstW", CharSet = CharSet.Unicode)] static extern bool Process32First(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", EntryPoint = "Process32NextW", CharSet = CharSet.Unicode)] static extern bool Process32Next(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
}
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] public class DeviceEnumerator { }
[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDeviceEnumerator { [PreserveSig] int EnumAudioEndpoints(int flow, uint mask, out IMMDeviceCollection devices); }
[ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDeviceCollection { [PreserveSig] int GetCount(out uint count); [PreserveSig] int Item(uint index, out IMMDevice device); }
[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDevice { [PreserveSig] int Activate(ref Guid iid, uint context, IntPtr parameters, [MarshalAs(UnmanagedType.IUnknown)] out object result); }
[ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioSessionManager2 {
    [PreserveSig] int GetAudioSessionControl(IntPtr guid, uint flags, out IntPtr control);
    [PreserveSig] int GetSimpleAudioVolume(IntPtr guid, uint flags, out IntPtr volume);
    [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator enumerator);
}
[ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioSessionEnumerator { [PreserveSig] int GetCount(out int count); [PreserveSig] int GetSession(int index, [MarshalAs(UnmanagedType.IUnknown)] out object control); }
[ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioSessionControl2 {
    [PreserveSig] int GetState(out int state);
    [PreserveSig] int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    [PreserveSig] int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string name, ref Guid context);
    [PreserveSig] int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string path);
    [PreserveSig] int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string path, ref Guid context);
    [PreserveSig] int GetGroupingParam(out Guid grouping);
    [PreserveSig] int SetGroupingParam(ref Guid grouping, ref Guid context);
    [PreserveSig] int RegisterAudioSessionNotification(IntPtr listener);
    [PreserveSig] int UnregisterAudioSessionNotification(IntPtr listener);
    [PreserveSig] int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
    [PreserveSig] int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
    [PreserveSig] int GetProcessId(out uint pid);
    [PreserveSig] int IsSystemSoundsSession();
    [PreserveSig] int SetDuckingPreference([MarshalAs(UnmanagedType.Bool)] bool optOut);
}
[ComImport, Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface ISimpleAudioVolume {
    [PreserveSig] int SetMasterVolume(float volume, ref Guid context);
    [PreserveSig] int GetMasterVolume(out float volume);
    [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid context);
    [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
}
