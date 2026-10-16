interface DefenderCommand {
  readonly shell: "cmd";
  readonly script: string;
  readonly allowFailure: boolean;
}

// Defender-changing PowerShell cmdlets can be blocked by AMSI even in isolated commands.
export function windowsDefenderCommands(): readonly DefenderCommand[] {
  const policy = String.raw`HKLM\SOFTWARE\Policies\Microsoft\Windows Defender`;
  const policies = [
    [policy, "DisableAntiSpyware", 1],
    ...[
      "DisableRealtimeMonitoring",
      "DisableBehaviorMonitoring",
      "DisableIOAVProtection",
      "DisableScriptScanning",
      "DisableOnAccessProtection",
    ].map((name) => [policy + "\\Real-Time Protection", name, 1] as const),
    [policy + "\\Spynet", "SpynetReporting", 0],
    [policy + "\\Spynet", "SubmitSamplesConsent", 2],
  ];
  return [
    {
      shell: "cmd",
      script: `reg.exe add "${policy}\\Exclusions" /v Exclusions_Paths /t REG_DWORD /d 1 /f`,
      allowFailure: false,
    },
    {
      shell: "cmd",
      script: String.raw`reg.exe add "${policy}\Exclusions\Paths" /v "C:\\" /t REG_SZ /d 0 /f`,
      allowFailure: false,
    },
    ...policies.map(([key, name, value]) => ({
      shell: "cmd" as const,
      script: `reg.exe add "${key}" /v ${name} /t REG_DWORD /d ${value} /f`,
      allowFailure: true,
    })),
  ];
}
