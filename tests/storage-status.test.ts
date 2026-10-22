import { it, expect } from "vitest";
import { tmpdir } from "node:os";
import { storageStatus } from "../packages/control/dist/storage-status.js";

it("warns about low usable capacity using both the absolute and relative thresholds", () => {
  const capacity = (totalGiB: number, freeGiB: number) =>
    storageStatus("fixture", () => ({
      bsize: 1024,
      blocks: totalGiB * 1024 ** 2,
      bavail: freeGiB * 1024 ** 2,
    }));
  expect(capacity(100, 2)).toMatchObject({ available: true, lowSpace: true });
  expect(capacity(2, 0.75)).toMatchObject({ available: true, lowSpace: true });
  expect(capacity(100, 10)).toMatchObject({ available: true, lowSpace: false });
  expect(capacity(2, 1)).toMatchObject({ available: true, lowSpace: false });
  expect(capacity(100, 25)).toMatchObject({ available: true, lowSpace: false });
  expect(capacity(100, -1)).toMatchObject({
    availableBytes: 0,
    lowSpace: true,
  });
  expect(storageStatus(tmpdir()).available).toBe(true);
});
it("reports measurement failures without paths, exceptions or fabricated free space", () => {
  const failed = storageStatus("private-data-path", () => {
    throw Error("private storage details");
  });
  expect(failed).toEqual({
    available: false,
    totalBytes: null,
    availableBytes: null,
    lowSpace: null,
  });
  for (const counters of [
    { bsize: 0, blocks: 1, bavail: 1 },
    { bsize: 4096, blocks: 1, bavail: 2 },
    { bsize: 4096, blocks: NaN, bavail: 0 },
    { bsize: 4096, blocks: Number.MAX_SAFE_INTEGER, bavail: 1 },
  ])
    expect(storageStatus("fixture", () => counters).available).toBe(false);
});
