import { statfsSync, type StatsFs } from "node:fs";

/** Report the filesystem containing application data, without exposing its path. */
export function storageStatus(
  directory: string,
  probe: (
    path: string,
  ) => Pick<StatsFs, "bsize" | "blocks" | "bavail"> = statfsSync,
) {
  try {
    const { bsize, blocks, bavail } = probe(directory);
    if (
      ![bsize, blocks, bavail].every(Number.isSafeInteger) ||
      bsize <= 0 ||
      blocks <= 0 ||
      bavail > blocks
    )
      throw Error("Invalid filesystem counters");
    const totalBytes = bsize * blocks;
    const availableBytes = bsize * Math.max(0, bavail);
    if (![totalBytes, availableBytes].every(Number.isSafeInteger))
      throw Error("Unsupported filesystem size");
    return {
      available: true,
      totalBytes,
      availableBytes,
      lowSpace: availableBytes < 1024 ** 3 || availableBytes / totalBytes < 0.1,
    };
  } catch {
    return {
      available: false,
      totalBytes: null,
      availableBytes: null,
      lowSpace: null,
    };
  }
}
