// CLG Search launcher — compiled to "CLG Search.exe" by build-dist.mjs (csc.exe).
//
// Intentionally tiny: it only finds Node and runs runtime/launch.cjs, which does
// the real orchestration. No product logic lives here. Standalone .NET Framework
// exe (no external dependencies) so it runs on any modern Windows.
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;

class Launcher
{
    static int Main(string[] args)
    {
        Console.Title = "CLG Search";
        string baseDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        string runtime = Path.Combine(baseDir, "runtime");
        string launch = Path.Combine(runtime, "launch.cjs");

        // Prefer the bundled portable node; fall back to node on PATH.
        string portableNode = Path.Combine(runtime, "node", "node.exe");
        string node = File.Exists(portableNode) ? portableNode : "node";

        if (!File.Exists(launch))
        {
            Console.Error.WriteLine("Installation looks incomplete: runtime\\launch.cjs not found.");
            Console.Error.WriteLine("Please reinstall CLG Search.");
            Pause();
            return 1;
        }

        var psi = new ProcessStartInfo
        {
            FileName = node,
            Arguments = "\"" + launch + "\"",
            WorkingDirectory = runtime,
            UseShellExecute = false,
        };

        try
        {
            var p = Process.Start(psi);
            p.WaitForExit();
            return p.ExitCode;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("Could not start CLG Search: " + ex.Message);
            if (node == "node")
                Console.Error.WriteLine("Node.js runtime was not found. Reinstall CLG Search (the installer bundles it).");
            Pause();
            return 1;
        }
    }

    static void Pause()
    {
        Console.Error.WriteLine("\nPress any key to close…");
        try { Console.ReadKey(); } catch { System.Threading.Thread.Sleep(30000); }
    }
}
