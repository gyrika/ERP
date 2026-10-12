; CheesyBeez Station: one Setup.exe that puts the whole POS on a shop PC.
; Built by GitHub (.github/workflows/station.yml) from deploy/station/stage/ (see stage.ps1):
;   iscc /DAppVersion=1.2.3 CheesyBeez.iss
; Everything it needs is inside: its own Node.js, the POS, the built-in database. The shop's
; data lives in C:\ProgramData\CheesyBeez and is never touched by an update or an uninstall.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

[Setup]
AppId={{6B8E2C14-5A7D-4F39-9C21-CB3E5A1F0D42}
AppName=CheesyBeez Station
AppVersion={#AppVersion}
AppVerName=CheesyBeez Station {#AppVersion}
AppPublisher=CheesyBeez POS team
AppPublisherURL=https://github.com/gyrika/ERP
DefaultDirName={autopf}\CheesyBeez Station
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
WizardStyle=modern
OutputDir=Output
OutputBaseFilename=CheesyBeez-Setup-{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
UninstallDisplayName=CheesyBeez Station
CloseApplications=no

[Messages]
WelcomeLabel1=Welcome to CheesyBeez
WelcomeLabel2=This puts the CheesyBeez POS on this computer: the counter, the kitchen screen and everything they need.%n%nIt takes about a minute. Then the POS opens and asks a few questions about your shop.
FinishedHeadingLabel=CheesyBeez is ready
FinishedLabel=The POS starts by itself whenever this computer starts.

[Dirs]
Name: "{commonappdata}\CheesyBeez"

[Files]
Source: "stage\node\node.exe"; DestDir: "{app}\node"; Flags: ignoreversion
Source: "stage\app\*"; DestDir: "{app}\app"; Flags: ignoreversion recursesubdirs createallsubdirs
; The counter app is usually running during an update, which locks its files: those are replaced at the
; next restart (restartreplace). The POS screens come from the server, so they update at once anyway.
Source: "stage\pos-app\*"; DestDir: "{app}\pos-app"; Flags: ignoreversion recursesubdirs createallsubdirs restartreplace
Source: "station.cmd"; DestDir: "{app}"; Flags: ignoreversion
Source: "station-install.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "station-uninstall.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "station-update.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "stage\version.txt"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
; The counter's app (a real Windows program, not a browser): its own icon, full screen.
Name: "{commondesktop}\CheesyBeez POS"; Filename: "{app}\pos-app\CheesyBeezPOS.exe"; WorkingDir: "{app}\pos-app"
Name: "{autoprograms}\CheesyBeez POS"; Filename: "{app}\pos-app\CheesyBeezPOS.exe"; WorkingDir: "{app}\pos-app"
; Whoever logs in to Windows at the counter gets the POS.
Name: "{commonstartup}\CheesyBeez POS"; Filename: "{app}\pos-app\CheesyBeezPOS.exe"; WorkingDir: "{app}\pos-app"

[Run]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\station-install.ps1"""; Flags: runhidden waituntilterminated; StatusMsg: "Starting CheesyBeez..."
Filename: "{app}\pos-app\CheesyBeezPOS.exe"; Description: "Open CheesyBeez now"; Flags: postinstall nowait skipifsilent

[UninstallRun]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\station-uninstall.ps1"""; Flags: runhidden waituntilterminated; RunOnceId: "StopStation"

[Code]
// Before files are replaced (an update): stop the running server, so nothing is locked.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Code: Integer;
begin
  Exec(ExpandConstant('{sys}\schtasks.exe'), '/End /TN "CheesyBeez Station"', '', SW_HIDE, ewWaitUntilTerminated, Code);
  Exec('powershell.exe', '-NoProfile -Command "Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like ''' +
    ExpandConstant('{app}') + '*'' } | Stop-Process -Force"', '', SW_HIDE, ewWaitUntilTerminated, Code);
  Result := '';
end;
