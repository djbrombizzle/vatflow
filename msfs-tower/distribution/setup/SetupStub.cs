// VATFLOW Tower Cab - the program inside VATFLOW-TowerCab-Setup.exe. make-community-zip.ps1
// compiles it with Windows' own .NET Framework compiler (Add-Type) and appends the payload:
//   [this program][payload.zip][payload length: 8 bytes][VTCSETUP]
// The payload zip holds setup.ps1, install-maps-package.ps1 and the two package zips. The
// program unpacks it to a temp folder, runs setup.ps1 in this console window, then cleans up.
using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Text;

public static class VatflowSetup
{
    const string Magic = "VTCSETUP";

    public static int Main()
    {
        string dir = Path.Combine(Path.GetTempPath(), "vatflow-setup-" + Guid.NewGuid().ToString("N").Substring(0, 8));
        try
        {
            Console.Title = "VATFLOW Tower Cab setup";
            Console.WriteLine("Unpacking...");
            string self = System.Reflection.Assembly.GetExecutingAssembly().Location;
            string x = Path.Combine(dir, "x");
            Directory.CreateDirectory(dir);
            string zip = Path.Combine(dir, "payload.zip");
            using (FileStream fs = new FileStream(self, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                byte[] tail = new byte[16];
                fs.Seek(-16, SeekOrigin.End);
                ReadAll(fs, tail, 16);
                if (Encoding.ASCII.GetString(tail, 8, 8) != Magic) throw new Exception("this setup file is damaged (no payload). Download it again.");
                long len = BitConverter.ToInt64(tail, 0);
                if (len <= 0 || len > fs.Length - 16) throw new Exception("this setup file is damaged (bad payload size). Download it again.");
                fs.Seek(-16 - len, SeekOrigin.End);
                using (FileStream o = File.Create(zip))
                {
                    byte[] buf = new byte[1 << 20];
                    long left = len;
                    while (left > 0)
                    {
                        int n = fs.Read(buf, 0, (int)Math.Min(buf.Length, left));
                        if (n <= 0) throw new Exception("this setup file is cut short. Download it again.");
                        o.Write(buf, 0, n);
                        left -= n;
                    }
                }
            }
            ZipFile.ExtractToDirectory(zip, x);
            File.Delete(zip);

            ProcessStartInfo psi = new ProcessStartInfo("powershell.exe",
                "-NoProfile -ExecutionPolicy Bypass -File \"" + Path.Combine(x, "setup.ps1") + "\"");
            psi.UseShellExecute = false;   // same console window
            psi.WorkingDirectory = x;
            using (Process p = Process.Start(psi))
            {
                p.WaitForExit();
                return p.ExitCode;
            }
        }
        catch (Exception e)
        {
            Console.WriteLine();
            Console.WriteLine("ERROR: " + e.Message);
            Console.WriteLine("Press Enter to close");
            Console.ReadLine();
            return 1;
        }
        finally
        {
            try { if (Directory.Exists(dir)) Directory.Delete(dir, true); } catch { }
        }
    }

    static void ReadAll(Stream s, byte[] b, int count)
    {
        int got = 0;
        while (got < count)
        {
            int n = s.Read(b, got, count - got);
            if (n <= 0) throw new Exception("this setup file is cut short. Download it again.");
            got += n;
        }
    }
}
