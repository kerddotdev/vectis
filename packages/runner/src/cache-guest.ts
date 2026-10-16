import { Schema } from "effect";
import { CacheSizeGiB } from "../../protocol/src/cache-volume.js";
import { VectisError, type Environment } from "../../protocol/src/index.js";

const cacheVariables = {
  RUNNER_TOOL_CACHE: "toolcache",
  npm_config_cache: "npm",
  npm_config_store_dir: "pnpm",
  YARN_CACHE_FOLDER: "yarn",
  PIP_CACHE_DIR: "pip",
  GOMODCACHE: "gomod",
  GOCACHE: "go-build",
};

export function cacheSetupScript(os: Environment["os"], sizeGiB: number) {
  if (!Schema.is(CacheSizeGiB)(sizeGiB))
    throw new VectisError("invalid_cache_size", "Invalid cache disk size.");
  const size = sizeGiB * 1024 ** 3;
  if (os === "windows")
    return `$ErrorActionPreference = 'Stop'
$disks = @(Get-Disk | Where-Object { ([string]$_.SerialNumber).Trim() -ceq 'VECTISCACHE' })
if ($disks.Count -ne 1) { throw 'Cannot uniquely identify the cache disk.' }
$disk = $disks[0]
if ($disk.IsBoot -or $disk.IsSystem -or $disk.Size -ne ${size}) { throw 'Unsafe cache disk identity or size.' }
if ($disk.IsOffline) { $disk | Set-Disk -IsOffline $false }
if ($disk.IsReadOnly) { $disk | Set-Disk -IsReadOnly $false }
if ($disk.PartitionStyle -eq 'RAW') {
  $disk | Initialize-Disk -PartitionStyle GPT -PassThru | New-Partition -UseMaximumSize -AssignDriveLetter | Format-Volume -FileSystem NTFS -NewFileSystemLabel VECTISCACHE -Confirm:$false | Out-Null
}
$volumes = @($disk | Get-Partition | Get-Volume | Where-Object { $_.FileSystemLabel -ceq 'VECTISCACHE' -and $_.FileSystem -eq 'NTFS' })
if ($volumes.Count -ne 1) { throw 'Cache filesystem is missing or ambiguous.' }
if (!$volumes[0].DriveLetter) {
  $partition = $disk | Get-Partition | Where-Object { ($_ | Get-Volume).FileSystemLabel -ceq 'VECTISCACHE' }
  $partition | Add-PartitionAccessPath -AssignDriveLetter
  $volumes = @($partition | Get-Volume)
}
if (!$volumes[0].DriveLetter) { throw 'Cache drive letter is unavailable.' }
$cache = "$($volumes[0].DriveLetter):\\"
${Object.entries(cacheVariables)
  .map(
    ([key, folder]) =>
      `$env:${key} = Join-Path $cache '${folder}'\nNew-Item -ItemType Directory -Path $env:${key} -Force | Out-Null`,
  )
  .join("\n")}
`;
  const mount = os === "linux" ? "/vectis-cache" : "/Volumes/VECTISCACHE";
  const setup =
    os === "linux"
      ? `disk=/dev/disk/by-id/virtio-VECTISCACHE
test -b "$disk"
disk=$(readlink -f "$disk")
test "$(lsblk -dn -o SERIAL "$disk" | tr -d '[:space:]')" = VECTISCACHE
test "$(sudo -n blockdev --getsize64 "$disk")" = ${size}
# Refuse any device containing a mounted filesystem before formatting or mounting it.
test -z "$(lsblk -nr -o MOUNTPOINT "$disk" | tr -d '[:space:]')"
filesystem=$(sudo -n blkid -p -s TYPE -o value "$disk" || true)
if test -z "$filesystem"; then
  test -z "$(sudo -n wipefs --no-act --noheadings --output TYPE "$disk")"
  sudo -n mkfs.ext4 -F -L VECTISCACHE "$disk"
fi
test "$(sudo -n blkid -s TYPE -o value "$disk")" = ext4
test "$(sudo -n blkid -s LABEL -o value "$disk")" = VECTISCACHE
sudo -n mkdir -p ${mount}
sudo -n mount -o nodev,nosuid "$disk" ${mount}
sudo -n chown "$(id -u):$(id -g)" ${mount}`
      : `work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
plist() { /usr/libexec/PlistBuddy -c "Print $2" "$1"; }
diskutil info -plist / > "$work/root"
container=$(plist "$work/root" :APFSContainerReference)
[[ "$container" =~ ^disk[0-9]+$ ]]
diskutil apfs list -plist "$container" > "$work/boot"
boot_store=$(plist "$work/boot" :Containers:0:PhysicalStores:0:DeviceIdentifier)
# Vectis macOS images use one boot physical store. Refuse a layout we cannot prove safe.
if plist "$work/boot" :Containers:0:PhysicalStores:1 >/dev/null 2>&1; then
  printf 'Multiple boot physical stores are unsupported.\\n' >&2; exit 1
fi
diskutil info -plist "$boot_store" > "$work/store"
boot_disk=$(plist "$work/store" :ParentWholeDisk)
[[ "$boot_disk" =~ ^disk[0-9]+$ ]]
diskutil list -plist physical > "$work/disks"
candidate=
index=0
while identifier=$(plist "$work/disks" ":AllDisksAndPartitions:$index:DeviceIdentifier" 2>/dev/null); do
  if test "$identifier" != "$boot_disk"; then
    [[ "$identifier" =~ ^disk[0-9]+$ ]]
    diskutil info -plist "$identifier" > "$work/info"
    test "$(plist "$work/info" :WholeDisk)" = true
    test "$(plist "$work/info" :TotalSize)" = ${size}
    test -z "$candidate"
    candidate=$identifier
  fi
  index=$((index + 1))
done
test -n "$candidate" && test "$candidate" != "$boot_disk"
diskutil list -plist "$candidate" > "$work/cache"
if ! plist "$work/cache" :AllDisksAndPartitions:0:Partitions:0 >/dev/null 2>&1; then
  # Only a blank second physical device may be initialized; never erase an unknown filesystem.
  test -z "$(plist "$work/cache" :AllDisksAndPartitions:0:Content 2>/dev/null || true)"
  sudo -n diskutil eraseDisk APFS VECTISCACHE "$candidate"
fi
# Resolve the named volume back to this physical store, rather than trusting a volume label alone.
diskutil info -plist VECTISCACHE > "$work/volume"
cache_container=$(plist "$work/volume" :APFSContainerReference)
diskutil apfs list -plist "$cache_container" > "$work/apfs"
cache_store=$(plist "$work/apfs" :Containers:0:PhysicalStores:0:DeviceIdentifier)
if plist "$work/apfs" :Containers:0:PhysicalStores:1 >/dev/null 2>&1; then
  printf 'Multiple cache physical stores are unsupported.\\n' >&2; exit 1
fi
diskutil info -plist "$cache_store" > "$work/cache-store"
test "$(plist "$work/cache-store" :ParentWholeDisk)" = "$candidate"
volume=$(plist "$work/volume" :DeviceIdentifier)
sudo -n diskutil mount "$volume"
diskutil info -plist "$volume" > "$work/mounted"
test "$(plist "$work/mounted" :MountPoint)" = ${mount}
test "$(plist "$work/mounted" :VolumeName)" = VECTISCACHE
sudo -n chown "$(id -u):$(id -g)" ${mount}
rm -rf "$work"
trap - EXIT`;
  return `set -eu\n${setup}\n${Object.entries(cacheVariables)
    .map(([key, folder]) => `export ${key}='${mount}/${folder}'\nmkdir -p "$${key}"`)
    .join("\n")}\n`;
}

export function cacheUnmountScript(os: Environment["os"]) {
  if (os === "windows")
    return `$ErrorActionPreference = 'Stop'
$disks = @(Get-Disk | Where-Object { ([string]$_.SerialNumber).Trim() -ceq 'VECTISCACHE' })
if ($disks.Count -ne 1 -or $disks[0].IsBoot -or $disks[0].IsSystem) { throw 'Unsafe cache disk identity.' }
$disks[0] | Set-Disk -IsOffline $true
`;
  if (os === "macos") return "set -eu\nsync\nsudo -n diskutil unmount /Volumes/VECTISCACHE\n";
  return "set -eu\nsync\nsudo -n umount /vectis-cache\n";
}
