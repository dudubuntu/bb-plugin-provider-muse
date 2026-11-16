import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { MUSE_PROVIDER_ID } from "./vocabulary.js";

const accountKeySchema = z
  .string()
  .min(1)
  .nullable()
  .default(null)
  .describe(
    "Provider-issued quota account identity, namespaced by issuer and account/organization scope. Never use email, a display label, a source-local ID, or credentials. Null means unknown; unknown accounts must not be merged."
  );

const resourceSchema = z.object({
  accountKey: accountKeySchema,
  id: z.string().min(1).describe("Stable resource ID within this source plugin."),
  providerId: z.string().min(1),
  label: z.string().min(1),
  scope: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("shared") }),
    z.object({
      kind: z.literal("host"),
      hostId: z.string().min(1),
      hostName: z.string().min(1),
    }),
  ]),
});

const listResourcesOutputSchema = z.object({
  label: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Declares a shared group even when empty. Host-only sources omit it; machine groups use host names."
    ),
  resources: z.array(resourceSchema),
});

const planSchema = z.object({
  id: z.string().min(1),
  multiplier: z.number().int().positive().nullable(),
});

const windowSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  usedPercent: z.number().min(0).max(100),
  resetsAt: z.string().nullable().optional(),
  cost: z.number().nullable().optional(),
  kind: z.enum(["five-hour", "daily", "weekly", "custom"]).default("custom"),
  model: z.string().nullable().optional(),
});

const usageStatusSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    plan: planSchema.nullable().default(null),
    accountEmail: z.string().nullable().default(null),
    planLabel: z.string().nullable().default(null),
    windows: z.array(windowSchema),
  }),
  z.object({
    status: z.literal("not_installed"),
    accountEmail: z.string().nullable().default(null),
    planLabel: z.string().nullable().default(null),
    plan: z.null().default(null),
  }),
  z.object({
    status: z.literal("unauthenticated"),
    accountEmail: z.string().nullable().default(null),
    planLabel: z.string().nullable().default(null),
    plan: z.null().default(null),
  }),
  z.object({
    status: z.literal("expired"),
    accountEmail: z.string().nullable().default(null),
    planLabel: z.string().nullable().default(null),
    plan: z.null().default(null),
  }),
  z.object({
    status: z.literal("error"),
    message: z.string(),
    accountEmail: z.string().nullable().default(null),
    planLabel: z.string().nullable().default(null),
    plan: z.null().default(null),
  }),
]);

const getResourceOutputSchema = z.object({
  accountKey: accountKeySchema,
  observedAt: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .describe("Last successful measurement time in epoch milliseconds; null if never observed."),
  usage: usageStatusSchema,
});

export const museUsageSourceRpcContract = defineRpcContract({
  "provider-usage.v1.listResources": {
    input: z.object({}),
    output: listResourcesOutputSchema,
    experimental_description:
      "Cheap complete inventory of resources owned by this source. Reads local metadata only; never refreshes quota or contacts providers. IDs are stable and source-local. Resource order is display order. Shared label preserves empty groups. Resources may disappear between list and fetch.",
  },
  "provider-usage.v1.getResource": {
    input: z.object({
      resourceId: z.string().min(1),
      refresh: z
        .boolean()
        .describe(
          "False permits a cached measurement but still returns actual usage. True requests a fresh collection attempt for this resource only."
        ),
    }),
    output: getResourceOutputSchema,
    experimental_description:
      "Returns actual usage for exactly one listed resource, even when refresh is false. False permits cached observations; true requests a fresh attempt. Never collects other resources as a side effect. A removed resource fails the RPC; consumers relist. Per-account authentication and collection failures are usage states. observedAt is the last successful measurement time.",
  },
});

type CachedResource = z.infer<typeof getResourceOutputSchema>;

