// Process loopback is documented by Microsoft's ApplicationLoopback sample.
// x64 .NET Framework; no virtual audio driver or endpoint rerouting.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

[ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IActivateOperation {
    [PreserveSig] int GetActivateResult(out int result, [MarshalAs(UnmanagedType.IUnknown)] out object audio);
}
[Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown), ComVisible(true)]
public interface IActivateHandler { [PreserveSig] int ActivateCompleted(IActivateOperation operation); }
[Guid("94EA2B94-E9CC-49E0-C0FF-EE64CA8F5B90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown), ComVisible(true)]
public interface IAgileObject { }

[StructLayout(LayoutKind.Sequential, Pack = 2)]
public struct WaveFormat {
    public ushort Tag, Channels;
    public uint Rate, BytesPerSecond;
    public ushort BlockAlign, Bits, Extra;
}
[StructLayout(LayoutKind.Explicit, Size = 24)]
public struct PropVariant {
    [FieldOffset(0)] public ushort Type;
    [FieldOffset(8)] public uint BlobSize;
    [FieldOffset(16)] public IntPtr Blob;
}
[ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioClient {
    [PreserveSig] int Initialize(int mode, uint flags, long duration, long periodicity, ref WaveFormat format, IntPtr session);
    [PreserveSig] int GetBufferSize(out uint frames);
    [PreserveSig] int GetStreamLatency(out long latency);
    [PreserveSig] int GetCurrentPadding(out uint frames);
    [PreserveSig] int IsFormatSupported(int mode, IntPtr format, out IntPtr closest);
    [PreserveSig] int GetMixFormat(out IntPtr format);
    [PreserveSig] int GetDevicePeriod(out long normal, out long minimum);
    [PreserveSig] int Start();
    [PreserveSig] int Stop();
    [PreserveSig] int Reset();
    [PreserveSig] int SetEventHandle(IntPtr handle);
    [PreserveSig] int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
}
[ComImport, Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioCaptureClient {
    [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong qpcPosition);
    [PreserveSig] int ReleaseBuffer(uint frames);
    [PreserveSig] int GetNextPacketSize(out uint frames);
}
[ComVisible(true), ClassInterface(ClassInterfaceType.None)]
public sealed class Completion : IActivateHandler, IAgileObject {
    public readonly ManualResetEvent Done = new ManualResetEvent(false);
    public IAudioClient Client;
    public int Result;
    public int ActivateCompleted(IActivateOperation operation) {
        try {
            object audio;
            int hr = operation.GetActivateResult(out Result, out audio);
            if (hr < 0) Result = hr;
            if (Result >= 0) Client = (IAudioClient)audio;
        } catch (Exception e) { Result = Marshal.GetHRForException(e); }
        finally { Done.Set(); }
        return 0;
    }
}
public static class Program {
    [DllImport("Mmdevapi.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    static extern int ActivateAudioInterfaceAsync(string path, ref Guid iid, ref PropVariant parameters, IActivateHandler handler, out IActivateOperation operation);
    static volatile bool running = true;
    static volatile float requestedGain = 1;
    static void Check(int hr) { if (hr < 0) Marshal.ThrowExceptionForHR(hr); }
    [MTAThread]
    public static int Main(string[] args) {
        IAudioClient client = null;
        IAudioCaptureClient capture = null;
        IntPtr parameters = IntPtr.Zero;
        NativeDucker ducker = null;
        try {
            if (args.Length == 3 && args[0] == "--window-pid") {
                Console.Out.WriteLine(CaptureScope.ResolveWindow(args[1], uint.Parse(args[2])));
                return 0;
            }
            if (args.Length == 2 && args[0] == "--restore-window") {
                CaptureScope.RestoreWindow(args[1]);
                return 0;
            }
            if (args.Length == 2 && args[0] == "--list-windows") {
                CaptureScope.PrintWindows(uint.Parse(args[1]));
                return 0;
            }
            if (args.Length < 1) throw new ArgumentException("Usage: YingBan.Audio.exe <excluded-process-id> [duration-ms]");
            int pid = int.Parse(args[0]);
            int duration = args.Length > 1 ? int.Parse(args[1]) : 0;
            int includedPid = args.Length > 2 ? int.Parse(args[2]) : 0;
            System.Diagnostics.Process includedProcess = includedPid > 0 ? System.Diagnostics.Process.GetProcessById(includedPid) : null;
            if (includedPid > 0 && NativeDucker.ProcessTree((uint)pid).Contains((uint)includedPid)) throw new InvalidOperationException("Cannot include the call application.");
            ducker = new NativeDucker((uint)pid, (uint)includedPid);
            // Mode 0 includes only the selected application tree; mode 1 excludes
            // our complete call tree for full-screen audio. No fallback to all.
            parameters = Marshal.AllocHGlobal(12);
            Marshal.Copy(new int[] { 1, includedPid > 0 ? includedPid : pid, includedPid > 0 ? 0 : 1 }, 0, parameters, 3);
            PropVariant variant = new PropVariant { Type = 65, BlobSize = 12, Blob = parameters };
            Completion handler = new Completion();
            IActivateOperation operation;
            Guid iid = typeof(IAudioClient).GUID;
            Check(ActivateAudioInterfaceAsync("VAD\\Process_Loopback", ref iid, ref variant, handler, out operation));
            if (!handler.Done.WaitOne(10000)) throw new TimeoutException("Audio interface activation timed out.");
            Check(handler.Result);
            client = handler.Client;
            WaveFormat format = new WaveFormat { Tag = 1, Channels = 2, Rate = 48000, BytesPerSecond = 192000, BlockAlign = 4, Bits = 16, Extra = 0 };
            using (AutoResetEvent ready = new AutoResetEvent(false)) {
                // Shared, loopback, event callback, automatic PCM conversion.
                Check(client.Initialize(0, 0x80020000u | 0x00040000u, 0, 0, ref format, IntPtr.Zero));
                Guid captureId = typeof(IAudioCaptureClient).GUID;
                object service;
                Check(client.GetService(ref captureId, out service));
                capture = (IAudioCaptureClient)service;
                Check(client.SetEventHandle(ready.SafeWaitHandle.DangerousGetHandle()));
                Console.CancelKeyPress += delegate(object sender, ConsoleCancelEventArgs e) { e.Cancel = true; running = false; };
                {
                    Thread stopThread = new Thread(delegate() {
                        try {
                            string line;
                            while ((line = Console.In.ReadLine()) != null) {
                                if (line.StartsWith("DUCK ")) {
                                    float gain;
                                    if (float.TryParse(line.Substring(5), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out gain)) requestedGain = Math.Max(0.05f, Math.Min(1, gain));
                                } else { running = false; return; }
                            }
                        } catch { }
                        if (duration == 0) running = false;
                    });
                    stopThread.IsBackground = true;
                    stopThread.Start();
                }
                Stream output = Console.OpenStandardOutput();
                Check(client.Start());
                Console.Error.WriteLine("READY 48000 2 s16le");
                DateTime end = duration > 0 ? DateTime.UtcNow.AddMilliseconds(duration) : DateTime.MaxValue;
                byte[] buffer = new byte[192000];
                float acknowledgedGain = 1;
                while (running && DateTime.UtcNow < end) {
                    ready.WaitOne(100);
                    if (includedProcess != null && includedProcess.HasExited) throw new InvalidOperationException("Selected application exited.");
                    float currentGain = requestedGain;
                    ducker.Apply(currentGain);
                    if (Math.Abs(currentGain - acknowledgedGain) > 0.0001f) {
                        acknowledgedGain = currentGain;
                        Console.Error.WriteLine("DUCKED " + currentGain.ToString(System.Globalization.CultureInfo.InvariantCulture));
                    }
                    uint available;
                    Check(capture.GetNextPacketSize(out available));
                    while (available > 0) {
                        IntPtr data;
                        uint frames, flags;
                        ulong device, qpc;
                        Check(capture.GetBuffer(out data, out frames, out flags, out device, out qpc));
                        try {
                            int bytes = checked((int)frames * 4);
                            if (buffer.Length < bytes) buffer = new byte[bytes];
                            if ((flags & 2u) != 0) Array.Clear(buffer, 0, bytes);
                            else Marshal.Copy(data, buffer, 0, bytes);
                            output.Write(buffer, 0, bytes);
                        } finally { Check(capture.ReleaseBuffer(frames)); }
                        Check(capture.GetNextPacketSize(out available));
                    }
                    output.Flush();
                }
                client.Stop();
                GC.KeepAlive(handler);
                GC.KeepAlive(operation);
            }
            return 0;
        } catch (Exception e) {
            Console.Error.WriteLine("ERROR 0x" + Marshal.GetHRForException(e).ToString("X8") + " " + e.Message);
            return 1;
        } finally {
            if (ducker != null) ducker.Dispose();
            if (client != null) { try { client.Stop(); } catch { } }
            if (capture != null) Marshal.ReleaseComObject(capture);
            if (client != null) Marshal.ReleaseComObject(client);
            if (parameters != IntPtr.Zero) Marshal.FreeHGlobal(parameters);
        }
    }
}
