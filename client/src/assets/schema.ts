import { z } from "zod";

/** The asset manifest served at /assets/manifest.json: one definition for the file and its type. */
const Frames = {
  frameWidth: z.number(),
  frameHeight: z.number(),
  frames: z.number(),
};
const SpriteSchema = z.object({ id: z.string(), url: z.string(), ...Frames });
const AudioSchema = z.object({ id: z.string(), url: z.string() });
const JsonAssetSchema = z.object({ id: z.string(), url: z.string() });

export const ManifestSchema = z.object({
  sprites: z.array(SpriteSchema).default([]),
  audio: z.array(AudioSchema).default([]),
  json: z.array(JsonAssetSchema).default([]),
});
export type Manifest = z.output<typeof ManifestSchema>;
export type SpriteAsset = z.output<typeof SpriteSchema>;

/** Optional look of an arena (colors, grid); anything missing falls back to the defaults in draw.ts. */
export const ArenaStyleSchema = z
  .object({
    background: z.string(),
    grid: z.string(),
    gridSize: z.number(),
  })
  .partial();
export type ArenaStyle = z.output<typeof ArenaStyleSchema>;

/** A manifest entry tagged with how it is loaded. */
export type AssetJob =
  | ({ type: "image" } & SpriteAsset)
  | ({ type: "audio" } & z.output<typeof AudioSchema>)
  | ({ type: "json" } & z.output<typeof JsonAssetSchema>);
