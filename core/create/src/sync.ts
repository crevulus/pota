import { extname, basename, join, dirname } from "path";
import { promises as fs } from "fs";

import { copy } from "fs-extra"
import type { ProjectPotaConfig, SkeletonPotaConfig } from "@pota/shared/config";
import { readPackageJson, writePackageJson } from "@pota/shared/fs";
import { PACKAGE_JSON_FILE } from "@pota/shared/config";

import { getNestedSkeletons } from "@pota/shared/skeleton";

import { spawn } from "./helpers.js";
import * as object from "./object.js";


const { unlink } = fs;

type PotaOperationFn = (cwd: string, sourcePath: string, targetPath: string) => Promise<void>;

export const enum POTA_EXTENSION {
  DELETE = ".del",
  MODIFY = ".mod",
}

const POTA_OPERATIONS: Record<POTA_EXTENSION, PotaOperationFn> = {
  async [POTA_EXTENSION.DELETE](_, __, targetPath) {
    await unlink(targetPath)
  },
  async [POTA_EXTENSION.MODIFY](cwd, sourcePath, targetPath) {
    try {
      await spawn(`npx`, `--prefix=${cwd}`, `jscodeshift`, `--verbose=2`, `--extensions=js,cjs,mjs`, `--transform=${sourcePath}`, targetPath)
    } catch (error) {
      console.log("jscodeshift: ", error)
    }
  }
}

function applyPotaExtension(ext: POTA_EXTENSION, ...params: Parameters<PotaOperationFn>) {
  return POTA_OPERATIONS[ext](...params);
}

const POTA_EXTENSIONS = [POTA_EXTENSION.DELETE, POTA_EXTENSION.MODIFY];

// TODO: add test
function parsePotaFile(path: string): [base: string, ext: string, potaExt?: POTA_EXTENSION] {
  const ext = extname(path); // get file extension
  const base = basename(path, ext); // get file name, without the extension

  if (POTA_EXTENSIONS.some(e => base.endsWith(e))) {
    const potaExt = extname(base) as POTA_EXTENSION; // get the pota extension

    return [basename(base, potaExt), ext, potaExt]
  }

  return [base, ext, undefined];
}

async function createPackageJsonSyncer(targetPath: string) {
  let projectPackageJson = await readPackageJson(targetPath);

  return {
    apply(config: SkeletonPotaConfig) {
      // TODO: inject dependency versions from the skeleton package.json
      projectPackageJson = object.merge(projectPackageJson, config[PACKAGE_JSON_FILE]!);
    },
    setSkeleton(skeleton: string) {
      projectPackageJson.pota ??= {};
      (projectPackageJson.pota as ProjectPotaConfig).default = skeleton;
    },
    commit() {
      return writePackageJson(projectPackageJson, targetPath);
    }
  }
}

function createFileSyncer(targetPath: string) {
  // key is the base path (not extensions), value is the full path (with extensions)
  const copied: Record<string, string> = {};

  return async (file: string, skeletonPath: string) => {
    const [base, , potaExt] = parsePotaFile(file);

    const basepath = join(dirname(file), base); // file path without any extensions
    const newpath = join(targetPath, file);
    const sourcepath = join(skeletonPath, file);

    // TODO: add logging
    if (potaExt && basepath in copied) {
      return applyPotaExtension(potaExt, targetPath, sourcepath, copied[basepath]);
    }

    await copy(sourcepath, newpath);

    copied[basepath] = newpath;
  }
}

export default async function sync(targetPath: string, skeleton: string) {
  const syncFile = createFileSyncer(targetPath);
  const packageJsonSyncer = await createPackageJsonSyncer(targetPath);

  for (const { path, config, files } of await getNestedSkeletons(targetPath, skeleton)) {
    for (const file of files) {
      switch (file) {
        case PACKAGE_JSON_FILE: {
          if (PACKAGE_JSON_FILE in config) packageJsonSyncer.apply(config)
          break;
        }
        default: await syncFile(file, path);
      }
    }
  }

  // TODO: inject commands for `@pota/cli`

  packageJsonSyncer.setSkeleton(skeleton);

  await packageJsonSyncer.commit();
}
