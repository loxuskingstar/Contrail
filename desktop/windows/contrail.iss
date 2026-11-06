; Installeur Windows de Contrail (Inno Setup 6) : iscc /DAppVersion=2.2.0 /DSourceDir=..\..\dist\Contrail desktop\windows\contrail.iss
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef SourceDir
  #define SourceDir "..\..\dist\Contrail"
#endif

[Setup]
AppId={{6F1D0B52-6B0E-4E3A-9C55-3B1B6E0C7A11}
AppName=Contrail
AppVersion={#AppVersion}
AppPublisher=Contrail
VersionInfoVersion={#AppVersion}
; Dossier d'installation : proposé, modifiable à l'étape « Dossier de destination »
DefaultDirName={autopf}\Contrail
DisableDirPage=no
DefaultGroupName=Contrail
DisableProgramGroupPage=yes
; Sans droits administrateur par défaut (installation pour l'utilisateur) ; l'assistant propose « pour tous les utilisateurs »
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
OutputDir=..\..\dist
OutputBaseFilename=Contrail-{#AppVersion}-Windows-Setup
SetupIconFile=..\assets\icon.ico
UninstallDisplayIcon={app}\Contrail.exe
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesInstallIn64BitMode=x64compatible
CloseApplications=force
RestartApplications=no

[Languages]
Name: "french"; MessagesFile: "compiler:Languages\French.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"
Name: "autostart"; Description: "Démarrer Contrail avec Windows"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autodesktop}\Contrail"; Filename: "{app}\Contrail.exe"; Tasks: desktopicon
Name: "{autoprograms}\Contrail"; Filename: "{app}\Contrail.exe"
Name: "{autoprograms}\Contrail (accès depuis le téléphone)"; Filename: "{app}\Contrail.exe"; Parameters: "--lan"
Name: "{autoprograms}\Contrail (diagnostic)"; Filename: "{cmd}"; Parameters: "/k """"{app}\Contrail.exe"" --console"""; WorkingDir: "{app}"
Name: "{userstartup}\Contrail"; Filename: "{app}\Contrail.exe"; Parameters: "--no-browser"; Tasks: autostart

[Run]
Filename: "{app}\Contrail.exe"; Description: "Lancer Contrail"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "{app}\Contrail.exe"; Parameters: "--stop --no-browser"; Flags: runhidden skipifdoesntexist; RunOnceId: "StopContrail"

[Code]
// La désinstallation conserve les données (spots, photos) sauf demande explicite.
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DataDir: String;
begin
  if CurUninstallStep = usPostUninstall then
  begin
    DataDir := ExpandConstant('{userappdata}\Contrail');
    if DirExists(DataDir) then
      if MsgBox('Supprimer aussi vos données Contrail (spots, photos, sauvegardes) ?' + #13#10 + DataDir + #13#10#13#10 +
                'Choisissez « Non » pour les conserver (recommandé).', mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
        DelTree(DataDir, True, True, True);
  end;
end;
