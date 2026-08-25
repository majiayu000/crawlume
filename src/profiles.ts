import { chmodSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import type { AppConfig } from "./config.js";
import { ReadError } from "./errors.js";

const profilePattern = /^[A-Za-z0-9._-]{1,64}$/;

export class ProfileManager {
  constructor(private readonly config: AppConfig) {
    mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    mkdirSync(config.profilesDir, { recursive: true, mode: 0o700 });
    chmodSync(config.dataDir, 0o700);
    chmodSync(config.profilesDir, 0o700);
  }

  validateName(name: string): string {
    if (!profilePattern.test(name) || name === "." || name === "..") {
      throw new ReadError(
        "INVALID_ARGUMENT",
        "Profile names may contain only letters, numbers, dots, underscores, and hyphens.",
        { details: { profile: name } },
      );
    }
    return name;
  }

  path(name: string): string {
    return join(this.config.profilesDir, this.validateName(name));
  }

  require(name: string): string {
    const path = this.path(name);
    if (!existsSync(path) || !statSync(path).isDirectory()) {
      throw new ReadError("PROFILE_NOT_FOUND", "The requested browser profile does not exist.", {
        details: { profile: name },
      });
    }
    return path;
  }

  create(name: string): string {
    const path = this.path(name);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
    return path;
  }

  list(): string[] {
    return readdirSync(this.config.profilesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && profilePattern.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  }
}
