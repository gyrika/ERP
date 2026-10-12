# Sends a file's bytes to a Windows printer queue unchanged (datatype RAW), so the
# ESC/POS commands reach the Xprinter as they are, through its normal Windows driver.
# Called by server/printer.ts:  rawprint.ps1 -Printer "XP-80T" -Path receipt.bin
param(
  [Parameter(Mandatory = $true)][string]$Printer,
  [Parameter(Mandatory = $true)][string]$Path
)
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class RawPrint {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DOCINFO {
    [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
  }
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool OpenPrinter(string name, out IntPtr handle, IntPtr defaults);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool ClosePrinter(IntPtr handle);
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern int StartDocPrinter(IntPtr handle, int level, [In] DOCINFO doc);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool EndDocPrinter(IntPtr handle);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool StartPagePrinter(IntPtr handle);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool EndPagePrinter(IntPtr handle);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool WritePrinter(IntPtr handle, byte[] bytes, int count, out int written);

  public static void Send(string printer, byte[] bytes) {
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero))
      throw new Exception("Printer not found: " + printer + " (error " + Marshal.GetLastWin32Error() + ")");
    try {
      var doc = new DOCINFO { pDocName = "CheesyBeez receipt", pDataType = "RAW" };
      if (StartDocPrinter(h, 1, doc) == 0) throw new Exception("StartDocPrinter error " + Marshal.GetLastWin32Error());
      try {
        if (!StartPagePrinter(h)) throw new Exception("StartPagePrinter error " + Marshal.GetLastWin32Error());
        int written;
        bool ok = WritePrinter(h, bytes, bytes.Length, out written);
        EndPagePrinter(h);
        if (!ok || written != bytes.Length) throw new Exception("WritePrinter wrote " + written + " of " + bytes.Length + " bytes");
      } finally { EndDocPrinter(h); }
    } finally { ClosePrinter(h); }
  }
}
"@

[RawPrint]::Send($Printer, [System.IO.File]::ReadAllBytes($Path))
