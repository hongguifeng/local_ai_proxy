import type { FastifyInstance } from "fastify";
import type { ProxyPair } from "../../config/index.js";
import {
  adminResponseSchemas,
  PAIRS_RESPONSE_SCHEMA,
  PAIR_RESPONSE_SCHEMA,
  PATH_ID_PARAMS_SCHEMA,
  REPLACE_PAIRS_REQUEST_SCHEMA,
  SET_PAIR_ENABLED_REQUEST_SCHEMA,
  type AdminSetPairEnabledBody,
} from "../admin-schemas.js";
import type { PairAdminService } from "../admin-contracts.js";

/**
 * Pairs are answered and accepted with every key the configuration object carries: the
 * console reads keys this module does not list and posts the same object back. The schemas
 * say so on purpose — see the open/closed table in
 * `docs/current/contracts/admin-api.md`.
 */
export function registerPairRoutes(server: FastifyInstance, pairService: PairAdminService): void {
  server.get(
    "/api/pairs",
    { schema: { response: adminResponseSchemas(PAIRS_RESPONSE_SCHEMA) } },
    () => ({
      pairs: pairService.listPairs(),
    }),
  );
  const replacePairs = pairService.replacePairs?.bind(pairService);
  if (replacePairs !== undefined) {
    server.put<{ Body: { pairs: ProxyPair[] } }>(
      "/api/pairs",
      {
        schema: {
          body: REPLACE_PAIRS_REQUEST_SCHEMA,
          response: adminResponseSchemas(PAIRS_RESPONSE_SCHEMA),
        },
      },
      async (request) => ({ pairs: await replacePairs(request.body.pairs) }),
    );
  }
  const setPairEnabled = pairService.setPairEnabled?.bind(pairService);
  if (setPairEnabled !== undefined) {
    server.post<{ Body: AdminSetPairEnabledBody; Params: { id: string } }>(
      "/api/pairs/:id/enabled",
      {
        schema: {
          params: PATH_ID_PARAMS_SCHEMA,
          body: SET_PAIR_ENABLED_REQUEST_SCHEMA,
          response: adminResponseSchemas(PAIR_RESPONSE_SCHEMA),
        },
      },
      async (request) => ({
        pair: await setPairEnabled(request.params.id, request.body.enabled),
      }),
    );
  }
}
