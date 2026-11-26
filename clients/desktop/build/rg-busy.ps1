# Run by the installer (build/installer.nsh rgFindBusy) when the old version's uninstaller failed: the first file of the
# install folder that another program holds open without delete sharing - what keeps the uninstaller from moving it
# away - and the programs holding it (Windows' Restart Manager). One line, no line break: "resources\app.asar (in use by
# pwsh.exe 1234)".
param([string]$Dir)
$ErrorActionPreference = 'SilentlyContinue'
$busy = $null
foreach ($f in Get-ChildItem -LiteralPath $Dir -Recurse -File -Force) {
  try {
    (New-Object IO.FileStream($f.FullName, [IO.FileMode]::Open, [Security.AccessControl.FileSystemRights]::Delete, [IO.FileShare]'ReadWrite, Delete', 4096, [IO.FileOptions]::None)).Dispose()
  } catch {
    $busy = $f.FullName
    break
  }
}
if (-not $busy) { [Console]::Out.Write('no file in use now'); exit 0 }
$rel = $busy.Substring($Dir.TrimEnd('\').Length + 1)
$by = ''
try {
  Add-Type -TypeDefinition @'
using System; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class RgRm {
  [StructLayout(LayoutKind.Sequential)] struct UniqueProcess { public int Pid; public System.Runtime.InteropServices.ComTypes.FILETIME Start; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct ProcessInfo {
    public UniqueProcess Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string AppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string ServiceName;
    public int AppType; public uint AppStatus; public uint Session; [MarshalAs(UnmanagedType.Bool)] public bool Restartable;
  }
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmStartSession(out uint h, int flags, string key);
  [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint h);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmRegisterResources(uint h, uint nFiles, string[] files, uint nApps, IntPtr apps, uint nServices, string[] services);
  [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint h, out uint needed, ref uint n, [In, Out] ProcessInfo[] info, ref uint reasons);
  public static string Holders(string path) {
    uint h;
    if (RmStartSession(out h, 0, Guid.NewGuid().ToString()) != 0) return "";
    try {
      if (RmRegisterResources(h, 1, new[] { path }, 0, IntPtr.Zero, 0, null) != 0) return "";
      uint needed, n = 0, reasons = 0;
      if (RmGetList(h, out needed, ref n, null, ref reasons) != 234 || needed == 0) return "";
      var info = new ProcessInfo[needed];
      n = needed;
      if (RmGetList(h, out needed, ref n, info, ref reasons) != 0) return "";
      var names = new List<string>();
      for (int i = 0; i < n; i++) {
        string exe = "";
        try { exe = System.Diagnostics.Process.GetProcessById(info[i].Process.Pid).ProcessName + ".exe"; } catch { }
        names.Add((exe != "" ? exe : info[i].AppName) + " " + info[i].Process.Pid);
      }
      return string.Join(", ", names);
    } finally { RmEndSession(h); }
  }
}
'@
  $by = [RgRm]::Holders($busy)
} catch { }
[Console]::Out.Write($(if ($by) { "$rel (in use by $by)" } else { "$rel (in use by another program)" }))