export function registerMuseUsageSource(bb: BbPluginApi) {
  const cache = new Map<string, CachedResource>();
  const inFlight = new Map<string, { refresh: boolean; promise: Promise<CachedResource> }>();

  const loadResource = async (resourceId: string, refresh: boolean): Promise<CachedResource> => {
    let hostId: string;
    let providerId: string;
    try {
      const parsed = JSON.parse(resourceId);
      if (!Array.isArray(parsed) || parsed.length !== 2) throw new Error("Invalid resourceId");
      [hostId, providerId] = parsed;
    } catch {
      throw new Error("Invalid resourceId format");
    }

    const host = await bb.sdk.hosts.get({ hostId }).catch((err) => {
      if (err instanceof Error && "status" in err && err.status === 404) {
        throw new Error("Usage resource no longer exists.");
      }
      throw err;
    });

    const cached = cache.get(resourceId);
    if (host.status === "disconnected") {
      return getResourceOutputSchema.parse({
        accountKey: cached?.accountKey ?? null,
        observedAt: cached?.observedAt ?? null,
        usage: {
          status: "error",
          accountEmail: null,
          planLabel: null,
          message: "Machine is disconnected.",
        },
      });
    }

    if (!refresh && cached && cached.usage.status === "ok" && cached.observedAt !== null) {
      if (Date.now() - cached.observedAt < 60_000) {
        return cached;
      }
    }

    try {
      const usageMap = (await bb.sdk.system.usageLimits({
        hostId,
        providerId: MUSE_PROVIDER_ID,
        refresh,
      })) as Record<string, any>;

      const raw = usageMap[MUSE_PROVIDER_ID];
      if (!raw) {
        throw new Error("Provider returned no usage information.");
      }

      let parsedUsage: any;
      if (raw.status === "ok") {
        parsedUsage = {
          status: "ok",
          accountEmail: raw.accountEmail ?? null,
          planLabel: raw.planLabel ?? null,
          plan: raw.plan ?? null,
          windows: (raw.windows || []).map((win: any, idx: number) => {
            const labelLower = (win.label || "").toLowerCase();
            let kind: "five-hour" | "weekly" | "custom" = "custom";
            if (labelLower.includes("5-hour") || labelLower.includes("five-hour") || labelLower.includes("session")) {
              kind = "five-hour";
            } else if (labelLower.includes("week")) {
              kind = "weekly";
            }
            return {
              id: `${idx}:${win.label}`,
              label: win.label,
              usedPercent: Math.min(100, Math.max(0, Math.round(win.usedPercent ?? 0))),
              resetsAt: win.resetsAt ?? null,
              cost: win.cost ?? null,
              kind,
              model: win.model ?? null,
            };
          }),
        };
      } else {
        parsedUsage = {
          status: raw.status,
          accountEmail: raw.accountEmail ?? null,
          planLabel: raw.planLabel ?? null,
          plan: null,
          ...(raw.status === "error" ? { message: raw.message || "Usage error" } : {}),
        };
      }

      const result = getResourceOutputSchema.parse({
        accountKey: raw.accountKey ?? null,
        observedAt: raw.status === "ok" ? Date.now() : cached?.observedAt ?? null,
        usage: parsedUsage,
      });

      cache.set(resourceId, result);
      return result;
    } catch (err) {
      return getResourceOutputSchema.parse({
        accountKey: cached?.accountKey ?? null,
        observedAt: cached?.observedAt ?? null,
        usage: {
          status: "error",
          accountEmail: null,
          planLabel: null,
          message: err instanceof Error ? err.message : "Usage could not be collected from this machine.",
        },
      });
    }
  };

  const collect = (resourceId: string, refresh: boolean): Promise<CachedResource> => {
    const existing = inFlight.get(resourceId);
    if (existing) {
      if (!refresh || existing.refresh) return existing.promise;
      return existing.promise.catch(() => {}).then(() => collect(resourceId, refresh));
    }
    const promise = loadResource(resourceId, refresh).finally(() => inFlight.delete(resourceId));
    inFlight.set(resourceId, { refresh, promise });
    return promise;
  };

  bb.rpc.register(
    museUsageSourceRpcContract,
    {
      async ["provider-usage.v1.listResources"]() {
        const hosts = await bb.sdk.hosts.list();
        const resources = (
          await Promise.all(
            hosts.map(async (host) => {
              const providers = await bb.sdk.providers
                .list({ hostId: host.id, capability: "usage" })
                .catch(() => []);
              return providers
                .filter((p) => p.pluginId === "provider-muse" && p.id === MUSE_PROVIDER_ID)
                .map((p) => {
                  const id = JSON.stringify([host.id, p.id]);
                  return {
                    id,
                    accountKey: cache.get(id)?.accountKey ?? null,
                    providerId: p.id,
                    label: p.displayName,
                    scope: { kind: "host" as const, hostId: host.id, hostName: host.name },
                  };
                });
            })
          )
        ).flat();

        const currentKeys = new Set(resources.map((r) => r.id));
        for (const key of cache.keys()) {
          if (!currentKeys.has(key)) cache.delete(key);
        }

        return { resources };
      },
      ["provider-usage.v1.getResource"]: ({ resourceId, refresh }) => {
        return collect(resourceId, refresh);
      },
    },
    {
      experimental_discoverable: true,
      experimental_description:
        "Host-local usage owned by the muse provider plugin. Inventory reads metadata only. Independent of display plugins.",
    }
  );
}
