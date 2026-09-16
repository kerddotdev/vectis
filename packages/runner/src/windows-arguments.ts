import { resolve } from "node:path";

export function windowsVmArguments(input: {
  firmwarePath: string;
  cpu: number;
  memoryMiB: number;
}) {
  return [
    "-machine",
    "virt,accel=hvf,gic-version=3",
    "-rtc",
    "base=utc",
    "-cpu",
    "host",
    "-smp",
    String(input.cpu),
    "-m",
    String(input.memoryMiB),
    "-drive",
    `file=${resolve(input.firmwarePath).replaceAll(",", ",,")},if=pflash,format=raw,readonly=on`,
    "-drive",
    "file=uefi-vars.fd,if=pflash,format=raw",
    "-drive",
    "file=disk.qcow2,if=none,id=system,format=qcow2",
    "-device",
    "nvme,drive=system,serial=vectis-system,bootindex=0",
    "-device",
    "ramfb",
    "-device",
    "virtio-gpu-pci",
    "-netdev",
    "user,id=net0,hostfwd=tcp:127.0.0.1:0-:22",
    "-device",
    "virtio-net-pci,netdev=net0,romfile=",
    "-chardev",
    "socket,id=chrtpm,path=tpm.sock",
    "-tpmdev",
    "emulator,id=tpm0,chardev=chrtpm",
    "-device",
    "tpm-tis-device,tpmdev=tpm0",
    "-display",
    "none",
    "-monitor",
    "none",
    "-serial",
    "null",
    "-qmp",
    "stdio",
  ];
}
