import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const googleScopeSchema = z.enum([
  "https://www.googleapis.com/auth/documents.readonly",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/spreadsheets.readonly",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/gmail.readonly",
]);
export type GoogleScope = z.infer<typeof googleScopeSchema>;
export const googleStatusSchema = z.object({
  status: z.enum([
    "setup-required",
    "not-connected",
    "authorizing",
    "exchanging",
    "credentials-stored",
  ]),
  scopes: z.array(googleScopeSchema),
  lastError: z.enum(["authorization-failed"]).optional(),
  reason: z.enum(["oauth-client-missing", "secure-store-unavailable"]).optional(),
});
export type GoogleConnectionStatus = z.infer<typeof googleStatusSchema>;
export const googleStatusRpc = defineRpc({
  name: "google.status",
  input: z.object({}).strict(),
  output: googleStatusSchema,
});
export const googleBeginRpc = defineRpc({
  name: "google.begin",
  input: z.object({ scopes: z.array(googleScopeSchema).min(1).max(5) }).strict(),
  output: z.object({
    authorizationUrl: z
      .string()
      .url()
      .refine((value) => {
        if (!URL.canParse(value)) return false;
        const url = new URL(value);
        return (
          url.protocol === "https:" &&
          url.host === "accounts.google.com" &&
          url.pathname === "/o/oauth2/v2/auth" &&
          !url.username &&
          !url.password &&
          !url.hash
        );
      }),
  }),
});
export const googleCancelRpc = defineRpc({
  name: "google.cancel",
  input: z.object({}).strict(),
  output: z.object({ cancelled: z.boolean() }),
});
export const googleForgetRpc = defineRpc({
  name: "google.forget",
  input: z.object({}).strict(),
  output: z.object({ forgotten: z.boolean() }),
});

export const googleConfigureRpc = defineRpc({
  name: "google.configure",
  input: z
    .object({
      clientId: z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/)
        .max(256),
      clientSecret: z.string().min(1).max(4096).optional(),
    })
    .strict(),
  output: z.object({ configured: z.literal(true) }),
});
