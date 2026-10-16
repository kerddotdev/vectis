import { expect, test } from "vitest";
import { windowsDefenderCommands } from "./windows-defender.js";

test("Defender exclusions require both policy writes through cmd without PowerShell cmdlets", () => {
  const commands = windowsDefenderCommands();
  expect(commands.slice(0, 2)).toEqual([
    {
      shell: "cmd",
      script: String.raw`reg.exe add "HKLM\SOFTWARE\Policies\Microsoft\Windows Defender\Exclusions" /v Exclusions_Paths /t REG_DWORD /d 1 /f`,
      allowFailure: false,
    },
    {
      shell: "cmd",
      script: String.raw`reg.exe add "HKLM\SOFTWARE\Policies\Microsoft\Windows Defender\Exclusions\Paths" /v "C:\\" /t REG_SZ /d 0 /f`,
      allowFailure: false,
    },
  ]);
  const policies = commands.slice(2);
  expect(policies).toHaveLength(8);
  for (const command of policies) {
    expect(command).toMatchObject({ shell: "cmd", allowFailure: true });
    expect(command.script).toMatch(
      /^reg.exe add "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows Defender(?:\\[^"\r\n]+)?" \/v \w+ \/t REG_DWORD \/d [012] \/f$/,
    );
  }
  for (const command of commands) {
    expect(command.shell).toBe("cmd");
    expect(command.script).not.toMatch(/powershell|(?:Add|Set|Get)-Mp/);
  }
});
