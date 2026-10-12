import { z } from "zod";
import { COMMAND_MASK } from "../sim/command.ts";
import { asEntityId, asSeq, asTick } from "../types.ts";
import type { EntityView, InputEntry, Snapshot } from "../types.ts";
import {
  CHAT_MAX,
  CODEC_NAMES,
  MAX_INPUTS_PER_MESSAGE,
  NAME_MAX,
  PROTOCOL_VERSION,
} from "./constants.ts";

/**
 * Protocol v1, one definition for both directions.
 *
 * Every message is described by a zod schema; the TypeScript types are INFERRED
 * from the schemas (`z.output`), so the runtime check and the compile-time type
 * can never drift apart. Types are erased at runtime; these schemas are what
 * actually stops a hostile client from sending `{ type: "input", bits: 1e9 }`.
 */

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
export const ROOM_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

const uint32 = z.number().int().min(0).max(0xffffffff);
const SeqSchema = uint32.transform(asSeq);
const TickSchema = uint32.transform(asTick);
const EntityIdSchema = uint32.transform(asEntityId);
const version = z.literal(PROTOCOL_VERSION);

export const InputEntrySchema = z.object({
  seq: SeqSchema,
  bits: z.number().int().min(0).max(COMMAND_MASK),
});

/** 1..16 inputs whose sequence numbers follow each other without gaps. */
export const InputsSchema = z
  .array(InputEntrySchema)
  .min(1)
  .max(MAX_INPUTS_PER_MESSAGE)
  .refine(
    (inputs) =>
      inputs.every(
        (input, index) =>
          index === 0 || input.seq === (inputs[index - 1]?.seq ?? -2) + 1,
      ),
    "input sequence numbers must be contiguous",
  );

export const NameSchema = z
  .string()
  .refine((value) => !CONTROL_CHARS.test(value), "control characters")
  .transform((value) => value.trim())
  .refine((value) => value.length >= 1 && value.length <= NAME_MAX, "length");

const ChatTextSchema = z
  .string()
  .max(CHAT_MAX)
  .refine((value) => !CONTROL_CHARS.test(value), "control characters")
  .transform((value) => value.trim())
  .refine((value) => value.length > 0, "empty");

export const CodecNameSchema = z.enum(CODEC_NAMES);
export type CodecName = z.output<typeof CodecNameSchema>;

// ---------------------------------------------------------------- client -> server

export const JoinSchema = z.object({
  v: version,
  type: z.literal("join"),
  roomId: z.string().regex(ROOM_ID_PATTERN),
  name: NameSchema,
  codec: CodecNameSchema.default("json"),
});
export const ChatSchema = z.object({
  v: version,
  type: z.literal("chat"),
  text: ChatTextSchema,
});
export const LeaveSchema = z.object({ v: version, type: z.literal("leave") });
export const InputSchema = z.object({
  v: version,
  type: z.literal("input"),
  inputs: InputsSchema,
});

export const ClientMessageSchema = z.discriminatedUnion("type", [
  JoinSchema,
  ChatSchema,
  LeaveSchema,
  InputSchema,
]);
export type ClientMessage = z.output<typeof ClientMessageSchema>;
export type ClientMessageType = ClientMessage["type"];
export const CLIENT_MESSAGE_TYPES = [
  "join",
  "chat",
  "leave",
  "input",
] as const satisfies readonly ClientMessageType[];

/** What a client builds before sending (the version is added by the connection). */
export type ClientMessageInput =
  | { type: "join"; roomId: string; name: string; codec?: CodecName }
  | { type: "chat"; text: string }
  | { type: "leave" }
  | { type: "input"; inputs: readonly InputEntry[] };

// ---------------------------------------------------------------- server -> client

const finite = z.number();
const entityBase = {
  id: EntityIdSchema,
  x: finite,
  y: finite,
  vx: finite,
  vy: finite,
  angle: finite,
};
const bit = z.union([z.literal(0), z.literal(1)]);

export const EntityViewSchema = z.discriminatedUnion("kind", [
  z.object({
    ...entityBase,
    kind: z.literal("ship"),
    hp: finite,
    score: finite,
    flags: z.number().int().min(0).max(31),
  }),
  z.object({
    ...entityBase,
    kind: z.literal("bullet"),
    ownerId: EntityIdSchema,
    fireSeq: SeqSchema,
  }),
  z.object({
    ...entityBase,
    kind: z.literal("asteroid"),
    radius: finite,
    homing: bit,
  }),
  z.object({ ...entityBase, kind: z.literal("pickup"), pickupType: bit }),
]);

