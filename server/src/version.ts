import { readFileSync } from "node:fs";
import { z } from "zod";

const Pkg = z.object({ version: z.string() });

/** The version from server/package.json, read once at startup. */
export const VERSION: string = Pkg.parse(
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")),
).version;
