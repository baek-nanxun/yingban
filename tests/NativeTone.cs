using System;
using System.IO;
using System.Runtime.InteropServices;
public static class NativeTone {
    [DllImport("winmm.dll")] static extern bool PlaySound(byte[] data, IntPtr module, uint flags);
    public static void Main(string[] args) {
        byte[] wav;
        using (MemoryStream stream = new MemoryStream()) {
            using (BinaryWriter writer = new BinaryWriter(stream)) {
                int samples = 48000 * (args.Length > 0 ? int.Parse(args[0]) : 6);
                writer.Write(System.Text.Encoding.ASCII.GetBytes("RIFF")); writer.Write(36 + samples * 2);
                writer.Write(System.Text.Encoding.ASCII.GetBytes("WAVEfmt ")); writer.Write(16); writer.Write((short)1); writer.Write((short)1);
                writer.Write(48000); writer.Write(96000); writer.Write((short)2); writer.Write((short)16);
                writer.Write(System.Text.Encoding.ASCII.GetBytes("data")); writer.Write(samples * 2);
                int frequency = args.Length > 1 ? int.Parse(args[1]) : 697;
                for (int i = 0; i < samples; i++) writer.Write((short)(Math.Sin(i * 2 * Math.PI * frequency / 48000) * 32767 * 0.012));
                wav = stream.ToArray();
            }
        }
        Console.Error.WriteLine("READY"); Console.In.ReadLine();
        if (!PlaySound(wav, IntPtr.Zero, 6)) Environment.Exit(2);
    }
}