export const SnapshotMessageSchema = z.object({
  v: version,
  type: z.literal("snapshot"),
  tick: TickSchema,
  ack: SeqSchema,
  entities: z.array(EntityViewSchema),
});

const PlayerInfoSchema = z.object({ id: z.string(), name: z.string() });
export type PlayerInfo = z.output<typeof PlayerInfoSchema>;
export const RoomInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  players: z.number().int(),
  maxPlayers: z.number().int(),
  arenaId: z.string(),
});
export type RoomInfo = z.output<typeof RoomInfoSchema>;

export const WelcomeSchema = z.object({
  v: version,
  type: z.literal("welcome"),
  playerId: z.string(),
  shipId: EntityIdSchema,
  room: RoomInfoSchema,
  roster: z.array(PlayerInfoSchema),
  codec: CodecNameSchema,
  tickHz: z.number(),
  simHz: z.number(),
  arena: z.object({ width: z.number(), height: z.number() }),
});
const RosterSchema = z.object({
  v: version,
  type: z.literal("roster"),
  roster: z.array(PlayerInfoSchema),
});
const ServerChatSchema = z.object({
  v: version,
  type: z.literal("chat"),
  from: z.string(),
  text: z.string(),
  t: z.number(),
});
const ErrorSchema = z.object({
  v: version,
  type: z.literal("error"),
  code: z.number().int(),
  message: z.string(),
});

export const ServerMessageSchema = z.discriminatedUnion("type", [
  WelcomeSchema,
  RosterSchema,
  ServerChatSchema,
  ErrorSchema,
  SnapshotMessageSchema,
]);
export type ServerMessage = z.output<typeof ServerMessageSchema>;
export type ServerMessageType = ServerMessage["type"];
export type WelcomeMessage = z.output<typeof WelcomeSchema>;
export type SnapshotMessage = z.output<typeof SnapshotMessageSchema>;

/** The message with a given `type`: `MessageOf<ServerMessage, "welcome">` is the welcome shape. */
export type MessageOf<
  M extends { type: string },
  T extends M["type"],
> = Extract<M, { type: T }>;

/** What the server builds before sending (the version is added by `encodeServerMessage`). */
export type ServerMessageInput = {
  [T in ServerMessageType]: Omit<MessageOf<ServerMessage, T>, "v">;
}[ServerMessageType];

// The schema output must be exactly the hand-written wire types: a compile error here means they drifted.
/** Never called: compiling it proves the schema output and the hand-written wire types accept each other. */
export function wireTypesMatch(
  parsedEntity: z.output<typeof EntityViewSchema>,
  wireEntity: EntityView,
  parsedSnapshot: Omit<SnapshotMessage, "v" | "type">,
): [EntityView, z.output<typeof EntityViewSchema>, Snapshot] {
  return [parsedEntity, wireEntity, parsedSnapshot];
}

// ---------------------------------------------------------------- results

export type Result<T, E = string> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

/** Parses untrusted data into a ClientMessage. Never throws. */
export function parseClientMessage(data: unknown): Result<
  ClientMessage,
  "bad_message" | "unknown_type"
> & {
  readonly detail?: string;
} {
  if (data === null || typeof data !== "object" || Array.isArray(data))
    return {
      ok: false,
      error: "bad_message",
      detail: "message must be a JSON object",
    };
  if (!("v" in data) || data.v !== PROTOCOL_VERSION)
    return {
      ok: false,
      error: "bad_message",
      detail: `unsupported protocol version ${"v" in data ? String(data.v) : "undefined"}`,
    };
  const type = "type" in data ? data.type : undefined;
  if (!CLIENT_MESSAGE_TYPES.some((known) => known === type))
    return {
      ok: false,
      error: "unknown_type",
      detail: `unknown message type ${JSON.stringify(type)}`,
    };
  const parsed = ClientMessageSchema.safeParse(data);
  if (parsed.success) return { ok: true, value: parsed.data };
  const issue = parsed.error.issues[0];
  return {
    ok: false,
    error: "bad_message",
    detail: `invalid ${String(type)}: ${issue?.path.join(".") || "message"} (${issue?.message ?? "invalid"})`,
  };
}

/** Parses untrusted data from the server into a ServerMessage. Never throws. */
export function parseServerMessage(data: unknown): Result<ServerMessage> {
  const parsed = ServerMessageSchema.safeParse(data);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    error: parsed.error.issues[0]?.message ?? "invalid server message",
  };
}
