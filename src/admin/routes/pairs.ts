import type { FastifyInstance } from "fastify";
import type { ProxyPair } from "../../config/index.js";
import {
  PAIRS_RESPONSE_SCHEMA,
  PAIR_RESPONSE_SCHEMA,
  REPLACE_PAIRS_REQUEST_SCHEMA,
  SET_PAIR_ENABLED_REQUEST_SCHEMA,
} from "../admin-schemas.js";
import type { PairAdminService } from "../admin-contracts.js";

export function registerPairRoutes(server: FastifyInstance, pairService: PairAdminService): void {
  server.get("/api/pairs", { schema: { response: { 200: PAIRS_RESPONSE_SCHEMA } } }, () => ({
    pairs: pairService.listPairs(),
  }));
  const replacePairs = pairService.replacePairs?.bind(pairService);
  if (replacePairs !== undefined) {
    server.put<{ Body: { pairs: ProxyPair[] } }>(
      "/api/pairs",
      {
        schema: {
          body: REPLACE_PAIRS_REQUEST_SCHEMA,
          response: { 200: PAIRS_RESPONSE_SCHEMA },
        },
      },
      async (request) => ({ pairs: await replacePairs(request.body.pairs) }),
    );
  }
  const setPairEnabled = pairService.setPairEnabled?.bind(pairService);
  if (setPairEnabled !== undefined) {
    server.post<{ Body: { enabled: boolean }; Params: { id: string } }>(
      "/api/pairs/:id/enabled",
      {
        schema: {
          params: {
            type: "object",
            additionalProperties: false,
            required: ["id"],
            properties: { id: { type: "string", minLength: 1 } },
          },
          body: SET_PAIR_ENABLED_REQUEST_SCHEMA,
          response: { 200: PAIR_RESPONSE_SCHEMA },
        },
      },
      async (request) => ({
        pair: await setPairEnabled(request.params.id, request.body.enabled),
      }),
    );
  }
}
