import {
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
} from "node:fs";
import { VectisError } from "../../../packages/protocol/src/index.js";

export function privateFile(path: string, create = false) {
  let descriptor;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK |
        (create ? constants.O_CREAT : 0),
      0o600,
    );
  } catch (error) {
    if (!create && error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  try {
    const file = fstatSync(descriptor);
    if (!file.isFile() || (process.getuid && file.uid !== process.getuid()))
      throw new VectisError(
        "unsafe_home",
        "Service files must be regular files owned by the current user.",
      );
    fchmodSync(descriptor, 0o600);
  } finally {
    closeSync(descriptor);
  }
}

export function privateHome(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const directory = lstatSync(path);
  if (!directory.isDirectory() || (process.getuid && directory.uid !== process.getuid()))
    throw new VectisError(
      "unsafe_home",
      "The service home must be a directory owned by the current user, without a symbolic link.",
    );
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    if (opened.dev !== directory.dev || opened.ino !== directory.ino)
      throw new VectisError("unsafe_home", "The service home changed during validation.");
    fchmodSync(descriptor, 0o700);
  } finally {
    closeSync(descriptor);
  }
}
