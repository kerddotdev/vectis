import { VectisError } from "../../protocol/src/index.js";

function xml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
function component(name: string, contents: string) {
  return `<component name="${name}" processorArchitecture="arm64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">${contents}</component>`;
}

const bootstrap = `$ErrorActionPreference='Stop'; $media=@(Get-Volume | Where-Object FileSystemLabel -eq 'VECTIS_SETUP'); if($media.Count -ne 1){throw 'Setup media unavailable'}; & ($media[0].DriveLetter + ':\\prepare.ps1')`;
export const windowsBootstrapCommand = `powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${Buffer.from(bootstrap, "utf16le").toString("base64")}`;

export function windowsSeed(input: {
  id: string;
  password: string;
  imageName: string;
  acceptLicense: boolean;
}) {
  if (!input.acceptLicense)
    throw new VectisError(
      "license_acceptance_required",
      "Confirm the Windows license terms before preparing installation media.",
    );
  if (
    !/^[a-zA-Z0-9-]{1,80}$/.test(input.id) ||
    !/^[\x20-\x7e]{20,128}$/.test(input.password) ||
    !/^[\x20-\x7e]{1,100}$/.test(input.imageName)
  )
    throw new VectisError(
      "invalid_setup_identity",
      "Expected a generated setup ID, strong local password and Windows image name.",
    );
  const password = `<Password><Value>${xml(input.password)}</Value><PlainText>true</PlainText></Password>`;
  const language =
    "<InputLocale>en-US</InputLocale><SystemLocale>en-US</SystemLocale><UILanguage>en-US</UILanguage><UserLocale>en-US</UserLocale>";
  const answer = `<?xml version="1.0" encoding="utf-8"?>
<unattend xmlns="urn:schemas-microsoft-com:unattend" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State">
<settings pass="windowsPE">
${component("Microsoft-Windows-International-Core-WinPE", `<SetupUILanguage><UILanguage>en-US</UILanguage></SetupUILanguage>${language}`)}
${component("Microsoft-Windows-Setup", `<DiskConfiguration><Disk wcm:action="add"><DiskID>0</DiskID><WillWipeDisk>true</WillWipeDisk><CreatePartitions><CreatePartition wcm:action="add"><Order>1</Order><Type>EFI</Type><Size>260</Size></CreatePartition><CreatePartition wcm:action="add"><Order>2</Order><Type>MSR</Type><Size>16</Size></CreatePartition><CreatePartition wcm:action="add"><Order>3</Order><Type>Primary</Type><Extend>true</Extend></CreatePartition></CreatePartitions><ModifyPartitions><ModifyPartition wcm:action="add"><Order>1</Order><PartitionID>1</PartitionID><Format>FAT32</Format><Label>System</Label></ModifyPartition><ModifyPartition wcm:action="add"><Order>2</Order><PartitionID>3</PartitionID><Format>NTFS</Format><Label>Windows</Label><Letter>C</Letter></ModifyPartition></ModifyPartitions></Disk><WillShowUI>OnError</WillShowUI></DiskConfiguration><ImageInstall><OSImage><InstallFrom><MetaData wcm:action="add"><Key>/IMAGE/NAME</Key><Value>${xml(input.imageName)}</Value></MetaData></InstallFrom><InstallTo><DiskID>0</DiskID><PartitionID>3</PartitionID></InstallTo><WillShowUI>OnError</WillShowUI></OSImage></ImageInstall><UserData><AcceptEula>true</AcceptEula><FullName>Vectis</FullName><ProductKey><WillShowUI>Never</WillShowUI></ProductKey></UserData>`)}
${component("Microsoft-Windows-PnpCustomizationsWinPE", '<DriverPaths><PathAndCredentials wcm:action="add" wcm:keyValue="1"><Path>E:\\NetKVM\\w11\\ARM64</Path></PathAndCredentials></DriverPaths>')}
</settings>
<settings pass="specialize">${component("Microsoft-Windows-Shell-Setup", "<ComputerName>VECTIS-CI</ComputerName><TimeZone>UTC</TimeZone>")}</settings>
<settings pass="oobeSystem">
${component("Microsoft-Windows-International-Core", language)}
${component("Microsoft-Windows-Shell-Setup", `<OOBE><HideEULAPage>true</HideEULAPage><HideOnlineAccountScreens>true</HideOnlineAccountScreens><HideWirelessSetupInOOBE>true</HideWirelessSetupInOOBE><ProtectYourPC>3</ProtectYourPC></OOBE><UserAccounts><LocalAccounts><LocalAccount wcm:action="add">${password}<Name>vectis</Name><DisplayName>Vectis CI</DisplayName><Group>Administrators</Group></LocalAccount></LocalAccounts></UserAccounts><AutoLogon>${password}<Enabled>true</Enabled><LogonCount>1</LogonCount><Username>vectis</Username></AutoLogon><FirstLogonCommands><SynchronousCommand wcm:action="add"><Order>1</Order><Description>Prepare the Vectis guest</Description><CommandLine>${windowsBootstrapCommand}</CommandLine></SynchronousCommand></FirstLogonCommands>`)}
</settings></unattend>
`;
  const script = String.raw`$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = 'C:\ProgramData\Vectis'
New-Item -ItemType Directory -Force $root | Out-Null
$winlogon = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
Set-ItemProperty $winlogon AutoLogonCount 0 -Type DWord
Set-ItemProperty $winlogon AutoAdminLogon '0'
Remove-ItemProperty $winlogon DefaultPassword -ErrorAction SilentlyContinue
try {
  if ($env:PROCESSOR_ARCHITECTURE -ne 'ARM64') { throw 'ARM64 Windows is required' }
  Set-TimeZone -Id UTC
  Set-Service w32time -StartupType Automatic
  Start-Service w32time
  Set-LocalUser -Name vectis -PasswordNeverExpires $true
  Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0 | Out-Null
  $ssh = 'C:\ProgramData\ssh'
  New-Item -ItemType Directory -Force $ssh | Out-Null
  foreach ($file in @('administrators_authorized_keys', 'ssh_host_ed25519_key', 'ssh_host_ed25519_key.pub')) {
    Copy-Item (Join-Path $PSScriptRoot $file) (Join-Path $ssh $file) -Force
    & icacls.exe (Join-Path $ssh $file) /inheritance:r /grant '*S-1-5-32-544:F' /grant '*S-1-5-18:F' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'SSH file protection failed' }
  }
  @'
Port 22
HostKey __PROGRAMDATA__/ssh/ssh_host_ed25519_key
PubkeyAuthentication yes
PasswordAuthentication no
AllowUsers vectis
AuthorizedKeysFile __PROGRAMDATA__/ssh/administrators_authorized_keys
Subsystem sftp sftp-server.exe
'@ | Set-Content (Join-Path $ssh 'sshd_config') -Encoding ascii
  & C:\Windows\System32\OpenSSH\sshd.exe -t
  if ($LASTEXITCODE -ne 0) { throw 'SSH configuration is invalid' }
  if (!(Get-NetFirewallRule -Name OpenSSH-Server-In-TCP -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -Name OpenSSH-Server-In-TCP -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 | Out-Null
  }
  Set-NetFirewallRule -Name OpenSSH-Server-In-TCP -Enabled True -Profile Any -RemoteAddress 10.0.2.2
  Set-Service sshd -StartupType Automatic
  Start-Service sshd
  Set-ExecutionPolicy -Scope Process RemoteSigned -Force
  Set-ExecutionPolicy -Scope CurrentUser RemoteSigned -Force
  Get-ComputerInfo -Property WindowsProductName,WindowsVersion,OsBuildNumber | ConvertTo-Json | Set-Content (Join-Path $root 'toolchain.json')
  Remove-Item C:\Windows\Panther\unattend.xml,C:\Windows\Panther\Unattend\unattend.xml,C:\Windows\System32\Sysprep\unattend.xml -Force -ErrorAction SilentlyContinue
  Remove-Item (Join-Path $root 'failed') -Force -ErrorAction SilentlyContinue
  'SETUP_ID' | Set-Content (Join-Path $root 'prepared') -Encoding ascii
} catch {
  'Guest preparation failed. Inspect Windows setup and service diagnostics.' | Set-Content (Join-Path $root 'failed')
  exit 1
}
`;
  return { answer, script: script.replace("SETUP_ID", input.id) };
}
