import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

// Settings are ordinary host configuration, not a credential vault.
export const endpointSchema = z
  .string()
  .trim()
  .max(2048)
  .url()
  .refine((value) => {
    if (
      !URL.canParse(value) ||
      Array.from(value).some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      )
    )
      return false;
    const url = new URL(value);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    return (
      (url.protocol === "https:" || (url.protocol === "http:" && loopback)) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  }, "HTTPS 또는 로컬 HTTP 주소를 입력하세요. 인증정보·쿼리·해시는 저장할 수 없습니다.");
export const connectionSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/),
    name: z.string().trim().min(1).max(80),
    url: endpointSchema,
    enabled: z.boolean().default(false),
    providers: z
      .array(z.enum(["codex", "claude"]))
      .min(1)
      .max(2),
  })
  .strict();
export const preferences = defineSettings({
  id: "connections",
  scope: "host",
  version: 1,
  schema: z.object({
    connections: z
      .array(connectionSchema)
      .max(30)
      .default([])
      .refine(
        (items) => new Set(items.map((item) => item.id)).size === items.length,
        "연결 ID는 중복될 수 없습니다.",
      ),
  }),
});
export type Connection = z.output<typeof connectionSchema>;
